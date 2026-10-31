from fastapi import FastAPI

app = FastAPI(title="baselhack26 api")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
