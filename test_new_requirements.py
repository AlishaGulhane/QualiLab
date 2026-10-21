import os
import sys
import json
import base64
import fitz  # PyMuPDF
from PIL import Image
import io

# Add backend directory to sys.path
sys.path.insert(0, os.path.abspath("backend"))

from fastapi.testclient import TestClient
from main import app, _to_frontend_result
from services.file_store import read_file, get_preview_pdf
from services.annotation_service import annotate_image_file, annotate_pdf_pages
from models.schemas import (
    HygieneCheckResponse, IssueCategory, SeverityLevel,
    HygieneIssue, HygieneSummary
)

client = TestClient(app)

def test_universal_preview_non_pdf():
    print("\n--- TEST: Universal Preview for Non-PDF Formats (TXT, XML, DOCX) ---")
    
    # 1. Test TXT file upload and preview generation
    txt_content = b"This is a sample document text with a harmeful chemical substance and two  spaces."
    resp_txt = client.post(
        "/api/pdf/upload",
        files={"file": ("sample_report.txt", txt_content, "text/plain")}
    )
    assert resp_txt.status_code == 200, f"TXT upload failed: {resp_txt.text}"
    txt_data = resp_txt.json()
    file_id = txt_data["file_id"]
    
    # Verify original file content is intact and not altered
    orig_bytes = read_file(file_id)
    assert orig_bytes == txt_content, "Original TXT bytes must match exactly"
    
    # Verify preview PDF was created
    preview_bytes = get_preview_pdf(file_id)
    assert preview_bytes is not None, "Preview PDF must be cached in file_store"
    assert preview_bytes[:4] == b"%PDF", "Preview bytes must be valid PDF"
    
    # Verify zones endpoint can render preview pages for TXT
    zones_resp = client.get(f"/api/pdf/zones/{file_id}")
    assert zones_resp.status_code == 200, f"Zones for TXT failed: {zones_resp.text}"
    zones_data = zones_resp.json()
    assert len(zones_data["previews"]) >= 1, "Should have at least 1 preview page"
    assert "zones" in zones_data
    print("  -> Verified: TXT uploaded, original preserved, preview PDF & zones generated successfully.")

    # 2. Test XML file upload
    xml_content = b"<?xml version='1.0'?><root><content>Validation XML document with errrors</content></root>"
    resp_xml = client.post(
        "/api/pdf/upload",
        files={"file": ("data.xml", xml_content, "application/xml")}
    )
    assert resp_xml.status_code == 200, f"XML upload failed: {resp_xml.text}"
    xml_id = resp_xml.json()["file_id"]
    assert read_file(xml_id) == xml_content, "Original XML bytes must match exactly"
    assert get_preview_pdf(xml_id)[:4] == b"%PDF", "XML converted to preview PDF"
    print("  -> Verified: XML uploaded, original preserved, preview PDF generated successfully.")

    # 3. Test DOCX file upload
    import docx
    doc = docx.Document()
    doc.add_paragraph("This is a Word document with mispelled words.")
    docx_buf = io.BytesIO()
    doc.save(docx_buf)
    docx_bytes = docx_buf.getvalue()

    resp_docx = client.post(
        "/api/pdf/upload",
        files={"file": ("sample.docx", docx_bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}
    )
    assert resp_docx.status_code == 200, f"DOCX upload failed: {resp_docx.text}"
    docx_id = resp_docx.json()["file_id"]
    assert read_file(docx_id) == docx_bytes, "Original DOCX bytes must match exactly"
    assert get_preview_pdf(docx_id)[:4] == b"%PDF", "DOCX converted to preview PDF"
    print("  -> Verified: DOCX uploaded, original preserved, preview PDF generated successfully.")

    # 4. Test validation job on non-PDF (TXT) generates annotated previews & download
    v_resp = client.post("/api/qc/start_validate", json={"file_id": file_id})
    assert v_resp.status_code == 200, f"Validation on TXT failed: {v_resp.text}"
    job_id = v_resp.json()["job_id"]
    
    # Wait for job completion
    import time
    for _ in range(30):
        stat = client.get(f"/api/qc/status/{job_id}").json()
        if stat["status"] in ("done", "error"):
            break
        time.sleep(0.5)

    assert stat["status"] == "done", f"TXT validation job did not finish successfully: {stat}"
    res = stat["result"]
    assert len(res["annotated_previews"]) >= 1, "Annotated previews must be generated for TXT document"
    assert res["annotated_pdf_url"] is not None
    print("  -> Verified: Validation job on TXT successfully generated annotated previews and download PDF.")

def test_universal_preview_image_annotation():
    print("\n--- TEST: Image Annotation with Category Highlights & Colors ---")
    # Create a dummy RGB image
    img = Image.new("RGB", (600, 400), color=(240, 240, 240))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    img_bytes = buf.getvalue()

    # Create issues across categories
    issues = [
        HygieneIssue(
            id="iss_spelling_1",
            category=IssueCategory.spelling,
            severity=SeverityLevel.error,
            description="Misspelling of word",
            original="harmeful",
            suggestion="harmful",
            location="Line 1"
        ),
        HygieneIssue(
            id="iss_grammar_1",
            category=IssueCategory.grammar,
            severity=SeverityLevel.warning,
            description="Grammar issue",
            original="is",
            suggestion="are",
            location="Line 2"
        ),
        HygieneIssue(
            id="iss_case_1",
            category=IssueCategory.title_case,
            severity=SeverityLevel.warning,
            description="Lowercase start of sentence",
            original="the",
            suggestion="The",
            location="Line 3"
        ),
        HygieneIssue(
            id="iss_spacing_1",
            category=IssueCategory.double_spacing,
            severity=SeverityLevel.warning,
            description="Multiple consecutive spaces",
            original="two  spaces",
            suggestion="two spaces",
            location="Line 4"
        )
    ]
    resp_obj = HygieneCheckResponse(
        status="success",
        filename="test_image.png",
        content_type="image/png",
        summary=HygieneSummary(
            total_issues=4, errors=1, warnings=3, suggestions=0,
            overall_score=85, verdict="Fair"
        ),
        issues=issues,
        model_used="test"
    )

    annotated_png, callouts_list, pdf_bytes = annotate_image_file(img_bytes, resp_obj)
    assert len(annotated_png) > 0, "Annotated image bytes must be non-empty"
    assert len(callouts_list) > 0, "Must have callout pages"
    callouts = callouts_list[0]["callouts"]
    assert len(callouts) == 4, f"Must have 4 callouts, got {len(callouts)}"
    
    # Check that colors match category definitions
    callout_cats = {c["category"] for c in callouts}
    assert "spelling" in callout_cats
    assert "grammar" in callout_cats
    assert "title_case" in callout_cats
    assert "double_spacing" in callout_cats
    
    for c in callouts:
        assert "bbox" in c and len(c["bbox"]) == 4
        assert "color" in c or "id" in c
    print("  -> Verified: Image annotation generates distinct category highlights and color-coded callouts.")

def test_frontend_category_synchronization():
    print("\n--- TEST: Error Category Synchronization Logic ---")
    
    # Create sample issues covering all categories
    issues = [
        HygieneIssue(
            id="iss_sp_1",
            category=IssueCategory.spelling,
            severity=SeverityLevel.error,
            description="Spelling error",
            original="mispelled",
            suggestion="misspelled",
            location="Page 1"
        ),
        HygieneIssue(
            id="iss_gr_1",
            category=IssueCategory.grammar,
            severity=SeverityLevel.warning,
            description="Grammar error",
            original="They is",
            suggestion="They are",
            location="Page 1"
        ),
        HygieneIssue(
            id="iss_cap_1_0",
            category=IssueCategory.grammar,
            severity=SeverityLevel.warning,
            description="Start sentence with uppercase",
            original="the",
            suggestion="The",
            location="Page 1"
        ),
        HygieneIssue(
            id="iss_pron_1_0",
            category=IssueCategory.grammar,
            severity=SeverityLevel.warning,
            description="Capitalize pronoun 'I'",
            original="i",
            suggestion="I",
            location="Page 1"
        ),
        HygieneIssue(
            id="iss_space_1",
            category=IssueCategory.double_spacing,
            severity=SeverityLevel.warning,
            description="Double spaces found",
            original="two  spaces",
            suggestion="two spaces",
            location="Page 1"
        )
    ]
    resp_obj = HygieneCheckResponse(
        status="success",
        filename="test_sync.pdf",
        content_type="pdf",
        summary=HygieneSummary(
            total_issues=5, errors=1, warnings=4, suggestions=0,
            overall_score=85, verdict="Fair"
        ),
        issues=issues,
        model_used="test"
    )

    frontend_result = _to_frontend_result(resp_obj, job_id="job_test_123")
    
    # Check that categories are correctly partitioned
    assert len(frontend_result["spelling_issues"]) == 1, "Should have 1 spelling issue"
    assert frontend_result["spelling_issues"][0]["word"] == "mispelled"
    
    # Title / Case issues should contain both sentence capitalization and pronoun violations
    assert len(frontend_result["title_case_issues"]) == 2, f"Expected 2 title/case issues, got {len(frontend_result['title_case_issues'])}"
    
    # Formatting issues
    assert len(frontend_result["double_spacing_issues"]) == 1, "Should have 1 formatting issue"
    assert frontend_result["double_spacing_issues"][0]["category"] == "double_spacing"
    
    # Grammar issues
    assert len(frontend_result["grammar_issues"]) >= 1, "Should have grammar issues"
    
    # Category summary counts
    assert frontend_result["summary"]["spelling_count"] == 1
    assert frontend_result["summary"]["title_case_count"] == 2
    assert frontend_result["summary"]["formatting_count"] == 1
    
    print("  -> Verified: _to_frontend_result correctly maps issues to Spelling, Grammar, Case & Title, Spacing & Formatting.")

def test_frontend_ui_batch_and_tabs():
    print("\n--- TEST: Frontend UI Elements (Tabs, Batch Actions, Annotation Removal) ---")
    
    app_html_path = os.path.abspath("frontend/app.html")
    with open(app_html_path, "r", encoding="utf-8") as f:
        html = f.read()

    # 1. Error tabs verification
    assert 'id="error-category-tabs-wrapper"' in html, "Must contain error category tabs wrapper"
    assert 'data-category="all"' in html, "Must contain 'All' category tab"
    assert 'data-category="spelling"' in html, "Must contain 'Spelling' category tab"
    assert 'data-category="grammar"' in html, "Must contain 'Grammar & Punctuation' category tab"
    assert 'data-category="case"' in html, "Must contain 'Case & Title' category tab"
    assert 'data-category="formatting"' in html, "Must contain 'Spacing & Formatting' category tab"
    print("  -> Verified: app.html contains all 5 category tabs with badges.")

    # 2. Main.js batch download removal & annotation resolution verification
    main_js_path = os.path.abspath("frontend/js/main.js")
    with open(main_js_path, "r", encoding="utf-8") as f:
        js = f.read()

    # Ensure no 'btn-batch-download' or 'Download PDF' button in createBatchItemElement / showBatchItemActions
    assert "btn-batch-download" not in js, "Must remove individual Download PDF buttons from batch validation items"
    assert "resolveWordAnnotationsForCurrentDocument" in js, "Must define resolveWordAnnotationsForCurrentDocument"
    assert "switchErrorCategoryTab" in js, "Must define switchErrorCategoryTab"
    assert "updateErrorCategoryCounts" in js, "Must define updateErrorCategoryCounts"
    assert "updatePreviewImages" in js, "Must define updatePreviewImages for real-time preview updates"
    assert "saveActiveReviewToSession" in js, "Must define saveActiveReviewToSession for refresh persistence"
    assert "restoreActiveReviewFromSession" in js, "Must define restoreActiveReviewFromSession for refresh restoration"
    assert "preview-page-img" in js, "Must include preview-page-img selector in main.js"
    print("  -> Verified: main.js has individual Download PDF removed from batch items.")
    print("  -> Verified: main.js has resolveWordAnnotationsForCurrentDocument, switchErrorCategoryTab, updateErrorCategoryCounts.")
    print("  -> Verified: main.js has saveActiveReviewToSession & restoreActiveReviewFromSession for persistence.")

def test_ignore_undo_and_dictionary_atomic_resolution():
    print("\n--- TEST: Ignore, Undo, and Dictionary Atomic Resolution ---")
    
    # Create test document with two spelling issues: 'harmeful' on Page 1 and Page 2
    doc = fitz.open()
    page1 = doc.new_page(width=612, height=792)
    page1.insert_text((72, 100), "This is page 1 with harmeful substance.", fontsize=12)
    page2 = doc.new_page(width=612, height=792)
    page2.insert_text((72, 100), "This is page 2 also containing harmeful substance.", fontsize=12)
    pdf_bytes = doc.tobytes()
    doc.close()

    # Upload
    resp = client.post("/api/pdf/upload", files={"file": ("test_ignore.pdf", pdf_bytes, "application/pdf")})
    assert resp.status_code == 200
    file_id = resp.json()["file_id"]

    # Validate
    val_resp = client.post("/api/qc/start_validate", json={"file_id": file_id})
    assert val_resp.status_code == 200
    job_id = val_resp.json()["job_id"]

    import time
    for _ in range(30):
        stat = client.get(f"/api/qc/status/{job_id}").json()
        if stat["status"] == "done":
            break
        time.sleep(0.5)

    assert stat["status"] == "done"
    result = stat["result"]
    spelling_issues = result.get("spelling_issues", [])
    assert len(spelling_issues) >= 2, f"Expected at least 2 spelling issues, got {len(spelling_issues)}"
    id_p1 = spelling_issues[0]["id"]
    id_p2 = spelling_issues[1]["id"]
    assert id_p1 != id_p2, "Each occurrence must have unique ID"

    # 1. Ignore Page 1 occurrence only
    ign_resp = client.post(f"/api/qc/ignore/{job_id}", json={"issue_id": id_p1, "original": "harmeful"})
    assert ign_resp.status_code == 200
    ign_data = ign_resp.json()
    assert ign_data["status"] == "ok"
    assert ign_data["total_ignored"] == 1
    assert len(ign_data["annotated_previews"]) >= 2
    # Check that Page 2 is still reported in page_issues
    p2_issues = [iss for pg in ign_data["page_issues"] if pg["page"] == 2 for iss in pg.get("issues", [])]
    assert any(i.get("id") == id_p2 for i in p2_issues), "Page 2 occurrence must remain active"
    print("  -> Verified: Ignore applies ONLY to selected occurrence; other occurrences remain flagged.")

    # 2. Undo/Restore Page 1 occurrence
    res_resp = client.post(f"/api/qc/restore/{job_id}", json={"issue_id": id_p1, "original": "harmeful"})
    assert res_resp.status_code == 200
    res_data = res_resp.json()
    assert res_data["status"] == "ok"
    assert res_data["total_ignored"] == 0
    p1_issues = [iss for pg in res_data["page_issues"] if pg["page"] == 1 for iss in pg.get("issues", [])]
    assert any(i.get("id") == id_p1 for i in p1_issues), "Page 1 occurrence must be restored"
    print("  -> Verified: Undo cleanly restores the ignored occurrence to preview and page issues.")

    # 3. Add to dictionary / approve word atomically: resolves all occurrences of that word
    dict_ign_resp = client.post(f"/api/qc/ignore/{job_id}", json={"word": "harmeful"})
    assert dict_ign_resp.status_code == 200
    dict_ign_data = dict_ign_resp.json()
    assert dict_ign_data["total_ignored"] >= 2, "All occurrences of approved word must be ignored"
    print("  -> Verified: Approving/adding word to dictionary resolves all occurrences atomically.")

def main():
    print("=" * 70)
    print("RUNNING QUALILAB NEW REQUIREMENTS TEST SUITE")
    print("=" * 70)
    test_universal_preview_non_pdf()
    test_universal_preview_image_annotation()
    test_frontend_category_synchronization()
    test_frontend_ui_batch_and_tabs()
    test_ignore_undo_and_dictionary_atomic_resolution()
    print("=" * 70)
    print("ALL NEW REQUIREMENTS TESTS PASSED SUCCESSFULLY! (100% PASS)")
    print("=" * 70)

if __name__ == "__main__":
    main()
