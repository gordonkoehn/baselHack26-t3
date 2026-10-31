"""Simli preset faces the persona extractor picks from, so the avatar fits who the persona is.

Looks described from https://docs.simli.com/api-reference/preset-faces (Standard set).
The voice follows the face, so a man never speaks with a woman's voice.
"""

import re
from typing import Literal

FaceName = Literal[
    "Anna", "Sara", "Mei", "Claire", "Lukas", "Mateo", "Jordan", "Kate", "Elena", "Zahra",
    "Hank", "Victor", "Tina", "Lina", "Daniel", "Sophie", "Doctor", "Fred", "Margaret",
]  # fmt: skip

# name: (Simli face id, gender, look)
FACES: dict[str, tuple[str, str, str]] = {
    "Anna": ("bf13113a-355a-4d97-8b90-4edccd1da7b2", "f", "woman ~28, white, light brown hair, casual sweater"),
    "Sara": ("f735e62c-dce7-4c0b-8e85-1c7e21774c45", "f", "woman ~25, Black, hair up, casual sweater"),
    "Mei": ("084479bf-de7c-4df0-8d9c-5484193ecd27", "f", "woman ~35, East Asian, blazer, modern office"),
    "Claire": ("5a83913c-411b-4afd-8432-b7d685e2aee6", "f", "woman ~45, white, dark hair, hotel/service uniform"),
    "Lukas": ("a36d66df-a23d-4569-996b-d0e990019857", "m", "man ~30, white, blond, casual dark shirt, city evening"),
    "Mateo": ("99767950-9d68-4783-a305-9118006d3363", "m", "man ~30, Southern European/Latino, open shirt and jacket, office"),
    "Jordan": ("3dcb9c78-8822-4e6e-913f-b629c602524a", "m", "man ~30, Black, black turtleneck, tech office"),
    "Kate": ("c060fe44-9b14-43e8-b92c-83a0e230db11", "f", "woman ~30, white, dark bob, grey sweater, plain background"),
    "Elena": ("80459b57-2d66-4ca7-8682-59e1c649bc53", "f", "woman ~30, white, long dark curly hair, white blouse"),
    "Zahra": ("a6d08e06-038a-4b32-84ae-b02e0f0f1140", "f", "woman ~30, South Asian/Middle Eastern, green blouse"),
    "Hank": ("9fcd5739-bf66-49a5-b525-d02d7f0bc2fc", "m", "man ~40, white, glasses, stubble, white shirt"),
    "Victor": ("3bad681f-1b4a-4507-bc54-fbc675c191b7", "m", "man ~55, grey hair and beard, dark t-shirt"),
    "Tina": ("66d1f5af-9b9b-49e2-a97f-6f5f3d59a2d5", "f", "woman ~35, East Asian, dark business suit"),
    "Lina": ("8b1a04c8-b548-452f-bf7f-04907ea9720f", "f", "woman ~28, South Asian, hair up, black t-shirt"),
    "Daniel": ("03ce3ee8-db97-4150-a333-8f643d48fee9", "m", "man ~35, East Asian, suit and tie"),
    "Sophie": ("99126e69-c224-404c-9aed-80805c1c9a94", "f", "woman ~50, white, blonde, light blouse"),
    "Doctor": ("9291a1e2-8290-43ab-b5e1-4a5cdf147402", "f", "woman ~40, white, blonde, white medical coat"),
    "Fred": ("c1cf7312-5b70-454b-a3c2-a0b0b7e32caf", "m", "man ~25, Black, white t-shirt"),
    "Margaret": ("1d032d8b-0cff-4156-9f0d-f001f0738d9c", "f", "woman ~70, white, grey hair, glasses, cardigan"),
}  # fmt: skip

Gender = Literal["f", "m"]


def _age(name: str) -> int:
    return int(re.search(r"~(\d+)", FACES[name][2]).group(1))  # type: ignore[union-attr]


def fitting_face(face: str, gender: Gender, age: int | None) -> str:
    """The chosen face if it has the persona's gender, else the closest-in-age face that does."""
    if FACES[face][1] == gender:
        return face
    target = age if age is not None else _age(face)
    # "Doctor" wears a medical coat; only the model may pick it, for someone who fits it.
    options = (n for n, f in FACES.items() if f[1] == gender and n != "Doctor")
    return min(options, key=lambda n: abs(_age(n) - target))


# OpenAI Realtime voices.
VOICES = {"f": "marin", "m": "cedar"}


def catalog() -> str:
    return "\n".join(f"- {name}: {look}" for name, (_, _, look) in FACES.items())
