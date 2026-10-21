import fitz

def text_to_pdf(text: str) -> bytes:
    doc = fitz.open()
    lines = text.split('\n')
    lines_per_page = 45
    
    for i in range(0, len(lines), lines_per_page):
        page_lines = lines[i:i+lines_per_page]
        page_text = '\n'.join(page_lines)
        
        page = doc.new_page(width=595, height=842) # A4
        rect = fitz.Rect(50, 50, 545, 792)
        page.insert_textbox(rect, page_text, fontsize=11, fontname="helv")
        
    return doc.tobytes()

with open('test_out2.pdf', 'wb') as f:
    f.write(text_to_pdf('Hello world\n' * 200))
