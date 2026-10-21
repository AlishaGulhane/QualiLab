import asyncio
import os
import sys
sys.path.append('backend')
from services.hygiene_service import run_hygiene_check_paged
from models.schemas import HygieneCheckResponse

async def main():
    pages = [
        {"page_num": 1, "text": "Why Optimizing IV Chemotherapy Matters. Difficult Intravenous Access (DIVA) affects patients across the Pacific region.", "images": []}
    ]
    result = await run_hygiene_check_paged(pages, "application/pdf", "test.pdf")
    for issue in result.issues:
        print(f"[{issue.category.value}] Original: {repr(issue.original)} -> Suggestion: {repr(issue.suggestion)}")

asyncio.run(main())
