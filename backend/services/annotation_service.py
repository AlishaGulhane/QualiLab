import base64
import os
import re
import shutil
from typing import Optional
from models.schemas import HygieneCheckResponse, SeverityLevel, IssueCategory

# Common Windows install locations for Tesseract
_TESS_CANDIDATES = [
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Tesseract-OCR"),
    r"C:\Program Files\Tesseract-OCR",
    r"C:\Program Files (x86)\Tesseract-OCR",
]

def _ensure_tesseract():
    """Add Tesseract to PATH and set TESSDATA_PREFIX if not already on PATH."""
    if shutil.which("tesseract"):
        return
    for candidate in _TESS_CANDIDATES:
        if os.path.isfile(os.path.join(candidate, "tesseract.exe")):
            os.environ["PATH"] = os.environ.get("PATH", "") + os.pathsep + candidate
            os.environ.setdefault("TESSDATA_PREFIX", candidate)
            print(f"[OCR] Tesseract auto-configured from: {candidate}")
            return

# Color per category (R, G, B) — drawn as rectangles on the PDF page
CATEGORY_COLOR = {
    IssueCategory.spelling:       (220, 53,  69),   # red
    IssueCategory.grammar:        (40,  167, 69),   # green
    IssueCategory.double_spacing: (52,  152, 219),  # blue
    IssueCategory.title_case:     (155, 89,  182),  # purple
}


def _search_page(page, text: str, ocr_textpage=None, used_rects: list = None) -> list:
    """Try multiple strategies to locate text on a PDF page with precision bounding boxes."""
    short = text[:40].strip()
    all_words = [w.strip(".,;:\"'()[]") for w in text.split()]
    words = [w for w in all_words if len(w) >= 1]

    def _is_used(r) -> bool:
        if not used_rects: return False
        for ur in used_rects:
            intersect = r & ur
            if not intersect.is_empty:
                inter_area = intersect.get_area()
                min_area = min(r.get_area(), ur.get_area())
                if min_area > 0 and (inter_area / min_area) > 0.6:
                    return True
            if abs(r.x0 - ur.x0) < 3 and abs(r.y0 - ur.y0) < 3:
                return True
        return False

    def _try_text(needle, tp=None):
        if not needle:
            return []
            
        import fitz
        clean_needle = needle.strip(".,;:\"'()[]")
        if not clean_needle:
            return []

        # Single word: prioritize exact whole-word matching from words layer
        if " " not in clean_needle:
            page_words = page.get_text("words", textpage=tp)
            hits = []
            for w in page_words:
                clean_word = w[4].strip(".,;:\"'()[]")
                if clean_word.lower() == clean_needle.lower():
                    r = fitz.Rect(w[:4])
                    if not _is_used(r):
                        hits.append(r)
            if hits:
                return hits

        # For phrases or when exact token is not found in word list (e.g. hyphenated/OCR), standard search
        kwargs = {"quads": False}
        if tp is not None:
            kwargs["textpage"] = tp
            
        hits = page.search_for(needle, **kwargs)
        valid_hits = [h for h in hits if not _is_used(h)]
        if valid_hits: return valid_hits
        
        if needle.lower() != needle:
            hits = page.search_for(needle.lower(), **kwargs)
            valid_hits = [h for h in hits if not _is_used(h)]
            if valid_hits: return valid_hits
        
        if needle.upper() != needle:
            hits = page.search_for(needle.upper(), **kwargs)
            valid_hits = [h for h in hits if not _is_used(h)]
            if valid_hits: return valid_hits
        return []

    def _try_all(tp=None):
        # Full original text
        hits = _try_text(text, tp)
        if hits:
            return hits
        # Truncated
        if short != text and len(short) >= 3:
            hits = _try_text(short, tp)
            if hits:
                return hits
        # For multi-word text, try distinctive words first (longest first, avoiding common short stop words)
        candidate_words = sorted(
            [w for w in words if len(w) >= 3 and w.lower() not in {'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'were', 'been'}],
            key=lambda x: -len(x)
        )
        for word in candidate_words[:5]:
            hits = _try_text(word, tp)
            if hits:
                return hits
        for word in words[:6]:
            hits = _try_text(word, tp)
            if hits:
                return hits
        return []

    # Strategy 1-3: text layer
    hits = _try_all()
    if hits:
        return hits

    # Strategy 4: OCR textpage for image-only pages
    if ocr_textpage is not None:
        hits = _try_all(tp=ocr_textpage)
        if hits:
            return hits

    return []


def _parse_location_page(location: str) -> Optional[int]:
    """Extract the 1-based page number from a location string like 'Page 3' or 'Page 3 — ...'"""
    if not location:
        return None
    m = re.match(r'Page\s+(\d+)', location, re.IGNORECASE)
    return int(m.group(1)) if m else None


def _get_image_rects(page) -> list:
    """Return bounding rects of all embedded images on a PDF page."""
    rects = []
    for img in page.get_images(full=True):
        xref = img[0]
        try:
            for rect in page.get_image_rects(xref):
                rects.append(rect)
        except Exception:
            pass
    return rects


def annotate_pdf_pages(raw_pdf: bytes, result: HygieneCheckResponse) -> tuple[list[str], list[dict], bytes]:
    """
    Search for each issue's original text in the PDF, draw colored boxes,
    and return (annotated_previews_b64, callouts_per_page).

    Tier 1 — LLM bbox:      image-only pages where the LLM returned normalized coords
    Tier 2 — text search:   PyMuPDF text layer + OCR fallback (Tesseract)
    Tier 3 — image region:  issues unresolved by Tiers 1/2 are grouped per page;
                            ONE box is drawn around the largest image region and ONE
                            callout with all unresolved issues is returned for the tooltip.
    """
    try:
        import fitz
    except ImportError:
        return [], [], b""

    doc = fitz.open(stream=raw_pdf, filetype="pdf")
    page_callouts: dict[int, list] = {}
    unresolved_per_page: dict[int, list] = {}  # issues not located by Tier 1 or 2

    _ensure_tesseract()
    page_count = len(doc)
    # Track which pages have no text layer — OCR textpages are built on-demand at
    # search time so they are always created from the live page object, avoiding
    # "weakly-referenced object no longer exists" errors from stale PyMuPDF handles.
    ocr_pages: set[int] = set()
    for page_num in range(page_count):
        page = doc[page_num]
        if not page.get_text().strip():
            ocr_pages.add(page_num)
            print(f"[OCR] Page {page_num+1}: image-only, will OCR on demand")

    used_rects_by_page: dict[int, list] = {}
    drawn_rects_by_page: dict[int, list] = {}

    for issue in result.issues:
        attributed_pn = _parse_location_page(issue.location)

        # Image-only pages: skip text search entirely, always group under orange box.
        # Don't apply the short-original filter here — image issues don't need text search.
        if attributed_pn and 1 <= attributed_pn <= page_count and (attributed_pn - 1) in ocr_pages:
            unresolved_per_page.setdefault(attributed_pn, []).append(issue)
            continue

        if not issue.original or len(issue.original.strip()) < 1:
            continue

        search_text = issue.original.strip()
        color = CATEGORY_COLOR.get(issue.category, (100, 100, 100))
        width = 1.5
        found_in_text_layer = False

        # Tier 1: text layer search + OCR fallback
        # Search the attributed page first so the same word on an earlier text page
        # is not matched ahead of the correct page.
        if not found_in_text_layer:
            pages_to_search = list(range(page_count))
            if attributed_pn and 1 <= attributed_pn <= page_count:
                attr_idx = attributed_pn - 1
                pages_to_search = [attr_idx] + [p for p in pages_to_search if p != attr_idx]

            for page_num in pages_to_search:
                page = doc[page_num]
                ocr_tp = None
                if page_num in ocr_pages:
                    try:
                        ocr_tp = page.get_textpage_ocr(language="eng", dpi=150)
                    except Exception:
                        pass
                page_used = used_rects_by_page.setdefault(page_num, [])
                hits = _search_page(page, search_text, ocr_textpage=ocr_tp, used_rects=page_used)
                if not hits:
                    continue
                hit_rect = hits[0]
                page_used.append(hit_rect)

                # Consistent padding: 1.5 pt horizontal, 1.0 pt vertical
                pad_x, pad_y = 1.5, 1.0
                padded_rect = fitz.Rect(
                    hit_rect.x0 - pad_x,
                    hit_rect.y0 - pad_y,
                    hit_rect.x1 + pad_x,
                    hit_rect.y1 + pad_y
                ) & page.rect

                # Check if a rectangle substantially overlapping this position was already drawn
                page_drawn = drawn_rects_by_page.setdefault(page_num, [])
                already_drawn_rect = None
                for ex in page_drawn:
                    intersect = padded_rect & ex
                    if not intersect.is_empty:
                        inter_area = intersect.get_area()
                        min_area = min(padded_rect.get_area(), ex.get_area())
                        if min_area > 0 and (inter_area / min_area) >= 0.7:
                            already_drawn_rect = ex
                            break

                if already_drawn_rect:
                    # Align to existing drawn box without re-drawing another heavy opaque fill layer
                    padded_rect = already_drawn_rect
                else:
                    page.draw_rect(
                        padded_rect,
                        color=tuple(c / 255 for c in color),
                        width=width,
                        fill=tuple(c / 255 for c in color),
                        fill_opacity=0.12,
                        overlay=True,
                    )
                    page_drawn.append(padded_rect)

                pn = page_num + 1
                issue_id_val = getattr(issue, "id", None) or f"iss_{pn}_{len(page_callouts.get(pn, [])) + 1}"
                page_callouts.setdefault(pn, []).append({
                    "id": issue_id_val,
                    "issue_id": issue_id_val,
                    "type": issue.category.value,
                    "severity": issue.severity.value,
                    "message": issue.description,
                    "msg": issue.description,
                    "original": issue.original,
                    "word": issue.original,
                    "suggestion": issue.suggestion,
                    "bbox": [padded_rect.x0, padded_rect.y0, padded_rect.x1, padded_rect.y1],
                    "rect": [padded_rect.x0, padded_rect.y0, padded_rect.x1, padded_rect.y1],
                    "page_width": page.rect.width,
                    "page_height": page.rect.height,
                    "pageWidth": page.rect.width,
                    "pageHeight": page.rect.height,
                })
                found_in_text_layer = True
                break

        # Not resolved — defer to Tier 3 image-region grouping
        if not found_in_text_layer:
            pn = attributed_pn if (attributed_pn and 1 <= attributed_pn <= page_count) else 1
            unresolved_per_page.setdefault(pn, []).append(issue)

    # Tier 3: group all unresolved issues per page.
    # Use zone-detection logic: draw individual boxes on each image region (same as
    # extract_pdf_zones), not one giant box covering the whole page.
    for pn, issues in sorted(unresolved_per_page.items()):
        page = doc[pn - 1]
        pw, ph = page.rect.width, page.rect.height
        is_image_only = (pn - 1) in ocr_pages
        img_rects = _get_image_rects(page)

        all_issues_data = [
            {
                "id": getattr(i, "id", None),
                "issue_id": getattr(i, "id", None),
                "category": i.category.value,
                "severity": i.severity.value,
                "original": i.original or "",
                "suggestion": i.suggestion or "",
                "description": i.description,
            }
            for i in issues
        ]

        if img_rects:
            # Draw a box on every image zone (mirrors zone detection logic).
            # Use the bounding union of all image rects as the callout anchor.
            x0 = min(r.x0 for r in img_rects)
            y0 = min(r.y0 for r in img_rects)
            x1 = max(r.x1 for r in img_rects)
            y1 = max(r.y1 for r in img_rects)
            for img_rect in img_rects:
                page.draw_rect(
                    img_rect,
                    color=(1.0, 140 / 255, 0),
                    width=2.0,
                    fill=(1.0, 140 / 255, 0),
                    fill_opacity=0.08,
                    overlay=True,
                )
            callout_rect = [x0, y0, x1, y1]
        elif is_image_only:
            # Image-only page where PyMuPDF found no discrete image rects
            # (e.g. full-page XObject). Draw a single inset box like annotate_image_file.
            inset = 6
            full_rect = fitz.Rect(inset, inset, pw - inset, ph - inset)
            page.draw_rect(
                full_rect,
                color=(1.0, 140 / 255, 0),
                width=2.0,
                fill=(1.0, 140 / 255, 0),
                fill_opacity=0.06,
                overlay=True,
            )
            callout_rect = [inset, inset, pw - inset, ph - inset]
        else:
            # Mixed page — image not extractable via get_images(). Draw a full-page
            # inset box so the orange border is visible in the annotated preview.
            inset = 6
            full_rect = fitz.Rect(inset, inset, pw - inset, ph - inset)
            page.draw_rect(
                full_rect,
                color=(1.0, 140 / 255, 0),
                width=2.0,
                fill=(1.0, 140 / 255, 0),
                fill_opacity=0.06,
                overlay=True,
            )
            callout_rect = [inset, inset, pw - inset, ph - inset]

        page_callouts.setdefault(pn, []).append({
            "id": f"iss_img_{pn}",
            "issue_id": f"iss_img_{pn}",
            "type": "image_region",
            "is_image_region": True,
            "all_issues": all_issues_data,
            "message": f"{len(issues)} issue(s) found in image zone(s)",
            "msg": f"{len(issues)} issue(s) found in image zone(s)",
            "bbox": callout_rect,
            "rect": callout_rect,
            "page_width": pw,
            "page_height": ph,
            "pageWidth": pw,
            "pageHeight": ph,
            "in_image": True,
        })

    # Render annotated pages to PNG
    annotated_previews = []
    for page_num in range(page_count):
        page = doc[page_num]
        mat = fitz.Matrix(1.5, 1.5)
        pix = page.get_pixmap(matrix=mat)
        b64 = base64.b64encode(pix.tobytes("png")).decode("utf-8")
        annotated_previews.append(b64)

    pdf_bytes = doc.tobytes(garbage=3, deflate=True)
    doc.close()

    callouts_list = [
        {"page": pg, "callouts": callouts}
        for pg, callouts in sorted(page_callouts.items())
    ]

    return annotated_previews, callouts_list, pdf_bytes


def annotate_image_file(raw: bytes, result: HygieneCheckResponse) -> tuple[list[str], list[dict], bytes]:
    """
    Annotate image documents (PNG, JPEG, etc.) by positioning highlights for each detected issue
    with its correct category color (spelling, grammar, title case, formatting).
    """
    try:
        import fitz
        from PIL import Image
        import io as _io

        img = Image.open(_io.BytesIO(raw))
        w, h = img.size
        img.close()

        pdf_doc = fitz.open()
        page = pdf_doc.new_page(width=w, height=h)
        page.insert_image(page.rect, stream=raw)

        callouts = []
        _ensure_tesseract()

        # Attempt OCR textpage on demand if supported
        ocr_tp = None
        try:
            ocr_tp = page.get_textpage_ocr(language="eng", dpi=150)
        except Exception:
            ocr_tp = None

        used_rects = []
        for idx, iss in enumerate(result.issues):
            issue_id = iss.id or f"iss_img_{idx + 1}"
            search_text = (iss.original or "").strip()
            color = CATEGORY_COLOR.get(iss.category, (220, 53, 69))
            rgb_float = (color[0] / 255.0, color[1] / 255.0, color[2] / 255.0)

            hits = []
            if ocr_tp and search_text:
                hits = _search_page(page, search_text, ocr_textpage=ocr_tp, used_rects=used_rects)

            if hits:
                hit_rect = hits[0]
                used_rects.append(hit_rect)
                pad_x, pad_y = 2.0, 1.5
                rect = fitz.Rect(
                    hit_rect.x0 - pad_x,
                    hit_rect.y0 - pad_y,
                    hit_rect.x1 + pad_x,
                    hit_rect.y1 + pad_y
                ) & page.rect
            else:
                # Position distinct highlight box for each issue cleanly distributed
                margin_x = max(16, int(w * 0.05))
                calc_len = max(len(search_text), 15)
                box_w = min(int(w * 0.9), max(180, calc_len * 10 + 30))
                box_h = max(26, min(36, int(h * 0.06)))
                spacing = box_h + 12
                y0 = min(h - box_h - 10, max(16, 20 + idx * spacing))
                rect = fitz.Rect(margin_x, y0, margin_x + box_w, y0 + box_h)

            page.draw_rect(
                rect,
                color=rgb_float,
                width=1.5,
                fill=rgb_float,
                fill_opacity=0.12,
                overlay=True,
            )

            callouts.append({
                "id": issue_id,
                "issue_id": issue_id,
                "type": iss.category.value,
                "category": iss.category.value,
                "original": iss.original or "",
                "word": iss.original or "",
                "suggestion": iss.suggestion or "",
                "suggested": iss.suggestion or "",
                "message": iss.description,
                "msg": iss.description,
                "bbox": [rect.x0, rect.y0, rect.x1, rect.y1],
                "rect": [rect.x0, rect.y0, rect.x1, rect.y1],
                "page_width": w,
                "page_height": h,
                "pageWidth": w,
                "pageHeight": h,
            })

        mat = fitz.Matrix(1.5, 1.5)
        pix = page.get_pixmap(matrix=mat)
        b64 = base64.b64encode(pix.tobytes("png")).decode("utf-8")
        pdf_bytes = pdf_doc.tobytes(garbage=3, deflate=True)
        pdf_doc.close()

        return [b64], [{"page": 1, "callouts": callouts}], pdf_bytes

    except Exception as e:
        print(f"[annotate_image_file] FAILED — {e}")
        b64 = base64.b64encode(raw).decode("utf-8")
        return [b64], [], b""


def generate_legend_pdf(result: HygieneCheckResponse, filename: str = "") -> bytes:
    """Generate a legend PDF summarising all issues with color key."""
    try:
        import fitz
    except ImportError:
        return b""

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)  # A4

    y = 40
    margin = 40
    col_w = 515

    def write(text, x, y_, size=11, bold=False, color=(0, 0, 0)):
        flags = 1 if bold else 0
        page.insert_text((x, y_), text, fontsize=size, fontname="helv", color=color)
        return y_ + size + 4

    # Title
    y = write("Validation Report — Issue Legend", margin, y, size=16, bold=True)
    if filename:
        y = write(f"File: {filename}", margin, y, size=9, color=(0.4, 0.4, 0.4))
    y += 6

    # Color key
    colors = [
        ((220/255, 53/255,  69/255),  "Spelling — red"),
        ((40/255,  167/255, 69/255),  "Grammar — green"),
        ((52/255,  152/255, 219/255), "Double Spacing — blue"),
        ((155/255, 89/255,  182/255), "Title Case — purple"),
    ]
    y = write("Color Key:", margin, y, size=10, bold=True)
    for rgb, label in colors:
        page.draw_rect(fitz.Rect(margin, y - 9, margin + 16, y + 1), color=rgb, fill=rgb)
        page.insert_text((margin + 22, y), label, fontsize=9, fontname="helv")
        y += 14
    y += 8

    # Issues table header
    y = write(f"Issues ({len(result.issues)} total):", margin, y, size=10, bold=True)
    y += 2

    _CAT_COLOR_PDF = {
        "spelling":       (220/255, 53/255,  69/255),
        "grammar":        (40/255,  167/255, 69/255),
        "double_spacing": (52/255,  152/255, 219/255),
        "title_case":     (155/255, 89/255,  182/255),
    }

    for issue in result.issues:
        if y > 800:
            page = doc.new_page(width=595, height=842)
            y = 40

        cat_color = _CAT_COLOR_PDF.get(issue.category.value, (0.4, 0.4, 0.4))

        page.draw_rect(fitz.Rect(margin, y - 8, margin + 6, y + 2), color=cat_color, fill=cat_color)

        loc = issue.location or "—"
        header = f"[{issue.category.value.upper()}]  {loc}"
        page.insert_text((margin + 12, y), header, fontsize=8, fontname="helv", color=(0.3, 0.3, 0.3))
        y += 12

        desc = issue.description[:120] + ("…" if len(issue.description) > 120 else "")
        page.insert_text((margin + 12, y), desc, fontsize=9, fontname="helv")
        y += 12

        if issue.original:
            orig = f"  Original: {issue.original[:80]}"
            page.insert_text((margin + 12, y), orig, fontsize=8, fontname="helv", color=(0.5, 0.1, 0.1))
            y += 11
        if issue.suggestion:
            sug = f"  Suggestion: {issue.suggestion[:80]}"
            page.insert_text((margin + 12, y), sug, fontsize=8, fontname="helv", color=(0.1, 0.4, 0.1))
            y += 11

        y += 5

    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes
