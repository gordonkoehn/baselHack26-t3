"""MCP server for persona data entry (#163): an assistant hands over sprint material, gets a persona.

Streamable HTTP, stateless: every POST is one JSON-RPC message answered with plain JSON, no
sessions and no event stream, so it fits Vercel serverless. The tools only wrap the existing
routes, with the same passcode and rate limits. The spec version and transport are from
https://modelcontextprotocol.io/specification/2025-06-18/basic/transports.
"""

import base64
import binascii
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ValidationError

from app.auth import require_passcode
from app.contracts import ExtractedText, PersonaCreate, PersonaUpdate
from app.rate_limit import rate_limit
from app.routers import personas
from app.routers.personas import ExtractorDep, ProberDep, StoreDep
from app.routers.sources import MAX_BYTES, read_image, read_pdf

router = APIRouter(prefix="/api/mcp", tags=["mcp"])

PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26")
SERVER_INFO = {"name": "opentwin", "version": "0.1.0"}

PERSONA_ID = {"type": "string", "description": "Persona id from create_persona, e.g. p_1a2b3c."}

TOOLS = [
    {
        "name": "add_source",
        "description": (
            "Turn one piece of sprint material into source text for create_persona. Pass `text` "
            "for notes or transcripts (returned as is), or `data` with a base64 PDF, PNG, JPEG, "
            "WebP or GIF (max 10 MB); scans and images are transcribed. Quotes in the persona are "
            "later checked against exactly this text."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "data": {"type": "string", "description": "Base64 file content."},
            },
        },
    },
    {
        "name": "create_persona",
        "description": (
            "Build a test persona from sources (use add_source first for files). Takes about a "
            "minute. Returns the persona with its readiness score; it then shows up in the "
            "OpenTwin persona library like an uploaded one."
        ),
        "inputSchema": PersonaCreate.model_json_schema(by_alias=True),
    },
    {
        "name": "get_persona",
        "description": "Read one persona with its facts, evidence and readiness.",
        "inputSchema": {
            "type": "object",
            "properties": {"personaId": PERSONA_ID},
            "required": ["personaId"],
        },
    },
    {
        "name": "update_persona",
        "description": (
            "Change a persona: send only the fields to change in `changes`. Lists of facts replace "
            "the old list, so leave a fact out to remove it. An edited fact loses its source and "
            "becomes a guess. The readiness score is cleared after an edit."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "personaId": PERSONA_ID,
                "changes": PersonaUpdate.model_json_schema(by_alias=True),
            },
            "required": ["personaId", "changes"],
        },
    },
]


class ToolError(Exception):
    """A tool ran but failed; the assistant sees the message, the call itself succeeded."""


def _add_source(args: dict, request: Request, store: StoreDep) -> ExtractedText:
    text, data = args.get("text"), args.get("data")
    if (text is None) == (data is None):
        raise ToolError("pass either text or data, not both")
    if text is not None:
        if not isinstance(text, str) or not text.strip():
            raise ToolError("text is empty")
        return ExtractedText(text=text, pages=1)
    if not isinstance(data, str) or len(data) > MAX_BYTES * 4 // 3 + 4:
        raise ToolError("data must be a base64 string of at most 10 MB")
    try:
        body = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise ToolError("data is not valid base64") from None
    rate_limit("sources")(request, store)
    return read_pdf(body) if body.startswith(b"%PDF") else read_image(body)


def _call(
    name: str,
    args: dict,
    request: Request,
    store: StoreDep,
    extractor: ExtractorDep,
    prober: ProberDep,
) -> BaseModel:
    if name == "add_source":
        return _add_source(args, request, store)
    if name == "create_persona":
        body = PersonaCreate.model_validate(args)
        rate_limit("personas")(request, store)
        return personas.create_persona(body, store, extractor, prober)
    if name == "get_persona":
        return personas.read_persona(str(args.get("personaId", "")), store)
    if name == "update_persona":
        body = PersonaUpdate.model_validate(args.get("changes") or {})
        return personas.update_persona(str(args.get("personaId", "")), body, store)
    raise KeyError(name)


def _result(id_: Any, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def _error(id_: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


@router.get("")
def no_stream() -> Response:
    # Stateless: the server never pushes, so there is no event stream to open.
    return Response(status_code=405, headers={"Allow": "POST"})


@router.post("", dependencies=[Depends(require_passcode)], response_model=None)
def handle(
    message: Annotated[Any, Body()],
    request: Request,
    store: StoreDep,
    extractor: ExtractorDep,
    prober: ProberDep,
) -> dict | Response:
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return _error(None, -32600, "expected one JSON-RPC 2.0 message")
    method, id_ = message.get("method"), message.get("id")
    params = message.get("params") or {}
    if "id" not in message:
        # Notifications (initialized, cancelled) and stray responses need no answer.
        return Response(status_code=202)

    if method == "initialize":
        asked = params.get("protocolVersion")
        return _result(
            id_,
            {
                "protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[1],
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        )
    if method == "ping":
        return _result(id_, {})
    if method == "tools/list":
        return _result(id_, {"tools": TOOLS})
    if method != "tools/call":
        return _error(id_, -32601, f"method not found: {method}")

    name, args = params.get("name"), params.get("arguments") or {}
    if not isinstance(args, dict):
        return _error(id_, -32602, "arguments must be an object")
    try:
        output = _call(name, args, request, store, extractor, prober)
    except KeyError:
        return _error(id_, -32602, f"unknown tool: {name}")
    except ValidationError as exc:
        return _tool_error(id_, f"invalid arguments: {exc.errors(include_url=False)}")
    except ToolError as exc:
        return _tool_error(id_, str(exc))
    except HTTPException as exc:
        if exc.status_code == 429:
            raise  # same Retry-After answer as the routes
        return _tool_error(id_, f"{exc.status_code}: {exc.detail}")
    data = output.model_dump(by_alias=True, mode="json")
    return _result(
        id_,
        {
            "content": [{"type": "text", "text": output.model_dump_json(by_alias=True)}],
            "structuredContent": data,
            "isError": False,
        },
    )


def _tool_error(id_: Any, text: str) -> dict:
    return _result(id_, {"content": [{"type": "text", "text": text}], "isError": True})
