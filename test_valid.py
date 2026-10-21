import re
from enum import Enum

class IssueCategory(str, Enum):
    spelling = "spelling"
    grammar = "grammar"

class HygieneIssue:
    def __init__(self, category, original, suggestion):
        self.category = category
        self.original = original
        self.suggestion = suggestion

def _is_valid_issue(issue: HygieneIssue) -> bool:
    original_s = (issue.original or "").strip()
    suggestion_s = (issue.suggestion or "").strip()
    if original_s and suggestion_s and original_s == suggestion_s:
        return False

    if issue.category == IssueCategory.spelling:
        orig_letters = re.sub(r'[^\w\s]', '', original_s).lower()
        sugg_letters = re.sub(r'[^\w\s]', '', suggestion_s).lower()
        if orig_letters and sugg_letters and orig_letters == sugg_letters:
            return False
            
    return True

issues = [
    HygieneIssue(IssueCategory.spelling, '"fluid"', 'fluid'),
    HygieneIssue(IssueCategory.spelling, 'Difficult', 'difficult'),
    HygieneIssue(IssueCategory.spelling, 'Pacific', 'pacific'),
    HygieneIssue(IssueCategory.spelling, 'affecting', 'offering'),
    HygieneIssue(IssueCategory.grammar, 'Why Optimizing', 'Why optimizing?'),
]

for i in issues:
    valid = _is_valid_issue(i)
    print(f"[{i.category.value}] '{i.original}' -> '{i.suggestion}': Valid={valid}")
