from pydantic import BaseModel
from typing import Optional, List
from enum import Enum


class SeverityLevel(str, Enum):
    error = "error"
    warning = "warning"
    suggestion = "suggestion"


class IssueCategory(str, Enum):
    spelling = "spelling"
    grammar = "grammar"
    double_spacing = "double_spacing"
    title_case = "title_case"


class HygieneIssue(BaseModel):
    id: Optional[str] = None
    category: IssueCategory
    severity: SeverityLevel
    location: Optional[str] = None
    original: Optional[str] = None
    suggestion: Optional[str] = None
    description: str


class HygieneSummary(BaseModel):
    total_issues: int
    errors: int
    warnings: int
    suggestions: int
    overall_score: int  # 0-100
    verdict: str  # "Excellent", "Good", "Needs Work", "Poor"


class HygieneCheckResponse(BaseModel):
    status: str
    filename: Optional[str] = None
    content_type: str
    summary: HygieneSummary
    issues: List[HygieneIssue]
    corrected_text: Optional[str] = None
    model_used: str


class TextCheckRequest(BaseModel):
    text: str
    domain: Optional[str] = None  # e.g., "technical", "academic", "business"
