import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse, PlainTextResponse

from app.provider_log import request_id
from app.routers import events, guides, insights, personas, sessions, sources
from app.store import StoreUnavailable

REQUEST_ID_HEADER = "X-Request-Id"

app = FastAPI(title="baselhack26 api")
app.include_router(personas.router)
app.include_router(sources.router)
app.include_router(guides.router)
app.include_router(sessions.router)
app.include_router(events.router)
app.include_router(insights.router)


@app.middleware("http")
async def add_request_id(request, call_next):
    # Always our own id: a client-supplied one could forge or inject log lines.
    request.state.request_id = uuid.uuid4().hex
    request_id.set(request.state.request_id)
    response = await call_next(request)
    response.headers[REQUEST_ID_HEADER] = request.state.request_id
    return response


@app.exception_handler(StoreUnavailable)
def store_unavailable(_request, _exc) -> JSONResponse:
    return JSONResponse({"detail": "store unavailable"}, status_code=503)


@app.exception_handler(Exception)
def unhandled_error(request, _exc) -> PlainTextResponse:
    # Runs outside the middleware above, so a crash would otherwise lose the header. Same response
    # as the default handler, which also re-raises afterwards, so the traceback is still logged.
    return PlainTextResponse(
        "Internal Server Error",
        status_code=500,
        headers={REQUEST_ID_HEADER: request.state.request_id},
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
