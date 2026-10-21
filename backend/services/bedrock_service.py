import boto3
import base64
import asyncio
import json
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Optional
from fastapi import HTTPException
from config import (
    AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN, BEDROCK_MODEL_ID, LLM_REPEAT_PASSES,
    LLM_TEMPERATURE
)

MIME_TO_FORMAT = {
    "image/jpeg": "jpeg", "image/jpg": "jpeg",
    "image/png": "png", "image/gif": "gif", "image/webp": "webp",
}

_executor = ThreadPoolExecutor(max_workers=32)

PASSES = [
    {
        "id": "spelling_grammar",
        "label": "Spelling & Grammar",
        "categories": "spelling|grammar|double_spacing",
        "focus": """You are checking ONLY these things — nothing else:

1. SPELLING
   • Use category "spelling". Set "original" to the single misspelled word exactly as it appears.
   • A word should ONLY be flagged when the suggested correction is meaningfully different from the original (e.g., changed letters).
   • NEVER show an error where Original = Correction (or where only case/punctuation/quotes differ).
   • Correct medical, technical, product, and domain-specific words (e.g. intravenous, oncology, chemotherapy, cannulation, catheter, sepsis) MUST remain unflagged. Do not generate a correction just because a word is uncommon.
   • All-caps acronyms (e.g. DIVA, VAD, IV, VIT, EC2, AWS, CT, MRI, ICU) and proper names must NEVER be flagged as spelling errors.
   • NEVER invent artificial or hallucinated corrections. If an ambiguous or likely error exists but the correction is uncertain, set suggestion to "Needs Review".

2. GRAMMAR
   • Use category "grammar". Set "original" to the minimal wrong phrase.
   • DO NOT flag: valid or ambiguous wording, inferred errors, stylistic choices, awkward phrasing, or headings.
   • FLAG AN ERROR ONLY WHEN THERE IS CLEAR GRAMMATICAL EVIDENCE. If you are uncertain, do NOT flag it. Aim for 0 false positives.

3. QUESTION PUNCTUATION
   • Use category "grammar". When a complete sentence is a DIRECT INTERROGATIVE QUESTION starting with why, what, where, how, can, could, would, do, does, is, are, ensure it ends with a ? instead of a period.
   • Flag the missing/incorrect punctuation by setting "original" to the end of the sentence (e.g. "fence.") and "suggestion" to the corrected punctuation (e.g. "fence?").
   • DO NOT flag headings, document titles, slide titles, or bullet points starting with Why, How, What (e.g. "Why Optimizing IV Chemotherapy Matters", "How to Clean the Device"). These are topical titles/headers, NOT direct questions.
   • DO NOT flag words when used in normal declarative statements or noun clauses.

4. DOUBLE SPACING
   • Use category "double_spacing". Set "original" to the two surrounding words with the spaces (e.g. "word1  word2") and "suggestion" to the single-spaced version ("word1 word2").

CATEGORY RULE: misspelled word = "spelling". Grammatically wrong = "grammar". Extra spaces = "double_spacing"."""
    },
    {
        "id": "capitalization",
        "label": "Capitalization",
        "categories": "grammar",
        "focus": """You are checking ONLY capitalization errors. 
Detect capitalization errors word-by-word using the full sentence context.

RULES:
1. SENTENCE STARTERS: The first word after a period (.), question mark (?), exclamation mark (!), or the start of a paragraph MUST start with a capital letter. Flag it if it is lowercase.
2. STANDALONE 'I': The standalone word "i" MUST ALWAYS be flagged and corrected to "I", wherever it appears.
3. PROPER NOUNS: Detect proper nouns and names (e.g., alisha, london, google) and flag them when they are incorrectly lowercase.

DO NOT flag normal lowercase words in the middle of a sentence (unless they are proper nouns or "i").
Do not let the spelling/grammar rules override or suppress capitalization detection.

Use category "grammar". Set "original" to the incorrectly cased word exactly as it appears. Set "suggestion" to the correctly capitalized word."""
    },
    {
        "id": "title_case",
        "label": "Title Case",
        "categories": "title_case",
        "focus": """You are checking ONLY title case errors in standalone headings — nothing else.

A piece of text qualifies for checking ONLY if ALL of the following are true:
  • It stands alone on its own line as a document title, slide title, or section heading.
  • It is visually distinct from body text (larger font, bold, or clearly separated).
  • It is NOT: a sentence, bullet point, numbered list item, table cell, caption, label, footnote, or any phrase embedded inside a paragraph.
  • It does NOT end with a period, comma, colon, or semicolon.
  • You are completely certain it is a standalone heading — if any doubt exists, SKIP IT.

Title case rules (apply only to confirmed headings):
  - First and last words are ALWAYS capitalised.
  - Capitalise all major words: nouns, verbs, adjectives, adverbs, pronouns.
  - Lowercase only: articles (a, an, the), short prepositions (at, by, for, in, of, on, to, up, as, from, into, with), coordinating conjunctions (and, but, or, nor, yet, so).
  - A heading that is ALREADY in correct title case must NOT be flagged — even if you could phrase it differently.
  - A single capitalised word on its own line is CORRECT — do NOT flag it.

CRITICAL — "original": copy the heading text EXACTLY as it appears, character-for-character. Do NOT change any capitalisation.
CRITICAL — Only flag a heading if it is GENUINELY wrong. If it is already correct or if you are unsure, do NOT report it.
PRESERVE acronyms, abbreviations, brand names, and proper nouns exactly as written.
When in doubt, skip it. Fewer false positives are far better than over-flagging.
Only use category "title_case"."""
    },
]


def _get_client():
    kwargs = {"region_name": AWS_REGION}
    if AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY:
        kwargs["aws_access_key_id"] = AWS_ACCESS_KEY_ID
        kwargs["aws_secret_access_key"] = AWS_SECRET_ACCESS_KEY
        if AWS_SESSION_TOKEN:
            kwargs["aws_session_token"] = AWS_SESSION_TOKEN
    return boto3.client("bedrock-runtime", **kwargs)


# ---------------------------------------------------------------------------
# Pre-pass: extract defined abbreviations from the full document
# ---------------------------------------------------------------------------

def _extract_abbreviations_sync(full_text: str) -> str:
    """
    Lightweight LLM call to extract all abbreviations/acronyms defined anywhere
    in the document (inline, footnotes, glossaries, footers).
    Returns a plain-text list to inject into all main passes.
    """
    client = _get_client()
    try:
        response = client.converse(
            modelId=BEDROCK_MODEL_ID,
            system=[{"text": (
                "You are a document parser. Extract every abbreviation or acronym that is "
                "explicitly defined anywhere in this document — inline (e.g. 'Vascular Access Device (VAD)'), "
                "in footnotes, footers, or glossaries. "
                "Return ONLY a JSON object: {\"abbreviations\": [\"VAD\", \"PICC\", ...]}. "
                "No explanation, no markdown."
            )}],
            messages=[{"role": "user", "content": [{"text": full_text}]}],
            inferenceConfig={"maxTokens": 512, "temperature": LLM_TEMPERATURE}
        )
        raw = ""
        for block in response["output"]["message"]["content"]:
            if "text" in block:
                raw = block["text"]
                break
        clean = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.IGNORECASE)
        clean = re.sub(r"\s*```$", "", clean.strip())
        data = json.loads(clean)
        abbrevs = data.get("abbreviations", [])
        if abbrevs:
            return "DEFINED ABBREVIATIONS (do NOT flag these as issues): " + ", ".join(abbrevs)
    except Exception:
        pass
    return ""


async def extract_abbreviations(full_text: str) -> str:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, _extract_abbreviations_sync, full_text)


# ---------------------------------------------------------------------------
# Image transcription pre-pass
# ---------------------------------------------------------------------------

_OCR_SYSTEM = "You are a precise OCR assistant. Transcribe all visible text exactly as written."

_OCR_PROMPT = (
    "You are an OCR assistant. Your ONLY job is to read this image and transcribe "
    "EVERY piece of text visible, exactly as it appears — same spelling, same capitalisation, "
    "same punctuation. Do not paraphrase, correct, or summarise anything.\n\n"
    "Cover ALL regions without exception:\n"
    "• Headings and titles\n"
    "• Body paragraphs and bullet points\n"
    "• Table cells (every row, every column)\n"
    "• Captions, labels, callout boxes\n"
    "• Footnotes, legends, axis labels, watermarks\n"
    "• Any text that is small or partially visible\n\n"
    "Output the raw transcribed text only. No commentary, no explanation."
)


def _transcribe_images_sync(image_blocks: list, prompt: str) -> str:
    """Single OCR pass — temperature=0.0 for deterministic, reproducible output."""
    if not image_blocks:
        return ""
    client = _get_client()
    content = [{"text": prompt}]
    for img in image_blocks:
        fmt = MIME_TO_FORMAT.get(img["mime"], "png")
        img_bytes = base64.b64decode(img["data"])
        content.append({"image": {"format": fmt, "source": {"bytes": img_bytes}}})
    try:
        response = client.converse(
            modelId=BEDROCK_MODEL_ID,
            system=[{"text": _OCR_SYSTEM}],
            messages=[{"role": "user", "content": content}],
            inferenceConfig={"maxTokens": 2048, "temperature": LLM_TEMPERATURE},
        )
        for block in response["output"]["message"]["content"]:
            if "text" in block:
                return block["text"].strip()
    except Exception:
        pass
    return ""


async def transcribe_images(image_blocks: list) -> str:
    """Single OCR pass at temperature=0.0 — deterministic and no duplicate noise."""
    if not image_blocks:
        return ""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, _transcribe_images_sync, image_blocks, _OCR_PROMPT)


# ---------------------------------------------------------------------------
# Main pass invocation
# ---------------------------------------------------------------------------

def _invoke_sync(pass_def: dict, page_num: int, text_content: str,
                 image_blocks: list, domain: Optional[str], abbrev_context: str) -> dict:
    client = _get_client()
    has_text = bool(text_content.strip())

    # spelling_grammar: strip page renders when text is extracted — the model must
    # work from the authoritative text only, not re-read it visually.
    # title_case: keep page renders even when text is extracted — title case is a
    # structural/visual concept (bold, font size, layout) that cannot be inferred
    # from plain text alone. The model needs to see the page to identify headings.
    if has_text and pass_def["id"] == "spelling_grammar":
        image_blocks = [img for img in image_blocks if img.get("embedded")]

    # Double spacing is only meaningful in extracted text — the local regex is the
    # reliable detector. For image-only content, drop double_spacing from the pass
    # so the LLM doesn't guess at spacing it cannot reliably measure visually.
    if not has_text and pass_def["id"] == "spelling_grammar":
        allowed_categories = "spelling|grammar"
        focus = pass_def["focus"].replace(
            "\n3. DOUBLE SPACING — two or more consecutive spaces between words.\n"
            "   • Use category \"double_spacing\". Set \"original\" to the two surrounding words with the spaces (e.g. \"word1  word2\") and \"suggestion\" to the single-spaced version (\"word1 word2\").\n"
            "\nCATEGORY RULE: misspelled or non-existent word = \"spelling\". Correctly spelled but grammatically wrong = \"grammar\". Extra spaces = \"double_spacing\".\n"
            "DO NOT report style, formatting, terminology, punctuation style (Oxford comma, em-dash vs hyphen), or any other category.",
            "\nCATEGORY RULE: misspelled or non-existent word = \"spelling\". Correctly spelled but grammatically wrong = \"grammar\".\n"
            "DO NOT report style, formatting, terminology, punctuation style (Oxford comma, em-dash vs hyphen), double spacing, or any other category."
        )
    else:
        allowed_categories = pass_def.get("categories", "spelling|grammar")
        focus = pass_def["focus"]

    has_images = bool(image_blocks)
    has_ocr_text = "[TEXT EXTRACTED FROM IMAGES]" in text_content
    system_prompt = _build_system_prompt(focus, domain, abbrev_context, allowed_categories, has_images=has_images, has_ocr_text=has_ocr_text)
    content = _build_content(text_content, image_blocks, pass_def["label"], page_num)

    try:
        response = client.converse(
            modelId=BEDROCK_MODEL_ID,
            system=[{"text": system_prompt}],
            messages=[{"role": "user", "content": content}],
            inferenceConfig={"maxTokens": 4096, "temperature": LLM_TEMPERATURE}
        )
        raw_text = ""
        for block in response["output"]["message"]["content"]:
            if "text" in block:
                raw_text = block["text"]
                break
        return {"page_num": page_num, "pass_id": pass_def["id"], "raw": raw_text, "image_only": not has_text}
    except Exception as e:
        return {"page_num": page_num, "pass_id": pass_def["id"], "raw": '{"issues":[]}', "image_only": not has_text, "error": str(e)}


async def invoke_all_passes(text_content: str, image_blocks: list, domain: Optional[str] = None) -> list[dict]:
    """
    Pre-passes: extract abbreviations + transcribe any images.
    Then run all hygiene passes on the combined text (original + transcription).
    Images are also still passed visually so layout/context issues are caught.
    """
    loop = asyncio.get_event_loop()

    # Run abbreviation extraction and image transcription in parallel
    abbrev_task = extract_abbreviations(text_content) if text_content.strip() else asyncio.sleep(0, result="")
    transcription_task = transcribe_images(image_blocks) if image_blocks else asyncio.sleep(0, result="")
    abbrev_context, image_transcription = await asyncio.gather(abbrev_task, transcription_task)

    # Merge original text with image transcription so text passes cover image content too
    enriched_text = text_content
    if image_transcription:
        enriched_text = (text_content + "\n\n[TEXT EXTRACTED FROM IMAGES]\n" + image_transcription).strip()

    tasks = [
        loop.run_in_executor(_executor, _invoke_sync, p, 1, enriched_text, image_blocks, domain, abbrev_context)
        for p in PASSES
        for _ in range(LLM_REPEAT_PASSES)
    ]
    return list(await asyncio.gather(*tasks))


_SPARSE_TEXT_THRESHOLD = 50  # chars; below this a page is treated as image-based


def _page_has_headings(page: dict) -> bool:
    """
    Return True if the page likely contains a standalone heading.
    Uses PyMuPDF span data (font sizes) already stored on the page dict
    under the key 'spans' (list of {text, size} dicts).
    If span data is absent, falls back to True so title_case is never
    skipped when we cannot determine the layout.
    """
    spans = page.get("spans")
    if not spans:
        return True  # no font data — don't skip, play it safe

    sizes = [s["size"] for s in spans if s.get("size")]
    if not sizes:
        return True

    median = sorted(sizes)[len(sizes) // 2]
    # A heading span is at least 20% larger than the median body font size
    return any(s > median * 1.2 for s in sizes)


def _ocr_images_for_page(page: dict) -> list:
    """
    Return the image blocks that should be OCR'd for this page.

    Text pages  → only embedded figures (diagrams/charts whose text is not in
                  the PDF text layer). The full-page render is NOT OCR'd because
                  the extracted text is already authoritative.
    Image pages → the full-page render tiles (the whole page is a raster image
                  and there is no text layer to rely on).
    """
    extracted_text = (page.get("text") or "").strip()
    is_image_page = len(extracted_text) < _SPARSE_TEXT_THRESHOLD

    if is_image_page:
        # Scanned / image-only page — OCR the full-page render tiles
        return page["images"]
    else:
        # Text page — only OCR embedded figures (skip the page-render tiles)
        return [img for img in page["images"] if img.get("embedded")]


async def invoke_paged(pages: list, domain: Optional[str] = None) -> list[dict]:
    """
    For each page:
      1. Determine which images need OCR (image pages: full render; text pages: embedded figures only).
      2. Transcribe those images and merge into page text.
      3. Run all hygiene passes on the enriched text + images concurrently.
    """
    loop = asyncio.get_event_loop()

    # Step 1: OCR only the images that are appropriate for each page type
    page_nums = [page["page_num"] for page in pages]
    ocr_image_sets = [_ocr_images_for_page(page) for page in pages]
    transcription_coros = [
        transcribe_images(imgs) if imgs else asyncio.sleep(0, result="")
        for imgs in ocr_image_sets
    ]
    transcription_results = await asyncio.gather(*transcription_coros)
    transcriptions = dict(zip(page_nums, transcription_results))

    # Step 2: build enriched text for each page
    enriched_pages = []
    full_text_parts = []
    for page in pages:
        img_text = transcriptions.get(page["page_num"], "")
        enriched = page["text"]
        if img_text:
            enriched = (page["text"] + "\n\n[TEXT EXTRACTED FROM IMAGES]\n" + img_text).strip()
        enriched_pages.append({**page, "enriched_text": enriched})
        full_text_parts.append(enriched)

    # Step 3: extract abbreviations from the full enriched document
    full_text = "\n\n".join(t for t in full_text_parts if t)
    abbrev_context = await extract_abbreviations(full_text) if full_text.strip() else ""

    # Step 4: all pages × passes — hygiene check on enriched text + images
    # Skip title_case pass on pages that have no headings (saves one LLM call per such page)
    tasks = [
        loop.run_in_executor(
            _executor, _invoke_sync,
            pass_def, page["page_num"], page["enriched_text"], page["images"], domain, abbrev_context
        )
        for page in enriched_pages
        for pass_def in PASSES
        if pass_def["id"] != "title_case" or _page_has_headings(page)
        for _ in range(LLM_REPEAT_PASSES)
    ]
    return list(await asyncio.gather(*tasks))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_content(text_content: str, image_blocks: list, pass_label: str, page_num: int) -> list:
    content = []
    page_label = f"Page {page_num}" if page_num > 1 else ""
    has_text = bool(text_content.strip())
    has_images = bool(image_blocks)

    # Separate page renders from individually extracted embedded images
    page_renders = [img for img in image_blocks if not img.get("embedded")]
    embedded_imgs = [img for img in image_blocks if img.get("embedded")]

    if has_text:
        header = f"[{page_label}] " if page_label else ""
        content.append({"text": (
            f"{header}Perform a hygiene check ({pass_label}) on the following document content:\n\n{text_content}"
        )})
        if has_images:
            extra = (
                f" Each embedded image is also attached separately at native resolution after the page render."
                if embedded_imgs else ""
            )
            content.append({"text": (
                "IMPORTANT — The page also contains image(s) attached below. "
                "Text inside those images is NOT included in the extracted text above. "
                "You MUST read and inspect EVERY word visible in the images with the SAME rigor as the text above. "
                "Check ALL text in the images: headings, body text, figure text, table text, captions, labels, callout boxes, legends, axis labels, footnotes. "
                "Do NOT skip any text in the images — even small or partially visible text. "
                "Apply the EXACT SAME category rules: "
                "misspelled or nonexistent word = 'spelling', "
                "grammatically wrong word or phrase = 'grammar', "
                "two or more consecutive spaces = 'double_spacing'. "
                f"Report every issue found in BOTH the text above AND the image(s) as separate issue objects.{extra}"
            )})
    elif has_images:
        extra = (
            f" Each embedded image is also attached separately at native resolution after the page render."
            if embedded_imgs else ""
        )
        content.append({"text": (
            f"Perform a hygiene check ({pass_label}) on all text visible in the attached image(s). "
            "You MUST read and inspect EVERY word carefully — headings, body text, captions, labels, callouts, "
            "figure text, table text, legends, axis labels, footnotes. "
            f"Do NOT skip any text, even small or partially visible text.{extra} "
            "Report every issue you find."
        )})

    # First append the full-page render(s) / tiles, then each embedded image with its own label
    for img in page_renders:
        tile_suffix = f" ({img['tile']} half)" if img.get("tile") else ""
        page_label = f"Page {img['page']}" if img.get("page") else "Page"
        label = f"{page_label} — page render{tile_suffix}"
        content.append({"text": f"[{label} — check ALL text visible in this region:]"})
        fmt = MIME_TO_FORMAT.get(img["mime"], "png")
        img_bytes = base64.b64decode(img["data"])
        content.append({"image": {"format": fmt, "source": {"bytes": img_bytes}}})

    for idx, img in enumerate(embedded_imgs, 1):
        label = f"Page {img['page']} — embedded image {idx}" if img.get("page") else f"Embedded image {idx}"
        content.append({"text": f"[{label} — inspect this image individually for text issues:]"})
        fmt = MIME_TO_FORMAT.get(img["mime"], "png")
        img_bytes = base64.b64decode(img["data"])
        content.append({"image": {"format": fmt, "source": {"bytes": img_bytes}}})

    if not content:
        content.append({"text": "No content provided."})

    return content


def _build_system_prompt(focus: str, domain: Optional[str], abbrev_context: str, allowed_categories: str = "spelling|grammar", has_images: bool = False, has_ocr_text: bool = False) -> str:
    domain_note = f"\nThis is a **{domain}** document. Apply domain-appropriate standards." if domain else ""
    abbrev_note = f"\n\n{abbrev_context}" if abbrev_context else ""
    if has_images and allowed_categories == "title_case":
        image_note = (
            "\n\nPAGE RENDER: The page image is attached so you can see the visual layout — font sizes, "
            "bold text, spacing, and structure. Use it to identify which lines are genuine standalone "
            "headings or titles. The extracted text above is the authoritative text source; the image "
            "is only for determining visual structure (what is a heading vs body text)."
        )
    elif has_images:
        image_note = (
            "\n\nEMBEDDED IMAGES: Images attached are embedded figures or diagrams whose text was NOT captured "
            "in the extracted text above. Check only text visible inside those images. "
            "Do NOT re-read or re-interpret the extracted text from the images — use the text provided above as the authoritative source."
        )
    else:
        image_note = ""

    ocr_note = (
        "\n\nOCR TEXT WARNING: Any text under the label [TEXT EXTRACTED FROM IMAGES] was produced by "
        "automated OCR and may contain transcription artefacts — misread characters, merged words, "
        "or garbled symbols. Apply EXTRA caution when checking this section: only flag a word as "
        "misspelled or grammatically wrong if you can be 100% certain it is a real error in the "
        "original document and NOT an OCR artefact. If the word could plausibly be a misread of a "
        "correct word, do NOT flag it."
    ) if has_ocr_text else ""

    return f"""You are an expert document quality analyst with deep knowledge of medical, technical, and business writing.{domain_note}{abbrev_note}{image_note}{ocr_note}

GOLDEN RULE: Only flag an issue when you are 100% certain it is wrong. If there is ANY doubt, do NOT flag it. False positives are worse than missed issues — they erode trust and waste reviewer time.

{focus}

Respond ONLY with a valid JSON object. No markdown fences, no explanation, no text outside the JSON.

JSON structure:
{{
  "issues": [
    {{
      "category": "<{allowed_categories}>",
      "severity": "<error|warning|suggestion>",
      "location": "<the exact sentence or clause containing the error, copied verbatim>",
      "original": "<ONLY the exact wrong word or short phrase — NOT the full sentence. Spelling: just the misspelled word. Grammar: the minimal wrong phrase (1–4 words). MUST be copied character-for-character from the source.>",
      "suggestion": "<corrected version of original only — NOT the full sentence>",
      "description": "<one concise sentence explaining this specific error>"
    }}
  ]
}}

Hard rules:
- Each error is its own separate issue object. NEVER group multiple errors into one.
- "original" must be 5 words or fewer. A sentence with 3 errors = 3 separate issue objects.
- "original" and "suggestion" contain only the specific wrong/fixed fragment, never the full sentence.
- "original" must be copied EXACTLY as it appears — same spelling, capitalisation, punctuation. It is used for search-and-replace.
- Never flag terms in DEFINED ABBREVIATIONS, proper nouns, brand names, product names, or established technical/scientific terms.
- Never flag ALL-CAPS abbreviations, alphanumeric codes, or words valid in any standard English dictionary (US or UK).
- Never flag intentional formatting (ALL CAPS for emphasis, numbered labels).
- If no issues are found, return: {{"issues": []}}"""
