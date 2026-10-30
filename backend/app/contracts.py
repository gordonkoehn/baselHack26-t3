"""API contracts. Mirror of shared/schema.json — change that file first, then this one and frontend/src/lib/contracts.ts."""

from pydantic import BaseModel


class Item(BaseModel):
    id: str
    title: str
    done: bool = False


class ItemCreate(BaseModel):
    title: str
