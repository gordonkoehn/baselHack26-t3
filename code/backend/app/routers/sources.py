import io

from fastapi import APIRouter, HTTPException, Request
from pypdf import PdfReader
from pypdf.errors import PyPdfError

from app import extract
from app.contracts import ExtractedText

router = APIRouter(prefix="/api/sources", tags=["sources"])

MAX_BYTES = 10 * 1024 * 1024
MAX_PAGES = 100
# Roughly 50 dense pages; more would not fit one extraction prompt anyway.
MAX_CHARS = 200_000


@router.post("/pdf", response_model_by_alias=True)
async def extract_pdf(request: Request) -> ExtractedText:
    """Pull the text layer out of a PDF so it can be sent (and quoted verbatim) as a source.

    The body is the raw file, not multipart: the browser posts the File as-is.
    """
    body = await request.body()
    if len(body) > MAX_BYTES:
        raise HTTPException(413, "PDF larger than 10 MB")
    if not body.startswith(b"%PDF"):
        raise HTTPException(422, "not a PDF file")
    try:
        reader = PdfReader(io.BytesIO(body))
        if reader.is_encrypted:
            raise HTTPException(422, "PDF is password protected")
        if len(reader.pages) > MAX_PAGES:
            raise HTTPException(413, f"PDF has more than {MAX_PAGES} pages")
        pages = [page.extract_text() or "" for page in reader.pages]
    # NotImplementedError: pypdf meets a stream filter it doesn't support.
    except (PyPdfError, ValueError, KeyError, TypeError, NotImplementedError) as exc:
        raise HTTPException(422, f"PDF could not be read ({type(exc).__name__})") from None
    text = "\n\n".join(p.strip() for p in pages if p.strip())
    if not text:
        raise HTTPException(
            422, "PDF has no text layer (scanned or image-only); OCR is not supported"
        )
    if len(text) > MAX_CHARS:
        # Refuse instead of truncating: a cut-off source would look complete in the UI.
        raise HTTPException(413, f"PDF text is longer than {MAX_CHARS:,} characters")
    return ExtractedText(text=text, pages=len(reader.pages))


def _image_type(body: bytes) -> str | None:
    """Sniff the image format from its first bytes; the browser's Content-Type is not trusted."""
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if body.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "image/webp"
    if body[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


@router.post("/image", response_model_by_alias=True)
async def extract_image(request: Request) -> ExtractedText:
    """Transcribe the text in an image (board screenshot, photo of sticky notes) into a source.

    The body is the raw file. Quotes are later checked against this transcription, like a PDF's
    text layer, so the transcription is the source of truth for evidence from this image.
    """
    body = await request.body()
    if len(body) > MAX_BYTES:
        raise HTTPException(413, "image larger than 10 MB")
    mime = _image_type(body)
    if mime is None:
        raise HTTPException(422, "not a PNG, JPEG, WebP or GIF image")
    try:
        text = extract.transcribe_image(body, mime)
    except extract.ProviderUnavailable:
        raise HTTPException(503, "image provider unavailable") from None
    except extract.ExtractionFailed as exc:
        raise HTTPException(502, f"image could not be transcribed: {exc}") from None
    if not text:
        raise HTTPException(422, "image has no readable text")
    if len(text) > MAX_CHARS:
        raise HTTPException(413, f"image text is longer than {MAX_CHARS:,} characters")
    return ExtractedText(text=text, pages=1)
