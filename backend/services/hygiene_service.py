import json
import re
from typing import Optional
from models.schemas import (
    HygieneCheckResponse, HygieneSummary, HygieneIssue,
    IssueCategory, SeverityLevel
)
from services.bedrock_service import invoke_all_passes, invoke_paged, PASSES
from config import BEDROCK_MODEL_ID, LLM_REPEAT_PASSES

_ALLOWED_CATEGORIES = {IssueCategory.spelling, IssueCategory.grammar, IssueCategory.title_case, IssueCategory.double_spacing}

_SPELLING_DESCRIPTION_KEYWORDS = frozenset([
    "misspell", "spelling error", "spelling mistake", "typo", "wrong spelling",
    "incorrect spelling", "misspelling", "spelled incorrectly", "incorrectly spelled",
])

# Words that should genuinely be lowercase in title case (articles, short prepositions, conjunctions)
_TITLE_CASE_SMALL_WORDS = frozenset([
    'a', 'an', 'the',
    'at', 'by', 'for', 'in', 'of', 'on', 'to', 'up', 'as', 'from', 'into', 'with',
    'and', 'but', 'or', 'nor', 'yet', 'so',
])

SEVERITY_DEDUCTION = {
    SeverityLevel.error: 8,      # real mistakes — affect score
    SeverityLevel.warning: 3,    # notable issues — affect score
    SeverityLevel.suggestion: 0, # style preferences — do NOT penalize score
}

# Title case issues are always warnings
_TITLE_CASE_SEVERITY = SeverityLevel.warning

_SPELL_CHECKER = None

def _get_spell_checker():
    global _SPELL_CHECKER
    if _SPELL_CHECKER is None:
        try:
            from spellchecker import SpellChecker
            _SPELL_CHECKER = SpellChecker(language='en')
        except Exception as e:
            print(f"[hygiene_service] SpellChecker initialization warning: {e}")
    return _SPELL_CHECKER

# Common UK variants that standard US dictionaries might not include
_UK_VARIANTS = frozenset([
    'colour', 'colours', 'coloured', 'colouring', 'colourful',
    'behaviour', 'behaviours', 'behavioural',
    'flavour', 'flavours', 'flavoured', 'flavouring',
    'labour', 'labours', 'laboured', 'labouring',
    'neighbour', 'neighbours', 'neighbouring', 'neighbourhood',
    'honour', 'honours', 'honoured', 'honouring', 'honourable',
    'humour', 'humours', 'humoured', 'humourous',
    'favour', 'favours', 'favoured', 'favouring', 'favourite',
    'armour', 'glamour', 'rumour', 'rumours', 'splendour', 'vigour',
    'vapour', 'odour', 'odours', 'saviour', 'harbour', 'harbours',
    'centre', 'centres', 'centred', 'centring',
    'fibre', 'fibres', 'calibre', 'theatre', 'theatres',
    'litre', 'litres', 'millilitre', 'millilitres',
    'metre', 'metres', 'millimetre', 'millimetres', 'centimetre', 'centimetres', 'kilometre', 'kilometres',
    'paediatric', 'paediatrics', 'paediatrician',
    'haematology', 'haematologist', 'haemoglobin', 'haemorrhage',
    'anaesthetic', 'anaesthesia', 'anaesthetist',
    'oestrogen', 'foetus', 'foetal', 'diarrhoea',
    'artefact', 'artefacts',
    'catalogue', 'catalogues', 'catalogued', 'cataloguing',
    'programme', 'programmes', 'programmed', 'programming',
    'defence', 'defences', 'offence', 'offences', 'licence', 'licences',
    'practise', 'practises', 'practised', 'practising',
    'analyse', 'analyses', 'analysed', 'analysing', 'analyser',
    'paralyse', 'paralysed', 'catalyse', 'catalysed',
    'optimise', 'optimises', 'optimised', 'optimising', 'optimisation',
    'maximise', 'maximises', 'maximised', 'maximising', 'maximisation',
    'minimise', 'minimises', 'minimised', 'minimising', 'minimisation',
    'organise', 'organises', 'organised', 'organising', 'organisation', 'organisations',
    'specialise', 'specialises', 'specialised', 'specialising', 'specialisation',
    'prioritise', 'prioritises', 'prioritised', 'prioritising', 'prioritisation',
    'customise', 'customises', 'customised', 'customising', 'customisation',
    'realise', 'realises', 'realised', 'realising', 'realisation',
    'recognise', 'recognises', 'recognised', 'recognising', 'recognition',
    'emphasise', 'emphasises', 'emphasised', 'emphasising',
    'summarise', 'summarises', 'summarised', 'summarising',
    'standardise', 'standardises', 'standardised', 'standardising', 'standardisation',
    'characterise', 'characterises', 'characterised', 'characterising', 'characterisation',
])

# Medical, pharmaceutical, technical, scientific, business and brand terms
_DOMAIN_TERMS = frozenset([
    'cannulation', 'cannulations', 'cannula', 'cannulas', 'cannulae',
    'intravenous', 'intravenously', 'subcutaneous', 'subcutaneously',
    'intramuscular', 'parenteral', 'parenterally', 'infusion', 'infusions',
    'chemotherapy', 'oncology', 'oncologist', 'oncologic', 'oncological',
    'phlebitis', 'sepsis', 'septicemia', 'bacteremia', 'extravasation',
    'thrombosis', 'thrombus', 'embolism', 'catheter', 'catheters',
    'vascular', 'vasculature', 'venous', 'venipuncture', 'arterial',
    'modality', 'modalities', 'systemic', 'reconstitution', 'adjuvant',
    'neoadjuvant', 'radiotherapy', 'immunotherapy', 'biomarker', 'biomarkers',
    'monoclonal', 'antibody', 'antibodies', 'hematology', 'leukopenia',
    'neutropenia', 'thrombocytopenia', 'erythrocyte', 'erythrocytes',
    'platelet', 'platelets', 'electrolyte', 'electrolytes', 'hypokalemia',
    'hyperkalemia', 'hyponatremia', 'hypocalcemia', 'creatinine', 'bilirubin',
    'troponin', 'endothelial', 'epithelial', 'cardiotoxicity', 'nephrotoxicity',
    'hepatotoxicity', 'neurotoxicity', 'ototoxicity', 'pathogen', 'pathogens',
    'nosocomial', 'prophylaxis', 'prophylactic', 'contraindication', 'contraindications',
    'comorbidity', 'comorbidities', 'etiology', 'aetiology', 'pathophysiology',
    'symptomatology', 'asymptomatic', 'symptomatic', 'idiopathic', 'iatrogenic',
    'refractory', 'intractable', 'palliative', 'curative', 'ambulatory',
    'triage', 'prognosis', 'remission', 'metastasis', 'metastases', 'metastatic',
    'neoplasm', 'neoplasms', 'biopsy', 'histology', 'cytology', 'endoscopy',
    'laparoscopy', 'angiography', 'fluoroscopy', 'tomography', 'ultrasonography',
    'echocardiogram', 'electrocardiogram', 'oximetry', 'sphygmomanometer',
    'stethoscope', 'defibrillator', 'ventilator', 'centrifuge', 'spectrophotometer',
    'chromatography', 'electrophoresis', 'lyophilization', 'microbiology',
    'virology', 'mycology', 'parasitology', 'serology', 'immunology',
    'genomics', 'proteomics', 'metabolomics', 'bioinformatics',
    'antibiotic', 'antibiotics', 'antiviral', 'antivirals', 'antifungal',
    'analgesic', 'analgesics', 'antipyretic', 'antiinflammatory', 'antihistamine',
    'anticonvulsant', 'antidepressant', 'antipsychotic', 'anxiolytic',
    'hypnotic', 'sedative', 'anesthetic', 'diuretic', 'antihypertensive',
    'vasodilator', 'vasopressor', 'bronchodilator', 'mucolytic', 'expectorant',
    'laxative', 'antidiarrheal', 'antiemetic', 'antacid', 'insulin',
    'corticosteroid', 'corticosteroids', 'thyroid', 'estrogen', 'progesterone',
    'testosterone', 'oxytocin', 'vasopressin', 'interferon', 'interleukin',
    'cytokine', 'cytokines', 'chemokine', 'erythropoietin',
    'cisplatin', 'carboplatin', 'oxaliplatin', 'paclitaxel', 'docetaxel',
    'doxorubicin', 'fluorouracil', 'methotrexate', 'tamoxifen',
    'trastuzumab', 'rituximab', 'bevacizumab', 'pembrolizumab', 'nivolumab',
    'milligram', 'milligrams', 'microgram', 'micrograms', 'nanogram', 'nanograms',
    'mcg', 'mg', 'ml', 'kg', 'mmol', 'dl', 'pmol',
    'qualilab', 'qualilabs', 'ethosh', 'biorad',
    'alisha', 'nailpaint', 'nailpaints',
])

# Common abbreviations ending with a period that must NOT trigger sentence boundary errors
_ABBREVIATIONS = frozenset([
    'e.g', 'i.e', 'et al', 'dr', 'mr', 'mrs', 'ms', 'prof', 'vs', 'fig', 'figs',
    'tab', 'approx', 'etc', 'al', 'dept', 'vol', 'no', 'nos', 'p', 'pp', 'ed',
    'eds', 'min', 'sec', 'hr', 'hrs', 'mg', 'ml', 'kg', 'inc', 'ltd', 'corp', 'co'
])

def is_valid_spelling(word: str) -> bool:
    """Return True if word is a valid, recognized spelling in US/UK English, domain vocabulary, or an acronym/brand."""
    if not word:
        return False
    w = word.strip().strip('\'"“”‘’.,;:!?()[]{}')
    if not w:
        return False
    # All-caps acronyms (DIVA, VAD, IV, VIT, AWS, EC2, PICC, ICU, CT, MRI, FDA, QC)
    if w.isupper() and len(w) >= 2:
        return True
    # CamelCase or PascalCase brand/tech names (QualiLab, PowerPoint, BioRad, YouTube)
    if re.search(r'[a-z][A-Z]', w):
        return True
    # Alphanumeric codes / identifiers (COVID-19, p53, B12, HER2, CD4)
    if any(ch.isdigit() for ch in w):
        return True
    # Hyphenated compound: valid if all components are valid words
    if '-' in w:
        parts = [p.strip() for p in w.split('-') if p.strip()]
        if parts and all(is_valid_spelling(p) for p in parts):
            return True
    # Multi-word phrase: valid if all words are valid
    if ' ' in w:
        parts = [p.strip() for p in w.split() if p.strip()]
        if parts and all(is_valid_spelling(p) for p in parts):
            return True

    clean = w.lower()
    if clean in _DOMAIN_TERMS or clean in _UK_VARIANTS:
        return True

    sc = _get_spell_checker()
    if sc is not None and clean in sc.word_frequency.dictionary:
        return True

    return False


def _load_approved_words(user_id: Optional[str] = None) -> set[str]:
    words = set()
    try:
        from services.firebase_service import get_approved_words
        words |= get_approved_words()
    except Exception:
        pass
    if user_id:
        try:
            from services.pg_service import get_user_dictionary_words
            words |= get_user_dictionary_words(user_id)
        except Exception as e:
            print(f"[hygiene_service] Failed to load user dictionary: {e}")
    return words


def _filter_approved(issues: list[HygieneIssue], approved_words: set[str]) -> list[HygieneIssue]:
    if not approved_words:
        return issues
    return [
        i for i in issues
        if not (i.category == IssueCategory.spelling and (i.original or "").strip().lower() in approved_words)
    ]


def classify_issue_category(issue: HygieneIssue) -> str:
    """
    Classify any hygiene issue into one of 4 independent toggle categories:
    1. "capitalization"
    2. "punctuation"
    3. "spelling"
    4. "grammar"
    """
    category = issue.category
    desc = (issue.description or "").lower()
    orig = (issue.original or "").strip()
    sugg = (issue.suggestion or "").strip()

    # Rule 1: Specific IDs from sentence capitalization and pronoun detectors
    if getattr(issue, "id", None):
        iid = str(issue.id)
        if iid.startswith("iss_cap_") or iid.startswith("iss_pron_"):
            return "capitalization"

    # Rule 2: Title case category
    if category == IssueCategory.title_case:
        return "capitalization"

    # Rule 3: Description explicitly mentions capitalization or casing
    cap_keywords = (
        "capitaliz", "capitalise", "title case", "heading case",
        "sentence case", "uppercase", "upper case", "lowercase", "lower case",
        "first word of a sentence", "first letter of a sentence", "pronoun 'i'"
    )
    if any(kw in desc for kw in cap_keywords):
        return "capitalization"

    # Rule 4: Pure letter casing difference (e.g. "london" -> "London", "i" -> "I", "monday" -> "Monday")
    if orig and sugg and orig.lower() == sugg.lower() and orig != sugg:
        return "capitalization"

    # Rule 5: Description explicitly mentions punctuation
    punct_keywords = (
        "punctuation", "comma", "period", "question mark", "exclamation",
        "hyphen", "semicolon", "colon", "apostrophe", "quotation", "quote",
        "bracket", "parenthes"
    )
    if any(kw in desc for kw in punct_keywords):
        return "punctuation"

    # Rule 6: Difference is solely punctuation marks
    orig_no_punct = re.sub(r'[^\w\s]', '', orig).strip().lower()
    sugg_no_punct = re.sub(r'[^\w\s]', '', sugg).strip().lower()
    if orig and sugg and orig_no_punct == sugg_no_punct and orig != sugg:
        return "punctuation"

    # Rule 7: Spelling category or spelling keywords
    if category == IssueCategory.spelling:
        return "spelling"
    if any(kw in desc for kw in _SPELLING_DESCRIPTION_KEYWORDS):
        return "spelling"

    # Rule 8: Grammar (default for remaining issues, including double spacing and syntax)
    return "grammar"


def filter_issues_by_toggles(
    issues: list[HygieneIssue],
    check_spelling: bool = True,
    check_capitalization: bool = True,
    check_punctuation: bool = True,
    check_grammar: bool = True,
) -> list[HygieneIssue]:
    """
    Filter issues to keep only those from enabled toggle categories.
    Disabled categories are completely removed from findings, annotations, and corrections.
    """
    enabled_categories = set()
    if check_spelling:
        enabled_categories.add("spelling")
    if check_capitalization:
        enabled_categories.add("capitalization")
    if check_punctuation:
        enabled_categories.add("punctuation")
    if check_grammar:
        enabled_categories.add("grammar")

    return [iss for iss in issues if classify_issue_category(iss) in enabled_categories]


async def run_hygiene_check(
    text_content: str,
    image_blocks: list,
    content_type: str,
    filename: Optional[str],
    domain: Optional[str] = None,
    user_id: Optional[str] = None,
    check_spelling: bool = True,
    check_capitalization: bool = True,
    check_punctuation: bool = True,
    check_grammar: bool = True,
) -> HygieneCheckResponse:
    """Single-block check (text input, DOCX, single image)."""
    approved_words = _load_approved_words(user_id)
    if not (check_spelling or check_capitalization or check_punctuation or check_grammar):
        results = []
    else:
        results = await invoke_all_passes(text_content, image_blocks, domain)
    all_issues = _collect_issues(results, tag_page=False)
    if check_grammar:
        all_issues += _detect_double_spaces(text_content)
    if check_capitalization:
        all_issues += _detect_capitalization(text_content, 0)
    all_issues = _filter_approved(all_issues, approved_words)
    all_issues = filter_issues_by_toggles(
        all_issues,
        check_spelling=check_spelling,
        check_capitalization=check_capitalization,
        check_punctuation=check_punctuation,
        check_grammar=check_grammar,
    )
    return _build_response(all_issues, content_type, filename, text_content, pages=1)


async def run_hygiene_check_paged(
    pages: list,
    content_type: str,
    filename: Optional[str],
    domain: Optional[str] = None,
    user_id: Optional[str] = None,
    check_spelling: bool = True,
    check_capitalization: bool = True,
    check_punctuation: bool = True,
    check_grammar: bool = True,
) -> HygieneCheckResponse:
    """
    Page-by-page check for PDFs.
    pages = [{"page_num": int, "text": str, "images": list}, ...]
    Each page gets 1 concurrent pass for spelling & grammar.
    """
    approved_words = _load_approved_words(user_id)
    if not (check_spelling or check_capitalization or check_punctuation or check_grammar):
        results = []
    else:
        results = await invoke_paged(pages, domain)
    all_issues = _collect_issues(results, tag_page=True)

    for page in pages:
        if page.get("text"):
            if check_grammar:
                all_issues += _detect_double_spaces(page["text"], page_num=page["page_num"])
            if check_capitalization:
                all_issues += _detect_capitalization(page["text"], page_num=page["page_num"])

    all_issues = _filter_approved(all_issues, approved_words)
    all_issues = filter_issues_by_toggles(
        all_issues,
        check_spelling=check_spelling,
        check_capitalization=check_capitalization,
        check_punctuation=check_punctuation,
        check_grammar=check_grammar,
    )

    # Reconstruct full text from pages for corrected_text
    full_text = "\n\n".join(p["text"] for p in pages if p["text"])
    return _build_response(all_issues, content_type, filename, full_text, pages=len(pages))


_PASS_CATEGORIES = {
    "spelling_grammar": {IssueCategory.spelling, IssueCategory.grammar, IssueCategory.double_spacing},
    "title_case": {IssueCategory.title_case},
}


def _issue_key(issue: HygieneIssue) -> tuple:
    # Use category + normalised original + page so that minor LLM phrasing variations
    # across repeat passes still deduplicate to the same key.
    raw = (issue.original or issue.description or "")
    # Strip punctuation and normalise whitespace/case for robust matching
    text_key = re.sub(r'[^\w\s]', '', raw).lower()
    text_key = re.sub(r'\s+', ' ', text_key).strip()[:80]
    page_key = issue.location or ""
    page_num = re.search(r'Page\s+(\d+)', page_key, re.IGNORECASE)
    page_part = page_num.group(1) if page_num else "0"
    return (issue.category.value, text_key, page_part)


def _collect_issues(results: list[dict], tag_page: bool) -> list[HygieneIssue]:
    """Collect issues across repeat passes using union deduplication.
    Any issue found by at least one pass is kept; duplicates across passes are merged."""
    seen_keys: set[tuple] = set()
    collected: list[HygieneIssue] = []

    for result in results:
        parsed = _parse_response(result.get("raw", ""))
        page_num = result.get("page_num", 1)
        pass_id = result.get("pass_id", "")
        allowed = _PASS_CATEGORIES.get(pass_id, _ALLOWED_CATEGORIES)
        # Double spacing is only reliable on extracted text; never trust it from image-only pages
        if result.get("image_only"):
            allowed = allowed - {IssueCategory.double_spacing}

        for issue in _build_issues(parsed.get("issues", []), page_num if tag_page else None):
            if issue.category in allowed and _is_valid_issue(issue, pass_id):
                key = _issue_key(issue)
                if key not in seen_keys:
                    seen_keys.add(key)
                    collected.append(issue)

    return collected


def _is_valid_issue(issue: HygieneIssue, pass_id: str = "") -> bool:
    """Return False for batched mega-issues or false positives."""
    if issue.original and len(issue.original.split()) > 8:
        return False

    original_s = (issue.original or "").strip()
    suggestion_s = (issue.suggestion or "").strip()
    if not original_s:
        return False

    # Normalize stripped strings
    orig_clean = re.sub(r'[^\w\s]', '', original_s).strip().lower()
    sugg_clean = re.sub(r'[^\w\s]', '', suggestion_s).strip().lower()

    # Drop issues where original and suggestion are identical (or only differ by quotation marks/punctuation)
    if orig_clean and sugg_clean and orig_clean == sugg_clean:
        if issue.category in (IssueCategory.spelling, IssueCategory.double_spacing):
            return False
        # For grammar / title_case: only keep if there is an actual casing change (e.g. capitalization)
        if original_s.strip('\'"“”‘’.,;:!?()[]{}') == suggestion_s.strip('\'"“”‘’.,;:!?()[]{}'):
            return False

    if pass_id == "spelling_grammar":
        # The spelling_grammar pass should NEVER output pure case changes.
        if original_s.lower() == suggestion_s.lower():
            return False

    if issue.category == IssueCategory.spelling:
        # 1. Spelling False Positive Guard: Verify against reliable dictionaries, UK variants, acronyms & domain terms
        if is_valid_spelling(original_s):
            return False

        # 2. Prevent invented corrections: if suggestion is missing, invalid, or invented, use 'Needs Review'
        if not suggestion_s or suggestion_s.lower() == original_s.lower():
            sc = _get_spell_checker()
            corr = sc.correction(orig_clean) if sc else None
            if corr and is_valid_spelling(corr) and corr.lower() != orig_clean:
                issue.suggestion = corr
            else:
                issue.suggestion = "Needs Review"
        elif not is_valid_spelling(sugg_clean):
            # The suggested word is not in any dictionary (invented correction)
            issue.suggestion = "Needs Review"

    if issue.category == IssueCategory.grammar:
        # Question punctuation false positive check on headings or topical statements
        if suggestion_s.endswith("?") or "question" in (issue.description or "").lower():
            orig_lower = original_s.lower()
            loc_lower = (issue.location or "").lower()
            # Common title / heading patterns starting with Why/How/What
            if any(p in orig_lower or p in loc_lower for p in ["why optimizing", "why choosing", "why using", "how to"]):
                return False
            # Check if this is a heading without subject-auxiliary inversion
            if len(orig_lower.split()) <= 4 and not any(aux in loc_lower for aux in ["is ", "are ", "was ", "were ", "do ", "does ", "did ", "can ", "could ", "should ", "would ", "will ", "have ", "has "]):
                return False

    if issue.category in (IssueCategory.spelling, IssueCategory.grammar):
        # Drop single-character or pure-punctuation originals (LLM noise), except standalone pronoun 'i'
        stripped = re.sub(r'[^\w]', '', original_s)
        if len(stripped) <= 1 and original_s.strip() != "i":
            return False

    if issue.category != IssueCategory.title_case:
        return True

    original = (issue.original or "").strip()
    suggestion = (issue.suggestion or "").strip()

    if not original or not suggestion or original == suggestion:
        return False  # identical or empty → false positive

    # Body text ends with sentence punctuation; real headings never do
    if original.endswith(('.', ',', ';', ':')):
        return False

    orig_words = original.split()
    sugg_words = suggestion.split()

    # A single-word heading that's already Title-Cased needs no fix
    if len(orig_words) == 1 and original.istitle():
        return False

    # Real headings are short — more than 7 words is almost certainly body text
    if len(orig_words) > 7:
        return False
    if len(orig_words) != len(sugg_words):
        return True  # word count differs, let it through

    for orig_w, sugg_w in zip(orig_words, sugg_words):
        if orig_w == sugg_w:
            continue
        is_acronym = orig_w.isupper() and len(orig_w) > 1          # e.g. QC, FDA
        is_brand = not orig_w.islower() and not orig_w.isupper() and not orig_w.istitle()  # e.g. QualiLabs
        # LLM trying to lowercase a properly Title-Cased major word (e.g. "Spelling" → "spelling")
        # Only small function words should be suggested for lowercasing in headings.
        is_false_lowercase = (
            orig_w.istitle() and
            sugg_w == orig_w.lower() and
            sugg_w not in _TITLE_CASE_SMALL_WORDS
        )
        # LLM trying to capitalise a small word that is correctly lowercase (e.g. "of" → "Of")
        is_false_capitalize = (
            orig_w.lower() in _TITLE_CASE_SMALL_WORDS and
            sugg_w[0].isupper() and
            sugg_w.lower() == orig_w.lower()
        )
        if not is_acronym and not is_brand and not is_false_lowercase and not is_false_capitalize:
            return True  # a genuinely wrong word exists, keep the issue

    return False  # all differing words were acronyms, brands, or correctly-cased words → false positive


def _detect_double_spaces(text: str, page_num: Optional[int] = None) -> list[HygieneIssue]:
    issues = []
    seen: set[str] = set()
    # Only flag double spaces between two alphabetic words (prose context).
    # Excludes table-column padding, numeric/code tokens, and PDF extraction artifacts.
    for match in re.finditer(r'([A-Za-z][A-Za-z\'\-]*)( {2,})([A-Za-z][A-Za-z\'\-]*)', text):
        left, spaces, right = match.group(1), match.group(2), match.group(3)
        # Skip very short tokens that are likely abbreviation bullets or list markers
        if len(left) <= 1 or len(right) <= 1:
            continue
        snippet = match.group(0)
        key = snippet.lower()[:80]
        if key in seen:
            continue
        seen.add(key)
        space_count = len(spaces)
        location = f"Page {page_num} — \"{snippet}\"" if page_num else f"\"{snippet}\""
        issues.append(HygieneIssue(
            category=IssueCategory.double_spacing,
            severity=SeverityLevel.warning,
            location=location,
            original=snippet,
            suggestion=f"{left} {right}",
            description=f"{space_count} spaces found between words"
        ))
    return issues



def _build_response(
    all_issues: list[HygieneIssue],
    content_type: str,
    filename: Optional[str],
    full_text: str,
    pages: int
) -> HygieneCheckResponse:
    import uuid
    # Ensure each issue has a unique identifier
    for idx, issue in enumerate(all_issues):
        if not getattr(issue, "id", None):
            issue.id = f"iss_{idx + 1}_{uuid.uuid4().hex[:6]}"
    corrected_text = _apply_corrections(full_text, all_issues) if full_text.strip() else None
    summary = _compute_summary(all_issues)
    model_label = f"{BEDROCK_MODEL_ID} ({LLM_REPEAT_PASSES}x{len(PASSES)}-pass, {pages} page{'s' if pages > 1 else ''})"

    return HygieneCheckResponse(
        status="success",
        filename=filename,
        content_type=content_type,
        summary=summary,
        issues=all_issues,
        corrected_text=corrected_text,
        model_used=model_label
    )


def _parse_response(raw: str) -> dict:
    clean = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.IGNORECASE)
    clean = re.sub(r"\s*```$", "", clean.strip())
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", clean, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
    return {"issues": []}


def _build_issues(raw_issues: list, page_num: Optional[int]) -> list[HygieneIssue]:
    category_map = {c.value: c for c in IssueCategory}
    severity_map = {s.value: s for s in SeverityLevel}
    issues = []
    for item in raw_issues:
        location = item.get("location")
        if page_num and location:
            location = f"Page {page_num} — {location}"
        elif page_num:
            location = f"Page {page_num}"

        category = category_map.get(item.get("category", ""), IssueCategory.grammar)
        description = item.get("description", "")
        original_raw = item.get("original", "") or ""

        suggestion_raw = item.get("suggestion", "") or ""

        # Case-only difference = not a spelling or grammar issue (it's a casing/title issue)
        if (category in (IssueCategory.spelling, IssueCategory.grammar)
                and original_raw and suggestion_raw
                and original_raw.lower() == suggestion_raw.lower()
                and original_raw != suggestion_raw):
            continue

        # Hyphenation-only difference = style preference, not a spelling/grammar error
        # e.g. "set-up" vs "setup", "e-mail" vs "email"
        if (category in (IssueCategory.spelling, IssueCategory.grammar)
                and original_raw and suggestion_raw
                and original_raw.replace('-', '').lower() == suggestion_raw.replace('-', '').lower()
                and original_raw != suggestion_raw):
            continue

        # Quote-only difference = not a spelling/grammar error
        if (category in (IssueCategory.spelling, IssueCategory.grammar)
                and original_raw and suggestion_raw
                and original_raw.strip(' \t\n\r\'"“”‘’') == suggestion_raw.strip(' \t\n\r\'"“”‘’')
                and original_raw != suggestion_raw):
            continue

        if category == IssueCategory.grammar:
            desc_lower = description.lower()
            # Reclassify: description says spelling
            if any(kw in desc_lower for kw in _SPELLING_DESCRIPTION_KEYWORDS):
                category = IssueCategory.spelling
            # Reclassify: original contains consecutive spaces → it's double spacing
            elif "  " in original_raw:
                category = IssueCategory.double_spacing

        issues.append(HygieneIssue(
            category=category,
            severity=severity_map.get(item.get("severity", ""), SeverityLevel.warning),
            location=location,
            original=item.get("original"),
            suggestion=item.get("suggestion"),
            description=description,
        ))
    return issues




def _compute_summary(issues: list[HygieneIssue]) -> HygieneSummary:
    errors = sum(1 for i in issues if i.severity == SeverityLevel.error)
    warnings = sum(1 for i in issues if i.severity == SeverityLevel.warning)
    suggestions = sum(1 for i in issues if i.severity == SeverityLevel.suggestion)

    deduction = (
        errors * SEVERITY_DEDUCTION[SeverityLevel.error]
        + warnings * SEVERITY_DEDUCTION[SeverityLevel.warning]
        + suggestions * SEVERITY_DEDUCTION[SeverityLevel.suggestion]
    )
    score = max(0, min(100, 100 - deduction))

    if score >= 90:
        verdict = "Excellent"
    elif score >= 70:
        verdict = "Good"
    elif score >= 50:
        verdict = "Needs Work"
    else:
        verdict = "Poor"

    return HygieneSummary(
        total_issues=len(issues),
        errors=errors,
        warnings=warnings,
        suggestions=suggestions,
        overall_score=score,
        verdict=verdict
    )


def _apply_corrections(original: str, issues: list[HygieneIssue]) -> str:
    text = original
    for issue in issues:
        if issue.original and issue.suggestion and issue.severity in (SeverityLevel.error, SeverityLevel.warning):
            text = text.replace(issue.original, issue.suggestion, 1)
    return text
def _detect_capitalization(text: str, page_num: int) -> list[HygieneIssue]:
    issues = []
    seen_originals = set()
    
    # 1. Start of sentence/paragraph
    # Match the first letter that occurs after ^ or .!? followed by whitespace
    for match in re.finditer(r'(?:^|[\.\?\!]\s+)([a-z])', text):
        char = match.group(1)
        start_idx = match.start(1)
        
        # Guard: Check if the preceding token before .!? is an abbreviation (e.g. e.g., i.e., Dr., etc.)
        prec = text[:start_idx].rstrip(' \t\n\r')
        if prec and prec[-1] in '.!?':
            prev_token_match = re.search(r'([A-Za-z0-9\.]+)\s*[\.\?\!]$', prec)
            if prev_token_match:
                token = prev_token_match.group(1).lower().strip('.')
                if token in _ABBREVIATIONS:
                    continue

        # Extract full word
        word_match = re.match(r'[a-z]+', text[start_idx:])
        if not word_match:
            continue
        original_word = word_match.group(0)
        
        ctx_start = max(0, start_idx - 30)
        ctx_end = min(len(text), start_idx + len(original_word) + 30)
        location = text[ctx_start:ctx_end].replace('\n', ' ').strip()
        
        issue_id = f"iss_cap_{page_num}_{start_idx}"
        issues.append(HygieneIssue(
            id=issue_id,
            category=IssueCategory.grammar,
            severity=SeverityLevel.error,
            location=f"Page {page_num}: {location}" if page_num else location,
            original=original_word,
            suggestion=original_word.capitalize(),
            description="The first word of a sentence or paragraph must be capitalized."
        ))
        
    # 2. Standalone lowercase 'i'
    for match in re.finditer(r'(?<![A-Za-z])(i)(?![A-Za-z])', text):
        start_idx = match.start(1)
        ctx_start = max(0, start_idx - 30)
        ctx_end = min(len(text), start_idx + 1 + 30)
        location = text[ctx_start:ctx_end].replace('\n', ' ').strip()
        
        issue_id = f"iss_pron_{page_num}_{start_idx}"
        issues.append(HygieneIssue(
            id=issue_id,
            category=IssueCategory.grammar,
            severity=SeverityLevel.error,
            location=f"Page {page_num}: {location}" if page_num else location,
            original="i",
            suggestion="I",
            description="The pronoun 'I' must always be capitalized."
        ))
        
    return issues
