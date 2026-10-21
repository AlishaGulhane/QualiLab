def _detect_capitalization(text: str, page_num: int) -> list[HygieneIssue]:
    issues = []
    
    # 1. Start of sentence/paragraph
    # Match the first letter that occurs after ^ or .!? followed by whitespace
    import re
    # We use a pattern to find sentence boundaries and the first letter
    for match in re.finditer(r'(?:^|[\.\?\!]\s+)([a-z])', text):
        char = match.group(1)
        start_idx = match.start(1)
        
        # Extract full word
        word_match = re.match(r'[a-z]+', text[start_idx:])
        if not word_match:
            continue
        original_word = word_match.group(0)
        
        ctx_start = max(0, start_idx - 30)
        ctx_end = min(len(text), start_idx + len(original_word) + 30)
        location = text[ctx_start:ctx_end].replace('\n', ' ').strip()
        
        issues.append(HygieneIssue(
            category=IssueCategory.grammar,
            severity=SeverityLevel.error,
            location=f"Page {page_num}: {location}" if page_num else location,
            original=original_word,
            suggestion=original_word.capitalize(),
            description="The first word of a sentence or paragraph must be capitalized."
        ))
        
    # 2. Standalone lowercase 'i'
    # Wait, need to not match 'i' inside other words.
    for match in re.finditer(r'(?<![A-Za-z])(i)(?![A-Za-z])', text):
        start_idx = match.start(1)
        ctx_start = max(0, start_idx - 30)
        ctx_end = min(len(text), start_idx + 1 + 30)
        location = text[ctx_start:ctx_end].replace('\n', ' ').strip()
        
        issues.append(HygieneIssue(
            category=IssueCategory.grammar,
            severity=SeverityLevel.error,
            location=f"Page {page_num}: {location}" if page_num else location,
            original="i",
            suggestion="I",
            description="The pronoun 'I' must always be capitalized."
        ))
        
    return issues
