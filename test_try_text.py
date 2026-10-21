import fitz

def _is_used(r, used_rects):
    if not used_rects: return False
    for ur in used_rects:
        if abs(r.x0 - ur.x0) < 2 and abs(r.y0 - ur.y0) < 2:
            return True
    return False

def _try_text(page, needle, tp=None, used_rects=None):
    if len(needle) <= 2:
        page_words = page.get_text("words", textpage=tp)
        hits = []
        for w in page_words:
            clean_word = w[4].strip(".,;:\"'()[]")
            if clean_word == needle or clean_word.lower() == needle.lower():
                r = fitz.Rect(w[:4])
                if not _is_used(r, used_rects):
                    hits.append(r)
        if hits:
            return hits
    return []

doc = fitz.open('test_out2.pdf')
page = doc[0]
used = []
for i in range(3):
    hits = _try_text(page, "i", used_rects=used)
    if hits:
        print(f"Match {i}: {hits[0]}")
        used.append(hits[0])
    else:
        print(f"Match {i}: Not found")
