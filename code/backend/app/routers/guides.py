from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app import guide_review
from app.auth import require_passcode
from app.contracts import GuideReview, GuideReviewRequest
from app.extract import ExtractionFailed, ProviderUnavailable
from app.rate_limit import rate_limit

router = APIRouter(prefix="/api/guides", tags=["guides"])

Reviewer = Callable[[GuideReviewRequest], GuideReview]


def get_reviewer() -> Reviewer:
    return guide_review.review_guide


ReviewerDep = Annotated[Reviewer, Depends(get_reviewer)]


@router.post(
    "/review",
    response_model_by_alias=True,
    dependencies=[Depends(require_passcode), Depends(rate_limit("guides"))],
)
def review_guide(request: GuideReviewRequest, reviewer: ReviewerDep) -> GuideReview:
    try:
        return reviewer(request)
    except ProviderUnavailable:
        raise HTTPException(503, "guide review provider unavailable") from None
    except ExtractionFailed:
        raise HTTPException(502, "guide review output unusable") from None
