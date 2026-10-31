"""Strict request validation for SessionEvent's conditional data schemas."""

import re
from datetime import UTC, datetime
from math import isfinite
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError, field_validator
from pydantic_core import PydanticSerializationError

from app.contracts import SessionEvent, SessionEventType


def _integer(value: object) -> object:
    # JSON Schema integers include finite numbers without a fractional part.
    if isinstance(value, float) and isfinite(value) and value.is_integer():
        return int(value)
    return value


_Integer = Annotated[int, BeforeValidator(_integer)]


class _Data(BaseModel):
    model_config = ConfigDict(strict=True, allow_inf_nan=False)


class _Utterance(_Data):
    speaker: Literal["interviewer", "persona"]
    text: str
    t_start: float | None = Field(default=None, alias="tStart")
    t_end: float | None = Field(default=None, alias="tEnd")


class _Caption(_Data):
    caption: str
    source: Literal["vision", "dom"]


class _Reaction(_Data):
    kind: Literal["confused", "pleased", "sceptical"]
    intensity: _Integer = Field(ge=1, le=5)


class _Suggestion(_Data):
    kind: Literal["leading_question", "pitching", "follow_up", "coverage"]
    text: str
    turn_seq: _Integer | None = Field(default=None, alias="turnSeq")


class _Ended(_Data):
    # Optional but not nullable; this validation-only default is never persisted.
    duration_seconds: float = Field(default=0, alias="durationSeconds")
    transcript_gaps: bool = Field(default=False, alias="transcriptGaps")


_DATA_MODELS: dict[SessionEventType, type[_Data]] = {
    "utterance": _Utterance,
    "screen.caption": _Caption,
    "twin.reaction": _Reaction,
    "copilot.suggestion": _Suggestion,
    "session.ended": _Ended,
}

_TIMESTAMP = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]+)?(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])"
)


class _Event(SessionEvent):
    model_config = ConfigDict(strict=True, populate_by_name=False)

    seq: _Integer = Field(ge=1)

    @field_validator("at")
    @classmethod
    def timestamp(cls, value: str) -> str:
        if not _TIMESTAMP.fullmatch(value):
            raise ValueError("expected an RFC3339 timestamp with timezone")
        calendar_value = value.upper()
        leap_second = calendar_value[17:19] == "60"
        if leap_second:
            # datetime cannot parse leap seconds; use 59 only for calendar validation.
            calendar_value = calendar_value[:17] + "59" + calendar_value[19:]
        parsed = datetime.fromisoformat(calendar_value)
        if leap_second:
            try:
                utc = parsed.astimezone(UTC)
            except OverflowError:
                raise ValueError("invalid leap second") from None
            # The offset must place the leap second at a June/December UTC boundary.
            if (utc.hour, utc.minute) != (23, 59) or (utc.month, utc.day) not in (
                (6, 30),
                (12, 31),
            ):
                raise ValueError("invalid leap second")
        return value


def _reject_nonfinite(value: object) -> None:
    # Extra properties bypass typed fields but must still survive JSON storage unchanged.
    if isinstance(value, float) and not isfinite(value):
        raise HTTPException(422, "invalid session event")
    if isinstance(value, dict):
        for item in value.values():
            _reject_nonfinite(item)
    elif isinstance(value, list):
        for item in value:
            _reject_nonfinite(item)


def _validate_event(value: object) -> SessionEvent:
    try:
        _reject_nonfinite(value)
        event = _Event.model_validate(value)
        _DATA_MODELS[event.type].model_validate(event.data)
        # Check both JSON serialization and Store loading before any batch write.
        serialized_event = event.model_dump_json(by_alias=True)
        SessionEvent.model_validate_json(serialized_event)
    except (ValidationError, PydanticSerializationError, RecursionError):
        raise HTTPException(422, "invalid session event") from None
    # Validate without replacing data: retain extras, nulls, numbers and omitted fields.
    return event


EventInput = Annotated[SessionEvent, BeforeValidator(_validate_event)]
