import io

from fastapi import APIRouter, HTTPException, Request
from pypdf import PdfReader
from pypdf.errors import PyPdfError

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
