import base64
import io
import json

import httpx
import openai
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from app import extract
from app.main import app

client = TestClient(app)
FAILED = {"detail": "file could not be transcribed: transcription failed"}


@pytest.fixture(params=["image", "pdf"])
def source(request):
    if request.param == "image":
        return "/api/sources/image", b"\x89PNG\r\n\x1a\n" + b"\0" * 32, "image/png"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    buffer = io.BytesIO()
    writer.write(buffer)
    return "/api/sources/pdf", buffer.getvalue(), "application/pdf"


@pytest.fixture
def response_body():
    return {
        "id": "resp_test",
        "object": "response",
        "created_at": 0,
        "model": "gpt-test",
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "instructions": None,
        "metadata": {},
        "parallel_tool_calls": False,
        "temperature": 1.0,
        "tools": [],
        "tool_choice": "auto",
        "top_p": 1.0,
        "output": [
            {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {"type": "output_text", "text": "  Private source text.\n", "annotations": []}
                ],
            }
        ],
    }


@pytest.fixture
def mock_provider(monkeypatch):
    clients = []

    def use(body, status_code=200):
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(status_code, json=body)

        sdk = openai.OpenAI(
            api_key="test-key",
            base_url="https://provider.invalid/v1",
            max_retries=0,
            http_client=httpx.Client(transport=httpx.MockTransport(respond), trust_env=False),
        )
        clients.append(sdk)
        monkeypatch.setattr(extract, "_client", lambda: sdk)
        return requests

    yield use
    for sdk in clients:
        sdk.close()


@pytest.mark.parametrize(
    "changes",
    [
        pytest.param(
            {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}},
            id="max-output-tokens-partial",
        ),
        pytest.param(
            {"status": "incomplete", "incomplete_details": {"reason": "content_filter"}},
            id="content-filter-partial",
        ),
        pytest.param({"status": "failed"}, id="failed"),
        pytest.param({"status": "cancelled"}, id="cancelled"),
        pytest.param({"status": "in_progress"}, id="in-progress"),
        pytest.param({"status": "queued"}, id="queued"),
        pytest.param({"status": None}, id="missing-status"),
        pytest.param(
            {"error": {"code": "server_error", "message": "Private provider diagnostic."}},
            id="completed-with-error",
        ),
        pytest.param(
            {
                "status": "failed",
                "error": {"code": "server_error", "message": "Private provider diagnostic."},
            },
            id="failed-with-error",
        ),
    ],
)
def test_rejects_unusable_response(source, response_body, mock_provider, changes):
    response_body.update(changes)
    requests = mock_provider(response_body)
    path, data, mime = source
    result = client.post(path, content=data, headers={"Content-Type": mime})
    assert result.status_code == 502
    assert result.json() == FAILED
    assert len(requests) == 1


@pytest.mark.parametrize("placement", ["only", "same-message", "later-message"])
def test_rejects_refusal_blocks(source, response_body, mock_provider, placement):
    message = response_body["output"][0]
    refusal = {"type": "refusal", "refusal": "Private refusal and source details."}
    if placement == "only":
        message["content"] = [refusal]
    elif placement == "same-message":
        message["content"].append(refusal)
    else:
        response_body["output"].append({**message, "id": "msg_refusal", "content": [refusal]})
    mock_provider(response_body)
    path, data, mime = source
    result = client.post(path, content=data, headers={"Content-Type": mime})
    assert result.status_code == 502
    assert result.json() == FAILED


def test_completed_text_preserves_request_shape(source, response_body, mock_provider):
    requests = mock_provider(response_body)
    path, data, mime = source
    result = client.post(path, content=data, headers={"Content-Type": mime})
    assert result.status_code == 200
    assert result.json() == {"text": "Private source text.", "pages": 1}
    assert len(requests) == 1
    assert requests[0].url.path == "/v1/responses"
    sent = json.loads(requests[0].content)
    url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
    part = (
        {"type": "input_file", "filename": "scan.pdf", "file_data": url}
        if mime == "application/pdf"
        else {"type": "input_image", "image_url": url}
    )
    assert sent["input"] == [{"role": "user", "content": [part]}]
    assert sent["instructions"] == extract.TRANSCRIBE


@pytest.mark.parametrize("text", ["", " \n\t ", None], ids=["empty", "whitespace", "no-output"])
def test_completed_empty_is_no_readable_text(source, response_body, mock_provider, text):
    if text is None:
        response_body["output"] = []
    else:
        response_body["output"][0]["content"][0]["text"] = text
    mock_provider(response_body)
    path, data, mime = source
    result = client.post(path, content=data, headers={"Content-Type": mime})
    assert result.status_code == 422
    kind = "PDF" if mime == "application/pdf" else "image"
    assert result.json() == {"detail": f"{kind} has no readable text"}


@pytest.mark.parametrize(
    ("http_status", "expected"), [(400, 502), (422, 502), (401, 503), (429, 503), (500, 503)]
)
def test_provider_http_errors_stay_sanitized(source, mock_provider, http_status, expected):
    mock_provider(
        {"error": {"message": "Private provider diagnostic.", "type": "server_error"}},
        http_status,
    )
    path, data, mime = source
    result = client.post(path, content=data, headers={"Content-Type": mime})
    assert result.status_code == expected
    assert "Private" not in result.text
    if expected == 503:
        assert result.json() == {"detail": "transcription provider unavailable"}
