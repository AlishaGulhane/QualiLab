import fitz

def text_to_pdf(text: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842) # A4
    rect = fitz.Rect(50, 50, 545, 792)
    page.insert_textbox(rect, text, fontsize=11, fontname="helv")
    doc.save('test_i.pdf')

text_to_pdf('Hi my name is alisha. i study at VIT. can i borrow your charger. i almost get an headache.')

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

doc = fitz.open('test_i.pdf')
page = doc[0]
used = []
for i in range(5):
    hits = _try_text(page, "i", used_rects=used)
    if hits:
        print(f"Match {i}: {hits[0]}")
        used.append(hits[0])
    else:
        print(f"Match {i}: Not found")
