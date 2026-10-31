import pytest
from fastapi.testclient import TestClient

from app import avatar
from app.extract import ProviderUnavailable
from app.faces import FACES, VOICES
from app.main import app
from app.store import Store, get_store
from tests.fakes import FakeRedis
from tests.test_coverage import PERSONA

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
URL = f"/api/personas/{PERSONA.id}"


@pytest.fixture
def client(monkeypatch):
    store = Store(FakeRedis())
    store.save_persona(PERSONA)
    app.dependency_overrides[get_store] = lambda: store
    # Tests never reach Simli: any unexpected call fails loudly.
    monkeypatch.setattr(avatar, "generate_face", lambda *_: pytest.fail("no Simli call expected"))
    monkeypatch.setattr(avatar, "face_status", lambda *_: pytest.fail("no Simli call expected"))
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_photo_becomes_the_call_face_once_simli_is_done(client, monkeypatch):
    client.put(f"{URL}/photo", content=PNG)
    sent = {}

    def generate(image, mime, name):
        sent.update(image=image, mime=mime, name=name)
        return "custom-face-1", 1793460000

    monkeypatch.setattr(avatar, "generate_face", generate)
    started = client.post(f"{URL}/face").json()
    assert sent == {"image": PNG, "mime": "image/png", "name": PERSONA.id}
    assert started["customFace"]["status"] == "pending"
    assert started["customFace"]["dispatchAfter"] == 1793460000
    assert started["faceId"] == PERSONA.face_id  # still the preset until Simli is done

    statuses = iter([("processing", None), ("completed", None)])
    monkeypatch.setattr(avatar, "face_status", lambda _id: next(statuses))
    assert client.post(f"{URL}/face/refresh").json()["faceId"] == PERSONA.face_id
    done = client.post(f"{URL}/face/refresh").json()
    assert done["customFace"]["status"] == "completed"
    assert done["faceId"] == "custom-face-1" and done["version"] == PERSONA.version + 1
    # Finished: no more Simli calls (face_status would raise StopIteration now).
    assert client.post(f"{URL}/face/refresh").json() == done

    # The custom face can be switched back to and gets an explicit voice.
    client.patch(URL, json={"faceId": FACES["Hank"][0]})
    back = client.patch(URL, json={"faceId": "custom-face-1", "voiceId": VOICES["m"]}).json()
    assert back["faceId"] == "custom-face-1" and back["voiceId"] == VOICES["m"]


def test_face_needs_a_photo_and_maps_simli_errors(client, monkeypatch):
    assert client.post(f"{URL}/face").status_code == 409
    assert client.post("/api/personas/nope/face").status_code == 404
    assert client.post(f"{URL}/face/refresh").status_code == 404
    client.put(f"{URL}/photo", content=PNG)
    for exc, status in [
        (avatar.FaceQuotaExceeded(), 409),
        (avatar.FaceRejected(), 422),
        (ProviderUnavailable("down"), 503),
    ]:

        def fail(*_, exc=exc):
            raise exc

        monkeypatch.setattr(avatar, "generate_face", fail)
        assert client.post(f"{URL}/face").status_code == status
    assert client.get(URL).json().get("customFace") is None


def test_unknown_faces_and_voices_are_rejected(client):
    assert client.patch(URL, json={"faceId": "custom-face-1"}).status_code == 422
    assert client.patch(URL, json={"voiceId": "alloy"}).status_code == 422
