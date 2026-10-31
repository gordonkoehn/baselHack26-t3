"""MCP server for persona data entry (#163): an assistant hands over sprint material, gets a persona.

Streamable HTTP, stateless: every POST is one JSON-RPC message answered with plain JSON, no
sessions and no event stream, so it fits Vercel serverless. The tools only wrap the existing
routes, with the same passcode and rate limits. The spec version and transport are from
https://modelcontextprotocol.io/specification/2025-06-18/basic/transports.
"""

import base64
import binascii
import hashlib
import io
import re
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from PIL import Image
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

PERSONA_ID_FORM = r"^p_[A-Za-z0-9_-]{1,64}$"
PERSONA_ID = {
    "type": "string",
    "pattern": PERSONA_ID_FORM,
    "description": "Persona id from create_persona, e.g. p_1a2b3c.",
}

# The $defs go to the root of the tool schema, where the $refs ("#/$defs/Fact") point.
CHANGES = PersonaUpdate.model_json_schema(by_alias=True)
CHANGES_DEFS = CHANGES.pop("$defs", {})
CHANGES |= {"additionalProperties": False, "minProperties": 1}

TOOLS = [
    {
        "name": "add_source",
        "description": (
            "Turn one piece of sprint material into source text for create_persona. Pass `text` "
            "for notes or transcripts (returned as is), or `data` with a base64 PDF, PNG, JPEG, "
            "WebP or GIF (about 3 MB at most: the request limit counts the base64); scans and "
            "images are transcribed. Quotes in the persona are later checked "
            "against exactly this text."
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
            "Build a test persona from sources (use add_source first for files). Takes up to two "
            "minutes; calling again with the same arguments returns the same persona instead of "
            "building a second one. Returns the persona with its readiness score; it then shows up in the "
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
            "additionalProperties": False,
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
                "changes": CHANGES,
            },
            "required": ["personaId", "changes"],
            "additionalProperties": False,
            "$defs": CHANGES_DEFS,
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
    return read_pdf(body) if body.startswith(b"%PDF") else read_image(_on_white(body))


def _on_white(body: bytes) -> bytes:
    """The upload page's onWhite: a transparent image reads as black on black, so flatten it."""
    try:
        with Image.open(io.BytesIO(body)) as image:
            image.thumbnail((2048, 2048))
            rgba = image.convert("RGBA")
    except (OSError, ValueError, Image.DecompressionBombError):
        return body  # not an image Pillow reads: read_image refuses or sends it as it is
    flat = Image.new("RGB", rgba.size, "white")
    flat.paste(rgba, mask=rgba.getchannel("A"))
    out = io.BytesIO()
    flat.save(out, "JPEG", quality=92)
    return out.getvalue()


def _create_once(
    body: PersonaCreate,
    request: Request,
    store: StoreDep,
    extractor: ExtractorDep,
    prober: ProberDep,
) -> BaseModel:
    # A client that gives up before the persona is built and retries must not pay for a second one.
    digest = hashlib.sha256(body.model_dump_json(by_alias=True).encode()).hexdigest()
    earlier = store.claim_creation(digest)
    if earlier and earlier != "pending" and store.get_persona(earlier) is None:
        # The earlier persona was deleted since: this is a fresh request, not a retry.
        store.finish_creation(digest, None)
        earlier = store.claim_creation(digest)
    if earlier == "pending":
        raise ToolError(
            "this persona is still being built; call create_persona again with the same "
            "arguments in a minute to get it"
        )
    if earlier:
        return personas.read_persona(earlier, store)
    try:
        rate_limit("personas")(request, store)
        persona = personas.create_persona(body, store, extractor, prober)
    except BaseException:
        store.finish_creation(digest, None)
        raise
    store.finish_creation(digest, persona.id)
    return persona


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
        return _create_once(_parse(PersonaCreate, args), request, store, extractor, prober)
    if name == "get_persona":
        return personas.read_persona(_persona_id(args, {"personaId"}), store)
    if name == "update_persona":
        persona_id = _persona_id(args, {"personaId", "changes"})
        changes = args.get("changes")
        if not isinstance(changes, dict) or not changes:
            raise ToolError("changes must be an object with at least one field to change")
        body = _parse(PersonaUpdate, changes)
        if len(body.model_fields_set) != len(changes):
            raise ToolError("changes has unknown or repeated fields, see the tool's inputSchema")
        return personas.update_persona(persona_id, body, store)
    raise ToolError(f"unknown tool: {name}")


def _parse[M: BaseModel](model: type[M], data: object) -> M:
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        # Without the inputs: the reason is enough, and inputs could carry stored data back out.
        reasons = exc.errors(include_url=False, include_input=False)
        raise ToolError(f"invalid arguments: {reasons}") from None


def _persona_id(args: dict, allowed: set[str]) -> str:
    if unknown := set(args) - allowed:
        raise ToolError(f"unknown arguments: {sorted(unknown)}")
    persona_id = args.get("personaId")
    # The id ends up in a store key, so ":sources" and the like must never get through.
    if not isinstance(persona_id, str) or not re.fullmatch(PERSONA_ID_FORM, persona_id):
        raise ToolError("personaId must be an id from create_persona, e.g. p_1a2b3c")
    return persona_id


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
    if not isinstance(params, dict):
        return _error(id_, -32602, "params must be an object")

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
    if name not in [tool["name"] for tool in TOOLS]:
        return _error(id_, -32602, f"unknown tool: {name}")
    try:
        output = _call(name, args, request, store, extractor, prober)
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
