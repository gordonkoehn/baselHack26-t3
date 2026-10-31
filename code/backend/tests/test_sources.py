import io

from fastapi.testclient import TestClient
from pypdf import PdfWriter

from app.main import app
from app.routers import sources
from app.routers.sources import MAX_BYTES

client = TestClient(app)
PDF = {"Content-Type": "application/pdf"}


def make_pdf(text: str, stream_filter: str | None = None) -> bytes:
    """A minimal one-page PDF with a real text layer, built by hand so tests need no PDF library."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R"
            b" /Resources << /Font << /F1 5 0 R >> >> >>"
        ),
        (b"<< /Length %d" % len(stream))
        + (f" /Filter /{stream_filter}".encode() if stream_filter else b"")
        + b" >>\nstream\n"
        + stream
        + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = b"%PDF-1.4\n", []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return out


def test_extracts_text_layer():
    res = client.post(
        "/api/sources/pdf", content=make_pdf("I want to see the money arrive."), headers=PDF
    )
    assert res.status_code == 200
    assert res.json() == {"text": "I want to see the money arrive.", "pages": 1}


def test_not_a_pdf_is_422():
    assert client.post("/api/sources/pdf", content=b"hello", headers=PDF).status_code == 422


def test_broken_pdf_is_422_not_500():
    assert (
        client.post("/api/sources/pdf", content=b"%PDF-1.4 garbage", headers=PDF).status_code == 422
    )


def test_pdf_without_text_is_422():
    res = client.post("/api/sources/pdf", content=make_pdf(""), headers=PDF)
    assert res.status_code == 422 and "no text" in res.json()["detail"]


def test_too_large_is_413():
    body = b"%PDF" + b"0" * MAX_BYTES
    assert client.post("/api/sources/pdf", content=body, headers=PDF).status_code == 413


def test_password_protected_is_422():
    writer = PdfWriter(clone_from=io.BytesIO(make_pdf("secret")))
    writer.encrypt("pw", algorithm="RC4-128")
    buf = io.BytesIO()
    writer.write(buf)
    res = client.post("/api/sources/pdf", content=buf.getvalue(), headers=PDF)
    assert res.status_code == 422 and "password" in res.json()["detail"]


def test_too_many_pages_is_413(monkeypatch):
    monkeypatch.setattr(sources, "MAX_PAGES", 0)
    res = client.post("/api/sources/pdf", content=make_pdf("x"), headers=PDF)
    assert res.status_code == 413 and "pages" in res.json()["detail"]


def test_too_much_text_is_413_not_truncated(monkeypatch):
    monkeypatch.setattr(sources, "MAX_CHARS", 5)
    res = client.post("/api/sources/pdf", content=make_pdf("longer than five"), headers=PDF)
    assert res.status_code == 413 and "text" not in res.json()


def test_unsupported_stream_filter_is_422_json():
    res = client.post(
        "/api/sources/pdf", content=make_pdf("x", "ReviewUnsupportedFilter"), headers=PDF
    )
    assert res.status_code == 422 and res.headers["content-type"] == "application/json"
