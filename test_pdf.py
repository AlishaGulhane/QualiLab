import fitz

def text_to_pdf(text: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    rect = fitz.Rect(50, 50, 550, 800)
    page.insert_textbox(rect, text, fontsize=11, fontname="helv")
    return doc.tobytes()

with open('test_out.pdf', 'wb') as f:
    f.write(text_to_pdf('Hello\n' * 50))
