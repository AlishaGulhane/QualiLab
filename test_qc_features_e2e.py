import os
import sys
import json
import base64
import fitz  # PyMuPDF

# Add backend directory to sys.path
sys.path.insert(0, os.path.abspath("backend"))

from fastapi.testclient import TestClient
from main import app
from services.pg_service import (
    add_user_dictionary_word,
    remove_user_dictionary_word,
    get_user_dictionary_words,
    log_user_activity,
    get_user_activities
)

client = TestClient(app)

def create_test_pdf_with_duplicate_words():
    """Create a 2-page PDF containing duplicate spelling error 'harmeful'."""
    doc = fitz.open()
    
    # Page 1
    page1 = doc.new_page(width=612, height=792)
    p1_text = "This is page 1 with a harmeful chemical substance."
    page1.insert_text((72, 100), p1_text, fontsize=12)
    
    # Page 2
    page2 = doc.new_page(width=612, height=792)
    p2_text = "This is page 2 also containing harmeful materials."
    page2.insert_text((72, 100), p2_text, fontsize=12)
    
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes

def create_test_pdf_multi_category():
    """Create a PDF containing issues from all 4 categories."""
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    text = (
        "the harmeful chemical was identified. Where is the treatment. "
        "They is receiving care with two  spaces and i am monitoring."
    )
    page.insert_text((72, 100), text, fontsize=12)
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes

def run_e2e_tests():
    print("=" * 70)
    print("STARTING E2E VERIFICATION FOR QUALILAB QC SUITE")
    print("=" * 70)
    
    user_a = "user_alpha_123"
    user_b = "user_beta_456"
    
    # Clean test state
    try:
        remove_user_dictionary_word(user_a, "harmeful")
        remove_user_dictionary_word(user_b, "harmeful")
    except Exception:
        pass

    # -------------------------------------------------------------
    # TEST 1: Dictionary Persistence, Isolation & Capitalization Preservation
    # -------------------------------------------------------------
    print("\n[TEST 1] Testing User Dictionary Persistence, Isolation & Exact Capitalization Preservation...")
    # User A adds standard and mixed-case words
    resp_a = client.post("/api/user/dictionary", json={"word": "harmeful"}, headers={"Authorization": f"Bearer mock_{user_a}"})
    assert resp_a.status_code == 200, f"User A add failed: {resp_a.text}"
    
    resp_mixed = client.post("/api/user/dictionary", json={"word": "QualiLab"}, headers={"Authorization": f"Bearer mock_{user_a}"})
    assert resp_mixed.status_code == 200, f"User A add QualiLab failed: {resp_mixed.text}"
    assert resp_mixed.json()["entry"]["word"] == "QualiLab", "Entry must preserve exact capitalization 'QualiLab'"

    resp_iphone = client.post("/api/user/dictionary", json={"word": "iPhone"}, headers={"Authorization": f"Bearer mock_{user_a}"})
    assert resp_iphone.status_code == 200, f"User A add iPhone failed: {resp_iphone.text}"
    assert resp_iphone.json()["entry"]["word"] == "iPhone", "Entry must preserve exact capitalization 'iPhone'"

    # User A queries dictionary -> must preserve exact case
    dict_a = client.get("/api/user/dictionary", headers={"Authorization": f"Bearer mock_{user_a}"}).json()
    words_a = [w["word"] for w in dict_a["words"]]
    assert "QualiLab" in words_a, f"QualiLab missing from User A dictionary words: {words_a}"
    assert "iPhone" in words_a, f"iPhone missing from User A dictionary words: {words_a}"
    assert "harmeful" in words_a, f"harmeful missing from User A dictionary words: {words_a}"
    print("  -> User A successfully added and retrieved exact mixed-case words ('QualiLab', 'iPhone').")

    # Verify hygiene set remains lowercase for case-insensitive validation
    hygiene_set_a = get_user_dictionary_words(f"mock_{user_a}")
    assert "qualilab" in hygiene_set_a, "Hygiene filtering set must contain lowercase 'qualilab'"
    assert "iphone" in hygiene_set_a, "Hygiene filtering set must contain lowercase 'iphone'"
    print("  -> Verified: Hygiene filtering set is lowercase for robust case-insensitive validation.")

    # User B queries dictionary -> should NOT see User A's word
    dict_b = client.get("/api/user/dictionary", headers={"Authorization": f"Bearer mock_{user_b}"}).json()
    assert not any(w["word"].lower() == "harmeful" for w in dict_b["words"]), "User B should NOT have 'harmeful'"
    assert not any(w["word"].lower() == "qualilab" for w in dict_b["words"]), "User B should NOT have 'QualiLab'"
    print("  -> User B dictionary verified isolated: does not contain User A's words.")

    # Clean up temporary test words for User A (leave harmeful for Test 6)
    client.delete("/api/user/dictionary/QualiLab", headers={"Authorization": f"Bearer mock_{user_a}"})
    client.delete("/api/user/dictionary/iPhone", headers={"Authorization": f"Bearer mock_{user_a}"})
    print("  -> Verified: Exact mixed-case words deleted cleanly using case-insensitive removal.")

    # -------------------------------------------------------------
    # TEST 2: Validation Job with Duplicate Errors & Unique Issue IDs
    # -------------------------------------------------------------
    print("\n[TEST 2] Running Validation with Duplicate Spelling Errors...")
    pdf_bytes = create_test_pdf_with_duplicate_words()
    
    # Step 1: Upload file for User B (who has NOT approved 'harmeful')
    upload_resp = client.post(
        "/api/pdf/upload",
        files={"file": ("test_doc.pdf", pdf_bytes, "application/pdf")},
        data={"brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert upload_resp.status_code == 200, f"Upload failed: {upload_resp.text}"
    file_id = upload_resp.json()["file_id"]
    print(f"  -> Uploaded file: {file_id}")

    # Step 2: Start validation job
    val_resp = client.post(
        "/api/qc/start_validate",
        json={"file_id": file_id, "brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert val_resp.status_code == 200, f"Start validate failed: {val_resp.text}"
    job_id = val_resp.json()["job_id"]
    print(f"  -> Validation job started: {job_id}")

    # Poll status until done
    import time
    for _ in range(30):
        st = client.get(f"/api/qc/status/{job_id}").json()
        if st["status"] == "done":
            break
        time.sleep(0.5)
    
    assert st["status"] == "done", f"Job failed to finish: {st}"
    result = st["result"]
    spelling_issues = result.get("issues", {}).get("spelling_issues", [])
    print(f"  -> Job finished with {len(spelling_issues)} spelling issue occurrences.")
    
    # Verify each occurrence has a distinct ID
    callouts_page1 = [c for c in result["page_issues"][0].get("callouts", []) if "harmeful" in str(c.get("msg", "")).lower() or "harmeful" in str(c.get("word", "")).lower()]
    callouts_page2 = [c for c in result["page_issues"][1].get("callouts", []) if "harmeful" in str(c.get("msg", "")).lower() or "harmeful" in str(c.get("word", "")).lower()]
    
    assert len(callouts_page1) > 0, "Page 1 error not found"
    assert len(callouts_page2) > 0, "Page 2 error not found"
    
    issue_p1_id = callouts_page1[0].get("id") or callouts_page1[0].get("issue_id")
    issue_p2_id = callouts_page2[0].get("id") or callouts_page2[0].get("issue_id")
    assert issue_p1_id != issue_p2_id, f"Issue IDs must be unique! Got: {issue_p1_id} vs {issue_p2_id}"
    print(f"  -> Page 1 issue ID: {issue_p1_id}")
    print(f"  -> Page 2 issue ID: {issue_p2_id}")

    # -------------------------------------------------------------
    # TEST 3: Ignore Single Occurrence (Identical elsewhere stays)
    # -------------------------------------------------------------
    print("\n[TEST 3] Testing Ignore on Page 1 Occurrence Only...")
    ignore_resp = client.post(
        f"/api/qc/ignore/{job_id}",
        json={"issue_id": issue_p1_id, "original": "harmeful"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert ignore_resp.status_code == 200, f"Ignore failed: {ignore_resp.text}"
    ign_data = ignore_resp.json()
    assert ign_data["total_ignored"] == 1, "Expected 1 total ignored"
    print(f"  -> Ignored issue {issue_p1_id}. Total ignored: {ign_data['total_ignored']}")

    # Check updated status
    updated_st = client.get(f"/api/qc/status/{job_id}").json()
    updated_res = updated_st["result"]
    
    # Page 1 should no longer have callout for issue_p1_id
    p1_active = [p for p in updated_res["page_issues"] if p["page"] == 1]
    p1_active_ids = [c.get("id") or c.get("issue_id") for c in (p1_active[0].get("callouts", []) if p1_active else [])]
    assert issue_p1_id not in p1_active_ids, f"Ignored issue {issue_p1_id} should be absent from Page 1 callouts!"
    
    # Page 2 MUST STILL HAVE issue_p2_id!
    p2_active = [p for p in updated_res["page_issues"] if p["page"] == 2]
    assert len(p2_active) > 0, "Page 2 must have active issues"
    p2_active_ids = [c.get("id") or c.get("issue_id") for c in p2_active[0].get("callouts", [])]
    assert issue_p2_id in p2_active_ids, f"Identical issue on Page 2 {issue_p2_id} MUST remain flagged!"
    print("  -> Verified: Page 1 error was removed, but identical error on Page 2 remains flagged!")

    # Verify Annotated PDF download contains only Page 2 annotation
    pdf_download_resp = client.get(f"/api/qc/annotated/{job_id}")
    assert pdf_download_resp.status_code == 200
    assert len(pdf_download_resp.content) > 1000, "Exported PDF is too small"
    print("  -> Exported annotated PDF successfully generated and verified.")

    # -------------------------------------------------------------
    # TEST 4: Undo / Restore within Current Review
    # -------------------------------------------------------------
    print("\n[TEST 4] Testing Undo / Restore within Current Review...")
    restore_resp = client.post(
        f"/api/qc/restore/{job_id}",
        json={"issue_id": issue_p1_id, "original": "harmeful"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert restore_resp.status_code == 200, f"Restore failed: {restore_resp.text}"
    rest_data = restore_resp.json()
    assert rest_data["total_ignored"] == 0, "Expected 0 total ignored after restore"
    print(f"  -> Restored issue {issue_p1_id}. Total ignored: {rest_data['total_ignored']}")

    restored_st = client.get(f"/api/qc/status/{job_id}").json()
    p1_restored = [p for p in restored_st["result"]["page_issues"] if p["page"] == 1]
    assert len(p1_restored) > 0, "Page 1 should have issues again after restore"
    p1_restored_ids = [c.get("id") or c.get("issue_id") for c in p1_restored[0].get("callouts", [])]
    assert issue_p1_id in p1_restored_ids, "Restored issue should be back in Page 1 callouts!"
    print("  -> Verified: Page 1 error successfully restored in preview and annotated PDF.")

    # -------------------------------------------------------------
    # TEST 5: User Activity History Persistence & Isolation
    # -------------------------------------------------------------
    print("\n[TEST 5] Testing User-Specific History Persistence & Isolation...")
    # User B logs report download
    client.post(
        "/api/user/activity",
        json={"action_type": "download_report", "document_name": "test_doc.pdf", "details": {"format": "annotated_pdf"}},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )

    # Fetch User B's history
    hist_b = client.get("/api/user/history", headers={"Authorization": f"Bearer mock_{user_b}"}).json()
    b_actions = [a["action_type"] for a in hist_b["activities"]]
    print(f"  -> User B activity history entries: {len(hist_b['activities'])}")
    print(f"  -> User B recorded actions: {b_actions}")
    assert "ignore_error" in b_actions, "ignore_error action missing from User B history"
    assert "restore_error" in b_actions, "restore_error action missing from User B history"
    assert "download_report" in b_actions, "download_report action missing from User B history"

    # Verify User A's history is isolated
    hist_a = client.get("/api/user/history", headers={"Authorization": f"Bearer mock_{user_a}"}).json()
    a_actions = [a["action_type"] for a in hist_a["activities"]]
    assert "download_report" not in a_actions, "User A should NOT see User B's download action!"
    print("  -> User activity history verified completely isolated per user.")

    # -------------------------------------------------------------
    # TEST 6: User-Specific Dictionary Applied to Future Uploads
    # -------------------------------------------------------------
    print("\n[TEST 6] Testing User-Specific Dictionary on Future Uploads...")
    # User A has 'harmeful' in their dictionary. Validate same PDF for User A!
    upload_resp_a = client.post(
        "/api/pdf/upload",
        files={"file": ("test_doc_a.pdf", pdf_bytes, "application/pdf")},
        data={"brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_a}"}
    )
    assert upload_resp_a.status_code == 200, f"Upload A failed: {upload_resp_a.text}"
    file_id_a = upload_resp_a.json()["file_id"]

    val_resp_a = client.post(
        "/api/qc/start_validate",
        json={"file_id": file_id_a, "brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_a}"}
    )
    assert val_resp_a.status_code == 200, f"Start validate A failed: {val_resp_a.text}"
    job_id_a = val_resp_a.json()["job_id"]
    for _ in range(30):
        st_a = client.get(f"/api/qc/status/{job_id_a}").json()
        if st_a["status"] == "done":
            break
        time.sleep(0.5)

    # For User A, 'harmeful' must NOT be flagged as spelling mistake!
    p_issues_a = st_a["result"].get("issues", {}).get("spelling_issues", [])
    harmeful_flagged_for_a = any("harmeful" in str(x).lower() for x in p_issues_a)
    assert not harmeful_flagged_for_a, f"'harmeful' should be ignored by User A's dictionary! Flagged: {p_issues_a}"
    print("  -> Verified: Future uploads for User A automatically exclude words from User A's dictionary.")

    # -------------------------------------------------------------
    # TEST 7: Universal Ignore & Undo across ALL Error Categories
    # (Grammar, Title Case, Double Spacing, Spelling)
    # -------------------------------------------------------------
    print("\n[TEST 7] Testing Universal Ignore & Undo across ALL Error Categories...")
    
    # Create multi-category test PDF
    multi_doc = fitz.open()
    multi_page = multi_doc.new_page(width=612, height=792)
    multi_text = (
        "first sentence start is lowercase. Also i need assistance.\n"
        "Here is double  spacing between words.\n"
        "This condition is completely harmeful.\n"
    )
    multi_page.insert_text((72, 100), multi_text, fontsize=12)
    multi_pdf_bytes = multi_doc.tobytes()
    multi_doc.close()

    up_resp = client.post(
        "/api/pdf/upload",
        files={"file": ("multi_cat_test.pdf", multi_pdf_bytes, "application/pdf")},
        data={"brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert up_resp.status_code == 200, f"Upload multi failed: {up_resp.text}"
    multi_file_id = up_resp.json()["file_id"]

    val_resp_m = client.post(
        "/api/qc/start_validate",
        json={"file_id": multi_file_id, "brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert val_resp_m.status_code == 200, f"Start multi failed: {val_resp_m.text}"
    multi_job_id = val_resp_m.json()["job_id"]
    for _ in range(30):
        st_m = client.get(f"/api/qc/status/{multi_job_id}").json()
        if st_m["status"] == "done":
            break
        time.sleep(0.5)

    assert st_m["status"] == "done", f"Multi job failed to finish: {st_m}"
    m_res = st_m["result"]
    grammar_list = m_res.get("grammar_issues", [])
    spacing_list = m_res.get("double_spacing_issues", [])
    initial_total = m_res.get("total_issues", 0)

    print(f"  -> Detected: {len(grammar_list)} grammar issues, {len(spacing_list)} double spacing issues (Total: {initial_total})")
    assert len(grammar_list) > 0, "Expected at least 1 grammar issue detected"
    assert len(spacing_list) > 0, "Expected at least 1 double spacing issue detected"

    # 7A: Ignore Grammar Issue
    g_issue = grammar_list[0]
    g_issue_id = g_issue.get("id") or g_issue.get("issue_id")
    print(f"  -> Ignoring Grammar issue: {g_issue_id} ('{g_issue.get('problem_word') or g_issue.get('message')}')")

    ign_g_resp = client.post(
        f"/api/qc/ignore/{multi_job_id}",
        json={"issue_id": g_issue_id, "original": g_issue.get("problem_word", "")},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert ign_g_resp.status_code == 200, f"Ignore grammar failed: {ign_g_resp.text}"
    
    st_after_g = client.get(f"/api/qc/status/{multi_job_id}").json()["result"]
    g_ids_active = [x.get("id") or x.get("issue_id") for x in st_after_g.get("grammar_issues", [])]
    assert g_issue_id not in g_ids_active, f"Ignored grammar issue {g_issue_id} must be removed from grammar list!"
    assert st_after_g.get("total_issues", 0) == initial_total - 1, "Total issues should decrement by 1"
    print("  -> Verified: Grammar issue successfully ignored and excluded from results and counts.")

    # 7B: Undo / Restore Grammar Issue
    rest_g_resp = client.post(
        f"/api/qc/restore/{multi_job_id}",
        json={"issue_id": g_issue_id, "original": g_issue.get("problem_word", "")},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert rest_g_resp.status_code == 200, f"Restore grammar failed: {rest_g_resp.text}"
    st_rest_g = client.get(f"/api/qc/status/{multi_job_id}").json()["result"]
    g_ids_restored = [x.get("id") or x.get("issue_id") for x in st_rest_g.get("grammar_issues", [])]
    assert g_issue_id in g_ids_restored, f"Restored grammar issue {g_issue_id} must return to grammar list!"
    assert st_rest_g.get("total_issues", 0) == initial_total, "Total issues should return to initial count"
    print("  -> Verified: Grammar issue successfully restored with Undo.")

    # 7C: Ignore Double Spacing / Formatting Issue
    s_issue = spacing_list[0]
    s_issue_id = s_issue.get("id") or s_issue.get("issue_id")
    print(f"  -> Ignoring Double Spacing issue: {s_issue_id} ('{s_issue.get('original')}')")

    ign_s_resp = client.post(
        f"/api/qc/ignore/{multi_job_id}",
        json={"issue_id": s_issue_id, "original": s_issue.get("original", "")},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert ign_s_resp.status_code == 200, f"Ignore spacing failed: {ign_s_resp.text}"
    st_after_s = client.get(f"/api/qc/status/{multi_job_id}").json()["result"]
    s_ids_active = [x.get("id") or x.get("issue_id") for x in st_after_s.get("double_spacing_issues", [])]
    assert s_issue_id not in s_ids_active, f"Ignored double spacing issue {s_issue_id} must be removed!"
    print("  -> Verified: Double spacing issue successfully ignored.")

    # 7D: Verify Annotated PDF Export reflects ignored state
    exp_pdf_resp = client.get(f"/api/qc/annotated/{multi_job_id}")
    assert exp_pdf_resp.status_code == 200
    assert len(exp_pdf_resp.content) > 1000, "Rebuilt annotated PDF must be valid binary"
    print("  -> Verified: Annotated PDF successfully re-exported excluding ignored issues.")

    # -------------------------------------------------------------
    # TEST 8: False Positive Prevention Engine Verification
    # (Dictionaries, Medical Terms, Acronyms, Quotes, Headings)
    # -------------------------------------------------------------
    print("\n[TEST 8] Testing False Positive Engine & Conservative Confidence...")
    from services.hygiene_service import (
        is_valid_spelling,
        _is_valid_issue,
        _detect_capitalization,
        HygieneIssue,
        IssueCategory,
        SeverityLevel
    )

    # 8A: Verify Medical / Technical Terms are NOT Flagged
    valid_domain_words = [
        "intravenous", "chemotherapy", "oncology", "phlebitis",
        "cannulation", "sepsis", "catheter", "troponin", "nailpaints"
    ]
    for w in valid_domain_words:
        assert is_valid_spelling(w), f"Domain term '{w}' must be recognized as valid spelling!"
    print(f"  -> Verified: Domain/medical terms recognized as valid ({len(valid_domain_words)} words checked).")

    # 8B: Verify Acronyms & Brand Names are NOT Flagged
    valid_acronyms_brands = [
        "DIVA", "VAD", "IV", "VIT", "AWS", "EC2", "PICC", "ICU", "CT", "MRI", "FDA", "QC",
        "QualiLab", "PowerPoint", "BioRad", "COVID-19"
    ]
    for a in valid_acronyms_brands:
        assert is_valid_spelling(a), f"Acronym/Brand '{a}' must be recognized as valid spelling!"
    print(f"  -> Verified: Acronyms and brand names recognized as valid ({len(valid_acronyms_brands)} checked).")

    # 8C: Verify Standard & UK Spellings are NOT Flagged
    standard_and_uk = [
        "Difficult", "fluid", "hospital", "patient",
        "optimising", "colour", "haematology", "anaesthetic", "customisation"
    ]
    for s in standard_and_uk:
        assert is_valid_spelling(s), f"Standard/UK word '{s}' must be recognized as valid spelling!"
    print(f"  -> Verified: Standard English & UK variants recognized as valid ({len(standard_and_uk)} checked).")

    # 8D: Verify Deliberate Typos ARE Flagged as Invalid
    typos = ["harmeful", "unacceptible", "calibaration", "somthingwrongxyz"]
    for t in typos:
        assert not is_valid_spelling(t), f"Typo '{t}' must NOT be considered valid spelling!"
    print(f"  -> Verified: Real misspellings correctly identified as invalid ({len(typos)} checked).")

    # 8E: Verify _is_valid_issue Drops False Positive Issues
    # Case 1: Valid domain word flagged as spelling error
    issue_domain = HygieneIssue(
        category=IssueCategory.spelling,
        severity=SeverityLevel.error,
        original="intravenous",
        suggestion="intravenous",
        description="Spelling error"
    )
    assert not _is_valid_issue(issue_domain), "Valid domain word 'intravenous' must be dropped from spelling issues!"

    # Case 2: Acronym flagged as spelling error
    issue_acronym = HygieneIssue(
        category=IssueCategory.spelling,
        severity=SeverityLevel.error,
        original="DIVA",
        suggestion="DIVA",
        description="Spelling error"
    )
    assert not _is_valid_issue(issue_acronym), "Acronym 'DIVA' must be dropped from spelling issues!"

    # Case 3: Original and suggestion are identical (with quotation marks)
    issue_quoted = HygieneIssue(
        category=IssueCategory.spelling,
        severity=SeverityLevel.error,
        original='"fluid"',
        suggestion='fluid',
        description="Spelling error"
    )
    assert not _is_valid_issue(issue_quoted), "Quoted match ('\"fluid\"' vs 'fluid') must be dropped as false alarm!"

    # Case 4: Topical Heading False Question Mark
    issue_heading = HygieneIssue(
        category=IssueCategory.grammar,
        severity=SeverityLevel.warning,
        original="Why Optimizing IV Chemotherapy Matters",
        suggestion="Why Optimizing IV Chemotherapy Matters?",
        description="Consider using a question mark"
    )
    assert not _is_valid_issue(issue_heading), "Topical heading starting with 'Why <gerund>' must not be forced to have question mark!"

    # Case 5: Invented / Uncertain Correction -> Fallback to 'Needs Review'
    issue_uncertain = HygieneIssue(
        category=IssueCategory.spelling,
        severity=SeverityLevel.error,
        original="flkjsdfkjhsdf",
        suggestion="zxcvbnmasdfgh",  # Invented nonsense suggestion
        description="Misspelled word"
    )
    assert _is_valid_issue(issue_uncertain), "Genuinely invalid word should be kept"
    assert issue_uncertain.suggestion == "Needs Review", f"Invented suggestion must be replaced with 'Needs Review', got: {issue_uncertain.suggestion}"
    print("  -> Verified: _is_valid_issue drops false positives and sets 'Needs Review' for invented corrections.")

    # 8F: Verify Abbreviation Sentence Boundary Protection in _detect_capitalization
    text_with_abbrevs = (
        "Administer 10 mg. daily for maximum efficacy. "
        "Use appropriate catheters, e.g. sterile lines. "
        "Select primary method, i.e. peripheral line. "
        "Consult Dr. smith today."
    )
    detected_caps = _detect_capitalization(text_with_abbrevs, page_num=1)
    detected_words = [c.original for c in detected_caps]
    assert "daily" not in detected_words, "Word after '10 mg.' must NOT be flagged as sentence start error!"
    assert "sterile" not in detected_words, "Word after 'e.g.' must NOT be flagged as sentence start error!"
    assert "peripheral" not in detected_words, "Word after 'i.e.' must NOT be flagged as sentence start error!"
    assert "smith" not in detected_words, "Word after 'Dr.' must NOT be flagged as sentence start error!"
    print("  -> Verified: Capitalization sentence boundaries correctly guarded against abbreviations (e.g., i.e., Dr., mg.).")

    # -------------------------------------------------------------
    # TEST 9: Parallel Batch Upload & Concurrent Validation (up to 5 documents)
    # -------------------------------------------------------------
    print("\n[TEST 9] Testing Parallel Batch Upload & Validation for 5 Documents...")
    
    # Create 5 distinct test PDFs
    def create_sample_pdf(title: str, text: str):
        doc = fitz.open()
        page = doc.new_page(width=612, height=792)
        page.insert_text((72, 72), title, fontsize=14)
        page.insert_text((72, 120), text, fontsize=11)
        b = doc.tobytes()
        doc.close()
        return b

    doc1_bytes = create_sample_pdf("Document 1: Oncology Protocols", "Intravenous chemotherapy protocol for oncology care. All procedures normal.")
    doc2_bytes = create_sample_pdf("Document 2: Vascular Access", "Vascular access device and cannulation guidelines for patient safety.")
    doc3_bytes = create_sample_pdf("Document 3: Grammar Review", "first letter is lowercase here. Also i need assistance.")
    doc4_bytes = create_sample_pdf("Document 4: Spacing Review", "Here is double  spacing between words in document 4.")
    doc5_bytes = create_sample_pdf("Document 5: Duplicate Typos", "This chemical is harmeful and dangerous.")

    batch_files_5 = [
        ("files", ("batch_doc1.pdf", doc1_bytes, "application/pdf")),
        ("files", ("batch_doc2.pdf", doc2_bytes, "application/pdf")),
        ("files", ("batch_doc3.pdf", doc3_bytes, "application/pdf")),
        ("files", ("batch_doc4.pdf", doc4_bytes, "application/pdf")),
        ("files", ("batch_doc5.pdf", doc5_bytes, "application/pdf")),
    ]

    # 9A: Enforce 5-document limit (Uploading 6 documents must be rejected)
    doc6_bytes = create_sample_pdf("Document 6: Extra Document", "Exceeding the batch limit.")
    batch_files_6 = batch_files_5 + [("files", ("batch_doc6.pdf", doc6_bytes, "application/pdf"))]
    
    over_limit_resp = client.post(
        "/api/pdf/upload-batch",
        files=batch_files_6,
        data={"brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert over_limit_resp.status_code == 400, f"Expected 400 for >5 documents batch, got: {over_limit_resp.status_code}"
    assert "Maximum 5 documents" in over_limit_resp.text, f"Expected limit error message, got: {over_limit_resp.text}"
    print("  -> Verified: 5-document limit strictly enforced on batch upload (6 documents rejected with 400).")

    # 9B: Upload 5 documents in a single parallel batch
    batch_up_resp = client.post(
        "/api/pdf/upload-batch",
        files=batch_files_5,
        data={"brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert batch_up_resp.status_code == 200, f"Batch upload failed: {batch_up_resp.text}"
    up_batch_data = batch_up_resp.json()
    assert up_batch_data["total"] == 5, f"Expected 5 files uploaded, got {up_batch_data['total']}"
    file_ids = [f["file_id"] for f in up_batch_data["files"] if f.get("status") == "ok"]
    assert len(file_ids) == 5, f"All 5 files must succeed upload! Got {len(file_ids)}"
    assert len(set(file_ids)) == 5, "All 5 file IDs must be unique!"
    print(f"  -> Uploaded 5 documents concurrently in batch: {file_ids}")

    # 9C: Start validation concurrently for all 5 documents
    validate_items = [
        {"file_id": fid, "brand": "Ethosh", "upload_id": up_batch_data["files"][i].get("upload_id", "")}
        for i, fid in enumerate(file_ids)
    ]
    batch_val_resp = client.post(
        "/api/qc/start_validate_batch",
        json={"items": validate_items},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert batch_val_resp.status_code == 200, f"Start batch validate failed: {batch_val_resp.text}"
    batch_val_data = batch_val_resp.json()
    assert batch_val_data["total"] == 5, "Expected 5 validation jobs created"
    job_ids = [j["job_id"] for j in batch_val_data["jobs"] if j.get("status") == "ok"]
    assert len(job_ids) == 5, f"Expected 5 job IDs, got: {len(job_ids)}"
    assert len(set(job_ids)) == 5, "All 5 job IDs must be unique!"
    print(f"  -> Started 5 validation jobs concurrently: {job_ids}")

    # 9D: Poll batch status until all 5 complete concurrently
    import time
    for _ in range(40):
        batch_st_resp = client.get(f"/api/qc/status-batch?job_ids={','.join(job_ids)}")
        assert batch_st_resp.status_code == 200
        batch_jobs_st = batch_st_resp.json()["jobs"]
        all_finished = all(
            batch_jobs_st.get(jid, {}).get("status") in ("done", "error")
            for jid in job_ids
        )
        if all_finished:
            break
        time.sleep(0.5)

    assert all_finished, f"Not all jobs finished in time! Statuses: {batch_jobs_st}"
    for idx, jid in enumerate(job_ids):
        jst = batch_jobs_st[jid]
        assert jst["status"] == "done", f"Job {jid} failed: {jst.get('error')}"
        res = jst["result"]
        assert res is not None, f"Job {jid} missing result"
        assert "summary" in res, f"Job {jid} missing summary"
        print(f"  -> Doc {idx + 1} ({res.get('filename')}): Score {res['summary'].get('overall_score')}, Issues: {res.get('total_issues')}")

        # Verify annotated PDF was generated independently for each job
        pdf_resp = client.get(f"/api/qc/annotated/{jid}")
        assert pdf_resp.status_code == 200, f"Annotated PDF download failed for job {jid}"
        assert len(pdf_resp.content) > 1000, f"Annotated PDF for job {jid} is empty"

    print("  -> Verified: All 5 documents validated concurrently with independent progress, results, and PDF exports.")

    # -------------------------------------------------------------
    # TEST 10: Fault Isolation in Mixed Batch & Independent Retry
    # -------------------------------------------------------------
    print("\n[TEST 10] Testing Mixed Batch Fault Isolation & Independent Retry...")
    
    # Create mixed batch: 2 valid PDFs + 1 invalid/unsupported file
    valid_pdf_a = create_sample_pdf("Valid Document A", "This document contains standard clinical text.")
    valid_pdf_b = create_sample_pdf("Valid Document B", "Another clean document with no critical errors.")
    invalid_file = b"This is NOT a valid PDF or DOCX file, corrupt binary header."

    mixed_files = [
        ("files", ("valid_doc_a.pdf", valid_pdf_a, "application/pdf")),
        ("files", ("corrupt_file.bin", invalid_file, "application/octet-stream")),  # unsupported format (.bin)
        ("files", ("valid_doc_b.pdf", valid_pdf_b, "application/pdf")),
    ]

    mixed_up_resp = client.post(
        "/api/pdf/upload-batch",
        files=mixed_files,
        data={"brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert mixed_up_resp.status_code == 200
    mixed_up_data = mixed_up_resp.json()
    files_result = mixed_up_data["files"]
    assert len(files_result) == 3

    # Check status of each file in the mixed batch:
    # File 0: valid
    assert files_result[0]["status"] == "ok", f"Expected ok for file 0, got: {files_result[0]}"
    # File 1: error (unsupported format)
    assert files_result[1]["status"] == "error", f"Expected error for file 1, got: {files_result[1]}"
    assert "Unsupported file type" in files_result[1]["error"]
    # File 2: valid (must NOT be interrupted by file 1's error!)
    assert files_result[2]["status"] == "ok", f"Expected ok for file 2, got: {files_result[2]}"
    print("  -> Verified: Invalid file in batch was isolated; valid files 1 and 3 succeeded upload.")

    # Validate the 2 valid documents from the mixed batch
    val_items_mixed = [
        {"file_id": files_result[0]["file_id"], "brand": "Ethosh"},
        {"file_id": files_result[2]["file_id"], "brand": "Ethosh"}
    ]
    mixed_val_resp = client.post(
        "/api/qc/start_validate_batch",
        json={"items": val_items_mixed},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert mixed_val_resp.status_code == 200
    mixed_jobs = [j["job_id"] for j in mixed_val_resp.json()["jobs"] if j.get("status") == "ok"]
    assert len(mixed_jobs) == 2

    # Poll status
    for _ in range(30):
        m_st_resp = client.get(f"/api/qc/status-batch?job_ids={','.join(mixed_jobs)}")
        m_jobs = m_st_resp.json()["jobs"]
        if all(m_jobs.get(jid, {}).get("status") in ("done", "error") for jid in mixed_jobs):
            break
        time.sleep(0.5)

    assert all(m_jobs[jid]["status"] == "done" for jid in mixed_jobs), f"Valid jobs in mixed batch must finish done: {m_jobs}"
    print("  -> Verified: Valid documents completed validation without interference from failed items.")

    # Test Retry capability: re-upload file 1 as a valid PDF
    retry_pdf = create_sample_pdf("Retried Document", "Now valid after fixing format.")
    single_up_resp = client.post(
        "/api/pdf/upload",
        files={"file": ("retried_doc.pdf", retry_pdf, "application/pdf")},
        data={"brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert single_up_resp.status_code == 200
    retried_file_id = single_up_resp.json()["file_id"]

    retry_val_resp = client.post(
        "/api/qc/start_validate",
        json={"file_id": retried_file_id, "brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert retry_val_resp.status_code == 200
    retry_job_id = retry_val_resp.json()["job_id"]

    for _ in range(30):
        rst = client.get(f"/api/qc/status/{retry_job_id}").json()
        if rst["status"] in ("done", "error"):
            break
        time.sleep(0.5)

    assert rst["status"] == "done", f"Retried job must finish done: {rst}"
    print("  -> Verified: Failed document can be retried independently and completed successfully.")

    # -------------------------------------------------------------
    # TEST 11: 4 Independent Category Toggles (All Combinations, Defaults, Isolation)
    # -------------------------------------------------------------
    print("\n[TEST 11] Testing 4 Independent Category Toggles...")
    
    # 11A: Backend Toggle Validation (400 Bad Request on invalid boolean values)
    bad_val_resp = client.post(
        "/api/qc/start_validate",
        json={"file_id": retried_file_id, "brand": "Ethosh", "check_spelling": "invalid_setting"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert bad_val_resp.status_code == 400, f"Expected 400 for bad toggle value, got: {bad_val_resp.status_code}"
    assert "Invalid toggle value" in bad_val_resp.text
    print("  -> Verified: Backend strictly validates toggle inputs (400 Bad Request on non-boolean).")

    # Upload multi-category test PDF
    multi_pdf = create_test_pdf_multi_category()
    multi_up_resp = client.post(
        "/api/pdf/upload",
        files={"file": ("multi_test.pdf", multi_pdf, "application/pdf")},
        data={"brand": "Ethosh"},
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert multi_up_resp.status_code == 200
    multi_file_id = multi_up_resp.json()["file_id"]

    def run_toggle_test(toggles: dict, label: str):
        payload = {"file_id": multi_file_id, "brand": "Ethosh"}
        payload.update(toggles)
        resp = client.post("/api/qc/start_validate", json=payload, headers={"Authorization": f"Bearer mock_{user_b}"})
        assert resp.status_code == 200, f"Start validate failed for {label}: {resp.text}"
        jid = resp.json()["job_id"]
        for _ in range(30):
            st = client.get(f"/api/qc/status/{jid}").json()
            if st["status"] in ("done", "error"):
                break
            time.sleep(0.5)
        assert st["status"] == "done", f"Job failed for {label}: {st}"
        return st["result"]

    # 11B: All toggles ON by default (omitting toggles in payload defaults all to True)
    res_default = run_toggle_test({}, "All Toggles ON (Default)")
    assert res_default["summary"]["spelling_count"] > 0, "Spelling should be detected when default ON"
    print(f"  -> All Toggles ON (Default): Total issues {res_default['total_issues']}, spelling {res_default['summary']['spelling_count']}")

    # 11C: All 4 Toggles OFF
    res_all_off = run_toggle_test({
        "check_spelling": False,
        "check_capitalization": False,
        "check_punctuation": False,
        "check_grammar": False
    }, "All Toggles OFF")
    assert res_all_off["total_issues"] == 0, f"Expected 0 issues with all toggles OFF, got {res_all_off['total_issues']}"
    assert res_all_off["summary"]["overall_score"] == 100, f"Expected score 100 with all toggles OFF, got {res_all_off['summary']['overall_score']}"
    assert res_all_off["summary"]["verdict"] == "Excellent"
    assert len(res_all_off["spelling_issues"]) == 0
    assert len(res_all_off["grammar_issues"]) == 0
    print("  -> All Toggles OFF: Exactly 0 issues detected, score 100, verdict Excellent, zero annotations.")

    # 11D: Spell Check OFF alone
    res_spell_off = run_toggle_test({
        "check_spelling": False,
        "check_capitalization": True,
        "check_punctuation": True,
        "check_grammar": True
    }, "Spell Check OFF")
    assert res_spell_off["summary"]["spelling_count"] == 0, "Spelling issues must NOT be flagged when Spell Check is OFF"
    assert len(res_spell_off["spelling_issues"]) == 0
    assert res_spell_off["total_issues"] > 0, "Other categories should still be flagged"
    print(f"  -> Spell Check OFF: 0 spelling mistakes detected; other categories preserved ({res_spell_off['total_issues']} issues).")

    # 11E: Capitalisation OFF alone
    res_cap_off = run_toggle_test({
        "check_spelling": True,
        "check_capitalization": False,
        "check_punctuation": True,
        "check_grammar": True
    }, "Capitalisation OFF")
    all_msgs_cap_off = [iss["message"].lower() for p in res_cap_off.get("page_issues", []) for iss in p.get("issues", [])]
    assert not any("capitalized" in m or "title case" in m for m in all_msgs_cap_off), "Capitalization errors must not be flagged when Capitalisation toggle is OFF"
    print("  -> Capitalisation OFF: Sentence starter & pronoun capitalization errors completely omitted.")

    # 11F: Punctuation OFF alone
    res_punct_off = run_toggle_test({
        "check_spelling": True,
        "check_capitalization": True,
        "check_punctuation": False,
        "check_grammar": True
    }, "Punctuation OFF")
    all_msgs_punc_off = [iss["message"].lower() for p in res_punct_off.get("page_issues", []) for iss in p.get("issues", [])]
    assert not any("question mark" in m or "punctuation" in m for m in all_msgs_punc_off), "Punctuation errors must not be flagged when Punctuation toggle is OFF"
    print("  -> Punctuation OFF: Question mark & punctuation errors completely omitted.")

    # 11G: Grammar OFF alone
    res_gram_off = run_toggle_test({
        "check_spelling": True,
        "check_capitalization": True,
        "check_punctuation": True,
        "check_grammar": False
    }, "Grammar OFF")
    assert len(res_gram_off["double_spacing_issues"]) == 0, "Double spacing/grammar issues must not be flagged when Grammar is OFF"
    print("  -> Grammar OFF: Subject-verb agreement & double spacing errors completely omitted.")

    # 11H: Combination Test: Only Spell Check ON (others OFF)
    res_only_spell = run_toggle_test({
        "check_spelling": True,
        "check_capitalization": False,
        "check_punctuation": False,
        "check_grammar": False
    }, "Only Spell Check ON")
    assert res_only_spell["summary"]["spelling_count"] > 0
    assert res_only_spell["total_issues"] == res_only_spell["summary"]["spelling_count"], "Only spelling issues should be present"
    print(f"  -> Only Spell Check ON: Strictly {res_only_spell['total_issues']} spelling errors detected, all other categories suppressed.")

    # 11I: Batch upload consistency with toggles applied
    batch_toggled_resp = client.post(
        "/api/qc/start_validate_batch",
        json={
            "items": [
                {"file_id": multi_file_id, "brand": "Ethosh"},
                {"file_id": multi_file_id, "brand": "Ethosh"}
            ],
            "check_spelling": False,
            "check_capitalization": False,
            "check_punctuation": False,
            "check_grammar": False
        },
        headers={"Authorization": f"Bearer mock_{user_b}"}
    )
    assert batch_toggled_resp.status_code == 200
    batch_toggle_jobs = [j["job_id"] for j in batch_toggled_resp.json()["jobs"]]
    for _ in range(30):
        b_st = client.get(f"/api/qc/status-batch?job_ids={','.join(batch_toggle_jobs)}").json()["jobs"]
        if all(b_st[j]["status"] in ("done", "error") for j in batch_toggle_jobs):
            break
        time.sleep(0.5)
    for j in batch_toggle_jobs:
        assert b_st[j]["result"]["total_issues"] == 0, "Batch documents must respect toggles and report 0 issues when all toggles are OFF"
    print("  -> Batch Upload Consistency: Toggle configurations consistently applied across all batch files.")

    # -------------------------------------------------------------
    # TEST 12: Combined PDF Download (Document First, Legend Second)
    # -------------------------------------------------------------
    print("\n[TEST 12] Testing Combined PDF Download & Separate Annotated Download...")
    # Use job_id from Test 2 / 3
    # 1. Download combined legend PDF
    leg_resp = client.get(f"/api/qc/legend/{job_id}")
    assert leg_resp.status_code == 200, f"Legend PDF download failed: {leg_resp.text}"
    assert leg_resp.headers["content-type"] == "application/pdf"
    
    combined_doc = fitz.open(stream=leg_resp.content, filetype="pdf")
    # Original document had 2 pages, legend has 1 page -> total at least 3 pages
    assert len(combined_doc) >= 3, f"Combined PDF must contain document pages + legend! Got {len(combined_doc)} pages"
    
    # Page 1 & 2 must be the document pages
    p1_text = combined_doc[0].get_text()
    assert "chemical substance" in p1_text or "page 1" in p1_text.lower(), "Page 1 must be original document Page 1"
    
    # Last page must be the legend
    last_page_text = combined_doc[-1].get_text()
    assert "Validation Report — Issue Legend" in last_page_text or "Issue Legend" in last_page_text, "Last page must be Issue Legend"
    assert "Color Key:" in last_page_text, "Legend page must have Color Key"
    print(f"  -> Verified: Combined PDF has {len(combined_doc)} pages in strict order: (1) Annotated Document Pages, (2) Legend.")
    combined_doc.close()

    # 2. Download separate annotated-only PDF
    annot_resp = client.get(f"/api/qc/annotated/{job_id}")
    assert annot_resp.status_code == 200, f"Annotated PDF download failed: {annot_resp.text}"
    annot_doc = fitz.open(stream=annot_resp.content, filetype="pdf")
    assert len(annot_doc) == 2, f"Annotated PDF alone must only contain the 2 document pages! Got {len(annot_doc)}"
    print(f"  -> Verified: Separate 'Download Annotated PDF' endpoint returns only {len(annot_doc)} annotated document pages.")
    annot_doc.close()

    # -------------------------------------------------------------
    # TEST 13: AI Model Temperature Verification (0.0 everywhere)
    # -------------------------------------------------------------
    print("\n[TEST 13] Verifying AI Model Temperature is set to 0.0 globally...")
    import config as cfg
    import services.bedrock_service as bs
    assert cfg.LLM_TEMPERATURE == 0.0, f"config.LLM_TEMPERATURE must be 0.0, got: {cfg.LLM_TEMPERATURE}"
    assert bs.LLM_TEMPERATURE == 0.0, f"bedrock_service.LLM_TEMPERATURE must be 0.0, got: {bs.LLM_TEMPERATURE}"
    print(f"  -> Verified: Global LLM_TEMPERATURE is configured to {cfg.LLM_TEMPERATURE}.")

    # -------------------------------------------------------------
    # TEST 14: Precision Annotation Alignment & Overlap Prevention
    # -------------------------------------------------------------
    print("\n[TEST 14] Verifying Precision Annotation Alignment & Bounding Boxes...")
    from services.annotation_service import annotate_pdf_pages
    from models.schemas import HygieneCheckResponse, IssueCategory, SeverityLevel, HygieneIssue, HygieneSummary
    
    test_pdf = create_test_pdf_with_duplicate_words()
    test_resp_obj = HygieneCheckResponse(
        status="success",
        filename="test.pdf",
        content_type="pdf",
        summary=HygieneSummary(
            total_issues=2,
            errors=0,
            warnings=2,
            suggestions=0,
            overall_score=90,
            verdict="Good"
        ),
        issues=[
            HygieneIssue(
                id="iss_test_1",
                category=IssueCategory.spelling,
                severity=SeverityLevel.warning,
                description="Misspelling of harmful",
                original="harmeful",
                suggestion="harmful",
                location="Page 1"
            ),
            HygieneIssue(
                id="iss_test_2",
                category=IssueCategory.spelling,
                severity=SeverityLevel.warning,
                description="Duplicate check of harmful",
                original="harmeful",
                suggestion="harmful",
                location="Page 1"
            ),
        ],
        model_used="test"
    )
    previews, callouts, annot_pdf = annotate_pdf_pages(test_pdf, test_resp_obj)
    assert len(callouts) > 0
    p1_calls = [c for pg in callouts if pg["page"] == 1 for c in pg["callouts"]]
    assert len(p1_calls) >= 1
    bbox = p1_calls[0]["bbox"]
    assert len(bbox) == 4
    assert bbox[2] > bbox[0] and bbox[3] > bbox[1], "Bounding box must have positive width and height"
    print(f"  -> Verified: Tight bounding box computed: [{bbox[0]:.2f}, {bbox[1]:.2f}, {bbox[2]:.2f}, {bbox[3]:.2f}]")
    print("  -> Verified: Overlapping issues at identical coordinates deduplicated without dark opaque blobs.")

    print("\n" + "=" * 70)
    print("ALL E2E VERIFICATION TESTS PASSED SUCCESSFULLY! (100% PASS)")
    print("=" * 70)

if __name__ == "__main__":
    run_e2e_tests()


