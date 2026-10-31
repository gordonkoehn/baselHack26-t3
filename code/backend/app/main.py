from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.routers import personas, sources
from app.store import StoreUnavailable

app = FastAPI(title="baselhack26 api")
app.include_router(personas.router)
app.include_router(sources.router)


@app.exception_handler(StoreUnavailable)
def store_unavailable(_request, _exc) -> JSONResponse:
    return JSONResponse({"detail": "store unavailable"}, status_code=503)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
