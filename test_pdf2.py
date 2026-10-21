import fitz

def text_to_pdf(text: str) -> bytes:
    doc = fitz.open()
    
    # insert_textbox returns the remaining string that didn't fit
    remaining = text
    while remaining:
        page = doc.new_page()
        rect = fitz.Rect(50, 50, 550, 800)
        rc = page.insert_textbox(rect, remaining, fontsize=11, fontname="helv")
        if rc < 0:
            break
        
        # Unfortunately insert_textbox does not return the remaining string directly,
        # it might just return the index or length? Let's print rc.
        print(f"rc = {rc}, len = {len(remaining)}")
        break

text_to_pdf('Hello\n' * 500)
