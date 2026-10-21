import sys
sys.path.append('.')
from models.schemas import HygieneIssue, IssueCategory, SeverityLevel
from services.hygiene_service import _is_valid_issue

issue1 = HygieneIssue(
    category=IssueCategory.spelling,
    severity=SeverityLevel.error,
    location='', original='"fluid"', suggestion='fluid', description=''
)
issue2 = HygieneIssue(
    category=IssueCategory.spelling,
    severity=SeverityLevel.error,
    location='', original='Difficult', suggestion='difficult', description=''
)

print(f"fluid: {_is_valid_issue(issue1)}")
print(f"Difficult: {_is_valid_issue(issue2)}")
