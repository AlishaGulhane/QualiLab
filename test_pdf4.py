def convert_to_pdf(raw: bytes, filename: str) -> bytes:
    import fitz
    text = ""
    if filename.lower().endswith(".docx"):
        from docx import Document
        import io
        try:
            doc = Document(io.BytesIO(raw))
            text = '\n'.join([p.text for p in doc.paragraphs if p.text.strip()])
        except Exception:
            text = "Failed to extract DOCX text."
    else:
        text = raw.decode("utf-8", errors="ignore")
        
    pdf_doc = fitz.open()
    lines = text.split('\n')
    lines_per_page = 45
    
    if not lines or not any(lines):
        # Empty doc
        page = pdf_doc.new_page(width=595, height=842)
        page.insert_textbox(fitz.Rect(50, 50, 545, 792), "[Empty Document]", fontsize=11, fontname="helv")
    else:
        for i in range(0, max(1, len(lines)), lines_per_page):
            page_lines = lines[i:i+lines_per_page]
            page_text = '\n'.join(page_lines)
            
            page = pdf_doc.new_page(width=595, height=842)
            rect = fitz.Rect(50, 50, 545, 792)
            page.insert_textbox(rect, page_text, fontsize=11, fontname="helv")
            
    pdf_bytes = pdf_doc.tobytes()
    pdf_doc.close()
    return pdf_bytes
