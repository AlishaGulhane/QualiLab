// ========================================
// PDF QC Tool - Main JavaScript
// Complete client-side logic matching app.py
// ========================================

// Import configuration module
import { config, getApiUrl, debugLog, isDevelopment, fetchWithTimeout } from './config.js';

// Brand-specific features configuration
const BRAND_FEATURES = {
    'Ethosh': { fonts: true },
    'Biorad':  { fonts: true },
};

// Application state (mimics Streamlit session_state)
const appState = {
    uploadedFile: null,
    uploadedFileBytes: null,
    fileId: null,
    cachedZones: null,
    cachedPreviews: null,
    cachedZonePreviews: null,  // zone-annotated previews (blue/orange boxes), kept separately from issue previews
    validationDone: false,
    outputPath: null,
    totalIssues: 0,
    pageIssues: [],
    fontsUsed: [],
    detectedSpellingIssues: [],
    detectedCaseViolations: [],
    selectedFont: null,
    highlightEnabled: false,
    fontsData: {},
    lastConfig: {},
    theme: 'dark',
    cancelRequested: false,
    currentBrand: 'Ethosh',
    approvedSpellingWords: new Set(),  // Track approved words in current session
    maxProgressSeen: 0,  // Track maximum progress to prevent backward movement
    ignoredIssueIds: new Set(),  // Track ignored issues for the current review session
    ignoredIssuesData: new Map() // Metadata for restoring ignored issues
};

// Helper function to update progress bar with monotonic guarantee
function updateProgressBar(progress) {
    // Ensure progress only moves forward (monotonic)
    const clampedProgress = Math.max(appState.maxProgressSeen, Math.min(100, Math.max(0, progress)));
    appState.maxProgressSeen = clampedProgress;
    
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    if (progressBar) progressBar.style.width = `${clampedProgress}%`;
    if (progressText) progressText.textContent = `${clampedProgress}%`;
}

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    initializeEventListeners();
    initErrorCategoryTabs();
    // Theme toggle removed: app is now light-mode only.
    // loadTheme();
    updateBrandFeatureDisplay(); // Show initial brand features
    // Load saved user config (persisted preferences)
    loadSavedConfig();
    // Initialize smart tooltip positioning
    initializeSmartTooltips();
    // Pre-load approved words from Firestore and user dictionary
    await loadApprovedWordsFromServer();
    // Load user's upload history on page load (authenticated users only)
    loadUploadHistory();
    // Restore active review session if user refreshed the page
    await restoreActiveReviewFromSession();
});

async function loadApprovedWordsFromServer() {
    try {
        const token = getStoredToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        // Load user's personal dictionary first
        try {
            const userDictResp = await fetch(getApiUrl('/api/user/dictionary'), { headers });
            if (userDictResp.ok) {
                const uData = await userDictResp.json();
                if (Array.isArray(uData.words)) {
                    uData.words.forEach(item => {
                        const word = typeof item === 'string' ? item : item.word;
                        if (word) appState.approvedSpellingWords.add(word);
                    });
                }
            }
        } catch (e) {
            console.warn('Could not load user dictionary:', e);
        }

        // Also load global approved words
        const response = await fetch(getApiUrl('/api/admin/approved_words'));
        if (!response.ok) return;
        const data = await response.json();
        if (Array.isArray(data.words)) {
            data.words.forEach(w => appState.approvedSpellingWords.add(w));
        }
    } catch (err) {
        console.warn('Could not load approved words:', err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload History (user's own session activity)
// ─────────────────────────────────────────────────────────────────────────────

async function loadUploadHistory() {
    const token = getStoredToken();
    if (!token) return; // not logged in — history section stays hidden

    const section = document.getElementById('upload-history-section');
    const tbody   = document.getElementById('upload-history-body');
    const countEl = document.getElementById('upload-history-count');
    if (!section || !tbody) return;

    try {
        const response = await fetch(getApiUrl('/api/user/uploads'), {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return; // silently skip on auth errors

        const data    = await response.json();
        const uploads = data.uploads || [];

        section.style.display = 'block';
        if (countEl) countEl.textContent = uploads.length;

        if (!uploads.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No uploads yet</td></tr>';
            return;
        }

        tbody.innerHTML = uploads.map(u => {
            const status  = u.status || 'unknown';
            // Status badge
            const statusBadge = `<span class="status-badge status-${escapeHistoryHtml(status)}">${escapeHistoryHtml(status)}</span>`;

            // Date
            const uploadedAt = u.uploaded_at
                ? new Date(u.uploaded_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '-';

            return `<tr style="transition:background 0.15s;cursor:default;">
                <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;font-weight:600;color:#1e2875;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHistoryHtml(u.filename || '')}">
                    <span style="display:flex;align-items:center;gap:8px;">
                        <span style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#eef2ff,#e0e7ff);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2B318D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        </span>
                        ${escapeHistoryHtml(u.filename || '-')}
                    </span>
                </td>
                <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;">${statusBadge}</td>
                <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;color:#64748b;font-weight:500;">${escapeHistoryHtml(u.brand_guideline || '-')}</td>
                <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;white-space:nowrap;color:#64748b;font-size:0.8rem;">${uploadedAt}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.warn('Could not load upload history:', err);
    }
}

function escapeHistoryHtml(str) {
    if (typeof str !== 'string') return String(str ?? '');
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

let smartTooltipInitialized = false;

function initializeSmartTooltips() {
    if (smartTooltipInitialized) return;
    smartTooltipInitialized = true;

    // Single global tooltip (avoids duplicate/overlapping tooltips)
    let tooltip = document.getElementById('global-issue-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'global-issue-tooltip';
        tooltip.className = 'global-issue-tooltip';
        document.body.appendChild(tooltip);
    }

    const hideTooltip = () => {
        tooltip.style.display = 'none';
        tooltip.textContent = '';
    };

    document.addEventListener('mousemove', (e) => {
        const issueBox = e.target.closest('.issue-box');
        
        // If hovering over the tooltip itself, keep it visible
        if (e.target.closest('#global-issue-tooltip')) {
            return;
        }
        
        if (!issueBox) {
            hideTooltip();
            return;
        }

        // Don't show hover tooltip if this issue already has a pinned tooltip
        const issueId = issueBox.getAttribute('data-issue-id');
        if (issueId) {
            const hasPinned = document.querySelector(`.pinned-issue-tooltip[data-issue-id="${issueId}"]`);
            if (hasPinned) {
                hideTooltip();
                return;
            }
        }

        // Image regions: hover tooltip suppressed — click opens the pinned tooltip instead
        if (issueBox.dataset.isImageRegion === 'true') {
            hideTooltip();
            return;
        }

        const text = (issueBox.dataset.tooltip || '').trim();
        if (!text) {
            hideTooltip();
            return;
        }

        // Get issue type and metadata
        const issueType = issueBox.dataset.type || 'default';
        const pageNum = issueBox.dataset.pageNum || '?';
        
        // Parse structured message to extract Title, Issues, Suggestion, Note
        let titleText = '';
        let issuesText = '';
        let suggestionText = '';
        let noteText = '';
        
        const lines = text.split('\n');
        lines.forEach(line => {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('Title:')) {
                titleText = trimmedLine.replace('Title:', '').trim().replace(/^['"]|['"]$/g, '');
            } else if (trimmedLine.startsWith('Issues:')) {
                issuesText = trimmedLine.replace('Issues:', '').trim();
            } else if (trimmedLine.startsWith('Suggestion:')) {
                suggestionText = trimmedLine.replace('Suggestion:', '').trim().replace(/^['"]|['"]$/g, '');
            } else if (trimmedLine.startsWith('Note:')) {
                noteText = trimmedLine.replace('Note:', '').trim();
            } else if (trimmedLine.startsWith('Context:')) {
                // For non-design issues
                if (!titleText) titleText = trimmedLine.replace('Context:', '').trim().replace(/^['"]|['"]$/g, '');
            }
        });
        
        // Fallback to dataset if parsing didn't extract anything
        if (!titleText) titleText = issueBox.dataset.original || issueBox.dataset.context || '';
        if (!suggestionText) suggestionText = issueBox.dataset.suggested || '';
        if (!noteText) noteText = issueBox.dataset.note || '';
        
        // Map issue types to user-friendly labels with colors
        const typeInfo = {
            'spelling': { label: 'Spelling Error', color: '#dc3545', icon: 'Aa' },
            'grammar': { label: 'Grammar Issue', color: '#28a745', icon: 'G' },
            'design': { label: 'Design Violation', color: '#ff8c00', icon: 'D' },
            'titlecase': { label: 'Title Case Violation', color: '#9b59b6', icon: 'T' },
            'title_case': { label: 'Title Case Violation', color: '#9b59b6', icon: 'T' },
            'formatting': { label: 'Formatting Issue', color: '#f39c12', icon: 'F' },
            'double_spacing': { label: 'Double Spacing', color: '#3498db', icon: 'Sp' },
            'default': { label: 'Issue Detected', color: '#6c757d', icon: '!' }
        };
        const typeData = typeInfo[issueType] || typeInfo['default'];
        
        // Build formatted tooltip HTML matching the pinned tooltip style
        let formattedHTML = '';
        
        // Add styled header
        formattedHTML += `<div style="padding: 8px; margin: -12px -16px 10px -16px; background: linear-gradient(135deg, ${typeData.color}22, ${typeData.color}11); border-bottom: 2px solid ${typeData.color}44; border-radius: 10px 10px 0 0;">`;
        formattedHTML += `<div style="display: flex; align-items: center; gap: 8px;">`;
        formattedHTML += `<span style="display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: ${typeData.color}; color: white; border-radius: 50%; font-weight: bold; font-size: 12px;">${typeData.icon}</span>`;
        formattedHTML += `<span style="font-weight: 600; color: ${typeData.color}; font-size: 13px;">${typeData.label}</span>`;
        formattedHTML += `<span style="margin-left: auto; font-size: 11px; color: #999; font-weight: 500;">Page ${pageNum}</span>`;
        formattedHTML += `</div></div>`;
        
        // Track whether any structured content was added
        let tooltipContentAdded = false;

        // Image region: show count + click hint
        // For design issues (title case), show Title/Issues/Suggestion/Note matching pinned tooltip
        if (issueType === 'design' && issuesText) {
            // Show Title
            if (titleText && titleText.trim()) {
                formattedHTML += `<div style="background: rgba(77,184,255,0.1); border-left: 3px solid #4db8ff; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #4db8ff;">Title:</strong> <span style="font-style: italic; color: #fff;">"${titleText}"</span></div>`;
            }

            // Show Issues (highlighted word pills)
            const issueWords = issuesText.split(',').map(w => w.trim());
            const issueWordsHTML = issueWords.map(w => `<span style="background: rgba(255,107,107,0.2); padding: 2px 6px; border-radius: 3px; margin: 0 2px; color: #ffeb3b; font-weight: 500;">${w}</span>`).join('');
            formattedHTML += `<div style="background: rgba(255,107,107,0.1); border-left: 3px solid #ff6b6b; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #ff6b6b;">Issues:</strong> ${issueWordsHTML}</div>`;

            // Show Suggestion
            if (suggestionText && suggestionText.trim() && suggestionText !== titleText) {
                formattedHTML += `<div style="background: rgba(102,255,102,0.1); border-left: 3px solid #66ff66; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #66ff66;">Suggestion:</strong> <span style="font-style: italic; color: #b3ffb3;">"${suggestionText}"</span></div>`;
            }

            // Show Note
            if (noteText && noteText.trim()) {
                formattedHTML += `<div style="background: rgba(255,167,38,0.1); border-left: 3px solid #ffa726; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #ffa726;">Note:</strong> <span style="color: #ddd;">${noteText}</span></div>`;
            }
            tooltipContentAdded = true;
        } else if (issueType === 'title_case' || issueType === 'titlecase') {
            // Title case: show the original heading and the corrected version
            const tcOriginal = issueBox.dataset.original || issueBox.dataset.issueText || titleText || '';
            const tcSuggestion = issueBox.dataset.suggested || suggestionText || '';
            if (tcOriginal) {
                formattedHTML += `<div style="background: rgba(155,89,182,0.1); border-left: 3px solid #9b59b6; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #9b59b6;">Original:</strong> <span style="font-style: italic; color: #fff;">"${tcOriginal}"</span></div>`;
                tooltipContentAdded = true;
            }
            if (tcSuggestion && tcSuggestion !== tcOriginal) {
                formattedHTML += `<div style="background: rgba(102,255,102,0.1); border-left: 3px solid #66ff66; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #66ff66;">Suggested:</strong> <span style="font-style: italic; color: #b3ffb3;">"${tcSuggestion}"</span></div>`;
            }
            const tcDesc = issueBox.dataset.tooltip || '';
            if (tcDesc && !tooltipContentAdded) {
                formattedHTML += `<div style="color:#ddd;line-height:1.5;">${tcDesc}</div>`;
                tooltipContentAdded = true;
            }
        } else if (issueType === 'spelling') {
            // Spelling: show the flagged word and suggestions in a single consolidated tooltip
            const spellWord = issueBox.dataset.issueText || titleText || '';
            // Collect suggestions: prefer dataset JSON array, then parse from raw message text
            let spellSuggestions = [];
            try {
                const sugJson = issueBox.dataset.suggestions;
                if (sugJson) spellSuggestions = JSON.parse(sugJson);
            } catch(e) {}
            if (!spellSuggestions.length) {
                const sugMatch = text.match(/Suggestions?:\s*(.+)/i);
                if (sugMatch) spellSuggestions = sugMatch[1].split(/[,;]/).map(s => s.trim()).filter(Boolean);
            }
            
            // Show word + suggestion together (keep only word and suggestion tooltip, no duplicate boxes)
            if (spellWord) {
                const sugHTML = spellSuggestions.slice(0, 5).map(s => `<span style="background: rgba(102,255,102,0.15); padding: 2px 6px; border-radius: 3px; margin: 0 2px; display: inline-block; color: #b3ffb3;">${s}</span>`).join('');
                formattedHTML += `<div style="background: rgba(220,53,69,0.1); border-left: 3px solid #dc3545; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #dc3545;">Original:</strong> <span style="font-style: italic; color: #fff;">"${spellWord}"</span>${sugHTML.length > 0 ? `<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(220,53,69,0.3);"><strong style="color: #66ff66;">Correction:</strong><div style="margin-top: 4px;">${sugHTML}</div></div>` : ''}</div>`;
                tooltipContentAdded = true;
            }
        } else if (issueType === 'double_spacing') {
            // Double spacing: show original, issue description, and corrected version
            const dsOriginal = issueBox.dataset.issueText || issueBox.dataset.original || titleText || '';
            if (dsOriginal) {
                formattedHTML += `<div style="background: rgba(40,167,69,0.1); border-left: 3px solid #28a745; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #28a745;">Original:</strong> <span style="color: #fff; font-style: italic;">"${dsOriginal}"</span></div>`;
                tooltipContentAdded = true;
            }
            const messageText = issueBox.dataset.tooltip || issueBox.dataset.message || 'Double spacing detected';
            if (messageText.includes('spaces') || !tooltipContentAdded) {
                formattedHTML += `<div style="background: rgba(40,167,69,0.1); border-left: 3px solid #28a745; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #28a745;">Issue:</strong> <span style="color: #fff;">${messageText}</span></div>`;
                tooltipContentAdded = true;
            }
            const dsCorrection = issueBox.dataset.suggested;
            if (dsCorrection) {
                formattedHTML += `<div style="background: rgba(102,255,102,0.1); border-left: 3px solid #66ff66; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #66ff66;">Correction:</strong> <span style="color: #b3ffb3; font-style: italic;">"${dsCorrection}"</span></div>`;
            }
        } else {
            // Grammar / formatting / other: show original word then the suggestion
            const grammarOriginal = issueBox.dataset.issueText || issueBox.dataset.original || titleText || '';
            if (grammarOriginal) {
                formattedHTML += `<div style="background: rgba(52,152,219,0.1); border-left: 3px solid #3498db; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #3498db;">Original:</strong> <span style="color: #fff; font-style: italic;">"${grammarOriginal}"</span></div>`;
                tooltipContentAdded = true;
            }

            // Resolve suggestion: prefer parsed tooltip text, then dataset.suggested, then suggestions array
            const singularSuggestion = (suggestionText && suggestionText.trim() && suggestionText.toLowerCase() !== grammarOriginal.toLowerCase())
                ? suggestionText
                : issueBox.dataset.suggested || '';

            if (singularSuggestion) {
                formattedHTML += `<div style="background: rgba(102,255,102,0.1); border-left: 3px solid #66ff66; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #66ff66;">Suggested:</strong> <span style="color: #b3ffb3; font-style: italic;">"${singularSuggestion}"</span></div>`;
                tooltipContentAdded = true;
            } else {
                let grammarSuggestions = [];
                try {
                    const sugJson = issueBox.dataset.suggestions;
                    if (sugJson) grammarSuggestions = JSON.parse(sugJson);
                } catch(e) {}
                if (grammarSuggestions.length) {
                    const sugHTML = grammarSuggestions.slice(0, 5).map(s => `<span style="background: rgba(102,255,102,0.15); padding: 2px 6px; border-radius: 3px; margin: 2px; display: inline-block; color: #b3ffb3;">${s}</span>`).join('');
                    formattedHTML += `<div style="background: rgba(102,255,102,0.1); border-left: 3px solid #66ff66; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #66ff66;">Suggested:</strong><div style="margin-top: 4px;">${sugHTML}</div></div>`;
                    tooltipContentAdded = true;
                }
            }
        }

        // Fallback if no structured content was generated
        if (!tooltipContentAdded) {
            formattedHTML += `<div style="color: #ddd; line-height: 1.5;">${text.replace(/\n/g, '<br>')}</div>`;
        }

        // Add hint for pinning
        formattedHTML += `<div style="margin-top: 12px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 11px; color: #999; text-align: center;">Click to pin this tooltip</div>`;
        
        tooltip.innerHTML = formattedHTML;
        tooltip.style.display = 'block';

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        const rect = tooltip.getBoundingClientRect();
        const tooltipWidth = rect.width;
        const tooltipHeight = rect.height;

        // Anchor tooltip beside the issue box rather than following the cursor.
        // This ensures it appears next to the flagged word/region consistently.
        const boxRect = issueBox.getBoundingClientRect();

        // Default: to the right of the box
        let x = boxRect.right + 14;
        // Vertically centred on the box (clamped later)
        let y = boxRect.top + (boxRect.height / 2) - (tooltipHeight / 2);

        // Flip to the left if it overflows the right edge
        if (x + tooltipWidth > viewportWidth - 10) {
            x = boxRect.left - tooltipWidth - 14;
        }

        x = Math.max(10, Math.min(x, viewportWidth - tooltipWidth - 10));
        y = Math.max(10, Math.min(y, viewportHeight - tooltipHeight - 10));

        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
    });

    // Ensure tooltip doesn't get stuck on page leave
    window.addEventListener('blur', hideTooltip);
    document.addEventListener('scroll', hideTooltip, true);
}


function initializeEventListeners() {
    // Theme toggle removed: app is now light-mode only.
    // const themeToggle = document.getElementById('theme-toggle');
    // if (themeToggle) {
    //     themeToggle.addEventListener('click', toggleTheme);
    // }

    // File upload
    const fileUpload = document.getElementById('file-upload');
    if (fileUpload) {
        fileUpload.addEventListener('change', handleFileUpload);
    }
    
    // Validation buttons
    const runValidationBtn = document.getElementById('run-validation-btn');
    if (runValidationBtn) {
        runValidationBtn.addEventListener('click', runValidation);
    }
    
    const cancelValidationBtn = document.getElementById('cancel-validation-btn');
    if (cancelValidationBtn) {
        cancelValidationBtn.addEventListener('click', cancelValidation);
    }

    const errorToastClose = document.getElementById('error-toast-close');
    if (errorToastClose) {
        errorToastClose.addEventListener('click', hideErrorToast);
    }

    // Hint tooltips: appear while hovering the Spelling Mistakes / Font Explorer cards
    const spellingMistakesSection = document.getElementById('spelling-mistakes-section');
    if (spellingMistakesSection) {
        attachHoverFadeTooltip(spellingMistakesSection, 'Click any word to jump to its page.');
    }

    const fontExplorerSection = document.getElementById('font-explorer-section');
    if (fontExplorerSection) {
        attachHoverFadeTooltip(fontExplorerSection, "Select a font to highlight where it's used in the document");
    }

    // Zone Detection toggle: reveals/hides the thumbnail grid using the
    // zone data already cached from the upload-time fetch (no new request).
    const zonesToggle = document.getElementById('zones-toggle');
    if (zonesToggle) {
        zonesToggle.addEventListener('change', (event) => {
            const previewsContainer = document.getElementById('zone-previews');
            const hint = document.getElementById('zones-toggle-hint');
            if (event.target.checked) {
                renderZoneResults(appState.cachedZones || [], appState.cachedZonePreviews || []);
                if (previewsContainer) {
                    previewsContainer.style.display = '';
                    previewsContainer.classList.add('is-visible');
                }
                if (hint) hint.style.display = 'none';
            } else {
                if (previewsContainer) {
                    previewsContainer.classList.remove('is-visible');
                    previewsContainer.style.display = 'none';
                    previewsContainer.innerHTML = '';
                }
                if (hint) hint.style.display = 'block';
            }
        });
    }

    // Brand selection change
    const brandSelect = document.getElementById('brand-select');
    if (brandSelect) {
        brandSelect.addEventListener('change', handleBrandChange);
    }
    
    // Config change detection
    ['brand-select', 'spell-enabled', 'spell-language'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', onConfigChange);
        }
    });

    // Navigation Tabs (QC Tool, Activity History, My Dictionary)
    const tabButtons = document.querySelectorAll('.nav-tab-btn');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTabId = btn.dataset.tab;
            if (!targetTabId) return;

            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            document.querySelectorAll('.app-tab-panel').forEach(panel => {
                panel.style.display = 'none';
            });
            const targetPanel = document.getElementById(targetTabId);
            if (targetPanel) {
                targetPanel.style.display = 'block';
            }

            if (targetTabId === 'history-view') {
                loadFullUserHistory();
            } else if (targetTabId === 'dictionary-view') {
                loadUserDictionary();
            }
        });
    });

    // History controls
    const refreshHistBtn = document.getElementById('refresh-history-btn');
    if (refreshHistBtn) {
        refreshHistBtn.addEventListener('click', () => loadFullUserHistory(true));
    }
    const histSearch = document.getElementById('history-search-input');
    if (histSearch) {
        histSearch.addEventListener('input', () => filterAndRenderHistory());
    }
    const histFilter = document.getElementById('history-action-filter');
    if (histFilter) {
        histFilter.addEventListener('change', () => filterAndRenderHistory());
    }

    // Dictionary controls
    const dictAddBtn = document.getElementById('dict-add-btn');
    const dictAddInput = document.getElementById('dict-add-input');
    if (dictAddBtn && dictAddInput) {
        dictAddBtn.addEventListener('click', () => handleAddDictionaryWord());
        dictAddInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleAddDictionaryWord();
        });
    }
    const dictSearch = document.getElementById('dict-search-input');
    if (dictSearch) {
        dictSearch.addEventListener('input', () => filterAndRenderDictionary());
    }
}


// Theme toggle removed: app is now light-mode only.
// function toggleTheme() {
//     appState.theme = appState.theme === 'light' ? 'dark' : 'light';
//     document.body.classList.toggle('dark-mode');
//     const btn = document.getElementById('theme-toggle');
//     btn.textContent = appState.theme === 'light' ? '🌙 Dark Mode' : '☀️ Light Mode';
//     localStorage.setItem('theme', appState.theme);
// }

// function loadTheme() {
//     const saved = localStorage.getItem('theme') || 'dark';
//     appState.theme = saved;
//     if (saved === 'dark') {
//         document.body.classList.add('dark-mode');
//         document.getElementById('theme-toggle').textContent = '☀️ Light Mode';
//     }
// }

function handleBrandChange() {
    const brand = document.getElementById('brand-select').value;
    appState.currentBrand = brand;
    updateBrandFeatureDisplay();
}

function updateBrandFeatureDisplay() {
    const brand = appState.currentBrand;
    const features = BRAND_FEATURES[brand];

    // Show/hide sections based on brand features
    const sidebarSections = document.querySelectorAll('.sidebar-section');
    sidebarSections.forEach(section => {
        const h3 = section.querySelector('h3');
        if (h3 && h3.textContent === 'Font Explorer') {
            section.style.display = features.fonts ? 'block' : 'none';
        }
    });
}

async function handleFileUpload(event) {
    const rawFiles = Array.from(event.target.files || []);
    if (!rawFiles || rawFiles.length === 0) return;

    // Reset input value so subsequent file selections fire change event
    event.target.value = '';

    // Accumulate files up to 5 documents without replacing previous ones, preventing duplicates by name & size
    const currentFiles = appState.selectedBatchFiles ? [...appState.selectedBatchFiles] : [];
    for (const f of rawFiles) {
        if (!currentFiles.some(existing => existing.name === f.name && existing.size === f.size)) {
            if (currentFiles.length < 5) {
                currentFiles.push(f);
            } else {
                showToast("Maximum 5 documents allowed per batch. Excess files were not added.", "warning");
                break;
            }
        }
    }

    appState.selectedBatchFiles = currentFiles;
    renderSelectedFilesChips(currentFiles);

    // Check for batch processing (multiple files)
    if (currentFiles.length > 1) {
        await handleBatchUpload(currentFiles);
        return;
    }

    // Single file processing
    const file = currentFiles[0];
    
    // If a previous validation job is running for an older PDF, cancel it immediately.
    // This ensures that uploading a new PDF aborts all backend work associated with the old one.
    if (appState.currentJobId) {
        try {
            appState.cancelRequested = true;
            await fetch(getApiUrl(`/api/qc/cancel/${appState.currentJobId}`), { method: 'POST' });
        } catch (e) {
            console.warn('Failed to cancel previous validation job on new upload:', e);
        } finally {
            // Clear job tracking so the next validation starts cleanly
            appState.currentJobId = null;
            appState.cancelRequested = false;
        }
    }

    // Check if this is a new file
    const newBytes = await file.arrayBuffer();
    if (appState.uploadedFileBytes && arraysEqual(new Uint8Array(newBytes), new Uint8Array(appState.uploadedFileBytes))) {
        return; // Same file, do nothing
    }
    
    // Detect file type
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|tiff|bmp|gif)$/i.test(file.name);
    const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const fileType = isImage ? 'Image' : (isPDF ? 'PDF' : 'File');
    
    const currentBrand = document.getElementById('brand-select').value;

    // New file - clear all state including zone detection
    clearValidationResults();
    appState.uploadedFile = file;
    appState.uploadedFileBytes = newBytes;
    appState.cachedZones = null;
    appState.cachedPreviews = null;
    appState.cachedZonePreviews = null;
    // Reset zone section for new file
    const _zs = document.getElementById('zones-section');
    if (_zs) _zs.style.display = 'none';
    const _zt = document.getElementById('zones-toggle');
    if (_zt) _zt.checked = false;
    const _zp = document.getElementById('zone-previews');
    if (_zp) { _zp.classList.remove('is-visible'); _zp.innerHTML = ''; }
    const _zh = document.getElementById('zones-toggle-hint');
    if (_zh) _zh.style.display = 'block';

    showUploadStatus(`Uploading ${fileType}: ${file.name}...`);

    // Upload file to appropriate backend endpoint
    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('brand', currentBrand);
        const ctSelect = document.getElementById('content-type-select');
        if (ctSelect) formData.append('document_content', ctSelect.value);

        const uploadUrl = '/api/pdf/upload';
        
        const token = getStoredToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch(getApiUrl(uploadUrl), {
            method: 'POST',
            headers,
            body: formData
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || `Upload failed: ${response.statusText}`);
        }
        
        const result = await response.json();
        appState.fileId = result.file_id;
        if (result.upload_id) {
            appState.uploadId = result.upload_id;
        }
        
        // Show appropriate status message
        if (result.compressed) {
            showUploadStatus(`${fileType} uploaded and compressed: ${result.original_size_mb}MB → ${result.compressed_size_mb}MB`);
        } else {
            showUploadStatus(`${fileType} uploaded: ${file.name}`);
        }

        // Refresh upload history from DB
        loadUploadHistory();

        // Show status section
        document.getElementById('status-section').style.display = 'block';
        document.getElementById('status-text').textContent = '';

        {
            // For PDFs, read the document-content dropdown for OCR preference.
            // Both "hybrid" (text + images) and "image" (image-only/scanned PDFs)
            // need OCR, so both map to the same run_pdf_ocr=true backend flag.
            if (isPDF) {
                const contentTypeSelect = document.getElementById('content-type-select');
                const contentTypeValue = contentTypeSelect ? contentTypeSelect.value : 'text';
                const wantHybrid = contentTypeValue === 'hybrid' || contentTypeValue === 'image';
                appState.preferHybrid = wantHybrid;
                let ocrStatusMsg = 'Text-only extraction enabled';
                if (contentTypeValue === 'hybrid') ocrStatusMsg = 'Hybrid OCR enabled (text + images)';
                else if (contentTypeValue === 'image') ocrStatusMsg = 'Image-only OCR enabled';
                showUploadStatus(ocrStatusMsg);
            } else {
                appState.preferHybrid = false;
            }
            // Fetch zones (PDF only)
            await fetchZones();

            // Extract fonts (PDF only)
            await extractFonts();
        }
        
    } catch (error) {
        console.error('Upload error:', error);
        showUploadStatus(`Error: ${error.message}`, 'error');
    }
}


async function fetchZones() {
    if (!appState.fileId) return;

    try {
        showUploadStatus('Detecting zones...');
        const response = await fetch(getApiUrl(`/api/pdf/zones/${appState.fileId}`));
        if (!response.ok) throw new Error('Failed to fetch zones');

        const data = await response.json();
        appState.cachedZones = data.zones;
        appState.cachedPreviews = data.previews;
        appState.cachedZonePreviews = data.previews; // keep zone previews independently of issue previews

        // Show zone detection section with toggle OFF by default
        const zonesSection = document.getElementById('zones-section');
        const zonesToggle = document.getElementById('zones-toggle');
        const previewsContainer = document.getElementById('zone-previews');
        const hint = document.getElementById('zones-toggle-hint');
        if (zonesSection) zonesSection.style.display = 'block';
        if (zonesToggle) zonesToggle.checked = false;
        if (hint) hint.style.display = 'block';
        if (previewsContainer) previewsContainer.classList.remove('is-visible');

        showUploadStatus('Zone detection complete');

    } catch (error) {
        console.error('Zone fetch error:', error);
    }
}

async function extractFonts() {
    // Load font explorer with actual font data
    if (appState.fileId) {
        await loadFontExplorer();
    }
}

// Renders the zone thumbnail grid from already-cached upload-time data
// (appState.cachedZones / appState.cachedPreviews) — no new API call.
function renderZoneResults(zones, previews) {
    const previewsContainer = document.getElementById('zone-previews');
    if (!previewsContainer) return;
    previewsContainer.innerHTML = '';

    (previews || []).forEach((b64, index) => {
        if (!b64) return;
        const pageNum = index + 1;

        const item = document.createElement('div');
        item.className = 'zone-preview-item';
        item.addEventListener('click', () => openPreviewPage(pageNum));

        item.innerHTML = `
            <img src="data:image/png;base64,${b64}" alt="Page ${pageNum}">
            <div class="zone-caption">Page ${pageNum}</div>
        `;

        previewsContainer.appendChild(item);
    });
}

// Open the preview section and focus a specific page number (case: pages may not yet be rendered)
function openPreviewPage(pageNum) {
    console.log('[openPreviewPage] Called with pageNum:', pageNum);
    if (!pageNum) {
        console.warn('[openPreviewPage] No page number provided');
        return;
    }

    // Ensure preview section is visible and (re)render previews using cachedPreviews
    const previewSection = document.getElementById('preview-section');
    if (!previewSection) {
        console.error('[openPreviewPage] Preview section not found');
        return;
    }
    previewSection.style.display = 'block';
    renderAnnotatedPreview();
    console.log('[openPreviewPage] Preview section shown and rendered');

    // Allow a short delay for DOM to update
    setTimeout(() => {
        const pages = document.querySelectorAll('.preview-page-container');
        if (!pages || pages.length === 0) return;

        pages.forEach(pc => {
            const pnum = parseInt(pc.dataset.pageNum || pc.dataset.page, 10);
            if (pnum === pageNum) {
                // Hide other pages
                pages.forEach(other => {
                    if (other !== pc) {
                        other.style.display = 'none';
                        other.dataset.collapsed = 'true';
                        const prevHdr = other.querySelector('.preview-page-header .expand-icon');
                        if (prevHdr) prevHdr.textContent = '▶';
                        const prevImg = other.querySelector('.img-wrapper');
                        if (prevImg) prevImg.style.display = 'none';
                        other.classList.remove('active');
                    }
                });

                // Show target page
                pc.style.display = 'block';
                pc.dataset.collapsed = 'false';
                const hdr = pc.querySelector('.preview-page-header .expand-icon');
                if (hdr) hdr.textContent = '▼';
                const imgw = pc.querySelector('.img-wrapper');
                if (imgw) imgw.style.display = 'block';
                pc.classList.add('active');
                pc.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

                const cur = document.getElementById('current-page');
                if (cur) cur.textContent = String(pageNum);
            }
        });
    }, 120);
}

function getStoredToken() {
    // Primary: session stored by auth.js
    try {
        const raw = localStorage.getItem('auth_session');
        if (raw) {
            const session = JSON.parse(raw);
            if (session?.access_token) return session.access_token;
        }
    } catch (_) {}
    // Fallback: legacy key
    return localStorage.getItem('auth_token') || null;
}

function showFeedbackModal() {
    if (!appState.uploadId) {
        console.log('Skipping feedback: no upload_id tracked');
        return;
    }

    const section = document.getElementById('feedback-section');
    if (!section) return;
    section.style.display = 'block';

    const stars = section.querySelectorAll('.star');
    const submitBtn = document.getElementById('feedback-submit-btn');
    const skipBtn = document.getElementById('feedback-skip-btn');
    const commentEl = document.getElementById('feedback-comment');
    const thanksEl = document.getElementById('feedback-thanks');

    let selectedRating = 0;

    stars.forEach(st => st.classList.remove('active', 'hover'));
    commentEl.value = '';
    thanksEl.style.display = 'none';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit';
    section.querySelector('.feedback-header').style.display = 'flex';
    section.querySelector('.star-rating').style.display = 'flex';
    commentEl.style.display = 'block';
    section.querySelector('.feedback-actions').style.display = 'flex';

    stars.forEach(s => {
        s.addEventListener('click', () => {
            selectedRating = parseInt(s.dataset.value);
            stars.forEach(st => {
                st.classList.toggle('active', parseInt(st.dataset.value) <= selectedRating);
            });
        });
        s.addEventListener('mouseenter', () => {
            const val = parseInt(s.dataset.value);
            stars.forEach(st => {
                st.classList.toggle('hover', parseInt(st.dataset.value) <= val);
            });
        });
        s.addEventListener('mouseleave', () => {
            stars.forEach(st => st.classList.remove('hover'));
        });
    });

    submitBtn.addEventListener('click', async () => {
        if (selectedRating === 0) {
            alert('Please select a rating');
            return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';
        try {
            const token = getStoredToken();
            if (!token) {
                console.warn('No auth token, skipping feedback');
                section.style.display = 'none';
                return;
            }
            const response = await fetch(getApiUrl('/api/feedback'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    upload_id: appState.uploadId || '',
                    rating: selectedRating,
                    comment: commentEl.value.trim(),
                }),
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to submit feedback');
            }
            section.querySelector('.feedback-header').style.display = 'none';
            section.querySelector('.star-rating').style.display = 'none';
            commentEl.style.display = 'none';
            section.querySelector('.feedback-actions').style.display = 'none';
            thanksEl.style.display = 'block';
            setTimeout(() => { section.style.display = 'none'; }, 2500);
        } catch (err) {
            console.error('Feedback error:', err);
            alert('Failed to submit feedback. Please try again.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit';
        }
    });

    skipBtn.addEventListener('click', () => { section.style.display = 'none'; });
}

async function runValidation() {
    if (appState.selectedBatchFiles && appState.selectedBatchFiles.length > 1) {
        await handleBatchUpload(appState.selectedBatchFiles);
        return;
    }

    if (!appState.fileId) {
        showErrorToast('Please upload a document to run validation.');
        return;
    }
    
    // Reset validation state
    appState.validationDone = false;
    appState.cancelRequested = false;
    clearValidationResults();
    
    const brand = document.getElementById('brand-select').value;
    const spellEnabled = document.getElementById('spell-enabled').checked;
    
    // Show loader
    document.getElementById('loader').style.display = 'flex';
    document.getElementById('status-text').textContent = 'Running validation...';
    // Reset progress tracking and bar to start at 0%
    appState.maxProgressSeen = 0;
    try {
        updateProgressBar(0);
        document.getElementById('validation-progress').style.display = 'flex';
    } catch (e) {}

    try {
        await runPDFValidation(brand, spellEnabled);
    } catch (error) {
        console.error(' Validation error:', error);
        showErrorToast(`Validation failed: ${error.message}`);
    } finally {
        // Hide loader and reset buttons
        document.getElementById('loader').style.display = 'none';
        const runBtn = document.getElementById('run-validation-btn');
        const cancelBtn = document.getElementById('cancel-validation-btn');
        runBtn.disabled = false;
        runBtn.classList.remove('btn-running');
        runBtn.style.display = 'inline-block';
        cancelBtn.disabled = true;
        cancelBtn.classList.remove('btn-cancelling');
        cancelBtn.classList.add('btn-secondary');
        cancelBtn.style.display = 'none';
    }
}


/**
 * Read the state of the 4 independent validation category toggles
 * @returns {{ check_spelling: boolean, check_capitalization: boolean, check_punctuation: boolean, check_grammar: boolean }}
 */
function getQCToggleSettings() {
    const spellEl = document.getElementById('toggle-check-spelling');
    const capEl = document.getElementById('toggle-check-capitalization');
    const puncEl = document.getElementById('toggle-check-punctuation');
    const gramEl = document.getElementById('toggle-check-grammar');

    return {
        check_spelling: spellEl ? spellEl.checked : true,
        check_capitalization: capEl ? capEl.checked : true,
        check_punctuation: puncEl ? puncEl.checked : true,
        check_grammar: gramEl ? gramEl.checked : true,
    };
}


async function runPDFValidation(brand, spellEnabled) {
        // Read 4 category toggles
        const toggleSettings = getQCToggleSettings();
        
        // Get PDF+OCR hybrid mode setting from UI
        // Use hybrid preference set during upload flow (user prompt) instead of UI checkbox
        const runPdfOcr = appState.preferHybrid === true;
        
        // Build config based on brand and active category toggles
        const config = {
            file_id: appState.fileId,
            brand: brand,
            domain: brand,
            check_spelling: toggleSettings.check_spelling,
            check_capitalization: toggleSettings.check_capitalization,
            check_punctuation: toggleSettings.check_punctuation,
            check_grammar: toggleSettings.check_grammar,
            check_title_case: toggleSettings.check_capitalization,
            grammar_enabled: toggleSettings.check_grammar,
            run_pdf_ocr: runPdfOcr,  // enable hybrid PDF text + OCR mode
            language: 'en-US'  // Default language for grammar checks
        };
        
        // Add spell check settings if enabled
        if (spellEnabled) {
            config.language = document.getElementById('spell-language').value.replace('_', '-');
            console.log('Selected language value:', document.getElementById('spell-language').value);
            console.log('Config language after replace:', config.language);
            // Use default aggressive_hyphenation=true and empty custom_allowlist (defaults from backend)
        }
        
        // For Ethosh and Biorad, ensure font extraction is enabled
        if (brand === 'Ethosh' || brand === 'Biorad') {
            config.extract_fonts = true;
        }

        config.ignore_proper_nouns = false;
        config.aggressive_hyphenation = true;
        config.custom_allowlist = [];
        config.upload_id = appState.uploadId || "";
        
        console.log('runValidation: sending config', config);
        document.getElementById('status-text').textContent = 'Starting validation job...';
        // Start a background validation job and poll its status so we can support cancellation
        let startData = null;
        try {
            console.log('[runPDFValidation] POST start_validate ->', getApiUrl('/api/qc/start_validate'));
            const startResp = await fetchWithTimeout(getApiUrl('/api/qc/start_validate'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            }, config.REQUEST_TIMEOUT);

            if (!startResp.ok) {
                const text = await startResp.text().catch(() => '');
                console.error('[runPDFValidation] start_validate responded with status:', startResp.status, text);
                throw new Error('Failed to start validation job: ' + (text || startResp.statusText || startResp.status));
            }
            startData = await startResp.json();
        } catch (err) {
            if (err.name === 'AbortError') {
                console.error('[runPDFValidation] start_validate request timed out');
                throw new Error('Request timed out when starting validation job');
            }
            console.error('[runPDFValidation] start_validate error:', err);
            throw err;
        }
        const jobId = startData.job_id;
        appState.currentJobId = jobId;
        console.log('runValidation: started job', jobId);

        // Update UI: disable run, enable cancel, show progress
        const runBtn = document.getElementById('run-validation-btn');
        const cancelBtn = document.getElementById('cancel-validation-btn');
        runBtn.disabled = true;
        runBtn.classList.add('btn-running');
        runBtn.style.display = 'none';
        cancelBtn.disabled = false;
        cancelBtn.classList.remove('btn-secondary');
        cancelBtn.classList.add('btn-cancelling');
        cancelBtn.style.display = 'inline-block';
        document.getElementById('validation-progress').style.display = 'flex';

        // Poll job status until done/cancelled/error
        let result = null;
        while (true) {
            if (appState.cancelRequested && appState.currentJobId) {
                // ask server to cancel
                try {
                    await fetch(getApiUrl(`/api/qc/cancel/${appState.currentJobId}`), { method: 'POST' });
                    document.getElementById('status-text').textContent = 'Cancellation requested (server)...';
                } catch (e) {
                    console.warn('Failed to request server cancel:', e);
                }
            }

            let job = null;
            try {
                const statusResp = await fetchWithTimeout(getApiUrl(`/api/qc/status/${jobId}`), {}, 15000);
                if (!statusResp.ok) {
                    const txt = await statusResp.text().catch(() => '');
                    console.error('[runPDFValidation] status poll failed:', statusResp.status, txt);
                    throw new Error('Failed to poll job status: ' + (txt || statusResp.statusText || statusResp.status));
                }
                job = await statusResp.json();
            } catch (err) {
                if (err.name === 'AbortError') {
                    console.warn('[runPDFValidation] status poll timed out, will retry');
                    // continue to next loop iteration to retry
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }
                throw err;
            }
            console.log('Job status:', job);
            if (job.status === 'done') {
                result = job.result || {};
                break;
            } else if (job.status === 'error') {
                throw new Error(job.error || 'Validation job failed');
            } else if (job.status === 'cancelled' || job.status === 'cancelling') {
                // Job was cancelled - surface to user
                document.getElementById('status-text').textContent = 'Validation cancelled';
                document.getElementById('loader').style.display = 'none';
                // Reset buttons
                runBtn.disabled = false;
                runBtn.classList.remove('btn-running');
                runBtn.style.display = 'inline-block';
                cancelBtn.disabled = true;
                cancelBtn.classList.remove('btn-cancelling');
                cancelBtn.classList.add('btn-secondary');
                cancelBtn.style.display = 'none';
                document.getElementById('validation-progress').style.display = 'none';
                appState.validationDone = false;
                return;
            } else {
                // running/queued - update progress if available
                if (job.progress !== undefined && job.progress !== null) {
                    // Show more detailed status based on progress percentage
                    let statusText = 'Running validation...';
                    const progress = Math.floor(job.progress);
                    
                    if (progress < 5) {
                        statusText = 'Extracting PDF text...';
                    } else if (progress < 8) {
                        statusText = 'Initializing spell checker...';
                    } else if (progress < 15) {
                        statusText = 'Detecting page zones...';
                    } else if (progress < 85) {
                        statusText = `Validating pages... ${progress}%`;
                    } else if (progress < 90) {
                        statusText = 'Generating legend...';
                    } else if (progress < 95) {
                        statusText = 'Creating annotated PDF...';
                    } else {
                        statusText = 'Finalizing results...';
                    }
                    
                    document.getElementById('status-text').textContent = statusText;
                    
                    // Update progress bar (monotonic) with smoothing so that
                    // large backend jumps (e.g. 14 → 80) animate more gradually
                    // instead of appearing as abrupt spikes in the UI.
                    try {
                        const backendProgress = job.progress;
                        const current = appState.maxProgressSeen || 0;
                        let displayProgress = backendProgress;
                        if (backendProgress > current) {
                            const delta = backendProgress - current;
                            // Limit how much the bar can advance per poll to smooth jumps.
                            const maxStep = 7; // percent per 500ms poll ≈ 14%/s
                            const step = Math.min(delta, maxStep);
                            displayProgress = current + step;
                        }
                        updateProgressBar(displayProgress);
                        // Stalled shimmer: visible during AI processing window (25–84%)
                        const _pb = document.getElementById('progress-bar');
                        if (_pb) {
                            if (displayProgress >= 25 && displayProgress < 85) {
                                _pb.classList.add('stalled');
                            } else {
                                _pb.classList.remove('stalled');
                            }
                        }
                        console.log(`[Progress] backend=${backendProgress}%, display=${displayProgress}%: ${statusText}`);
                    } catch (e) {
                        console.error('[Progress] Failed to update progress bar:', e);
                    }
                } else {
                    document.getElementById('status-text').textContent = `Running validation...`;
                }
            }
            // Poll more frequently for smoother progress updates
            await new Promise(r => setTimeout(r, 500));
        }
        console.log('='.repeat(80));
        console.log('VALIDATION RESPONSE RECEIVED');
        console.log('='.repeat(80));
        console.log('Full result:', result);
        console.log('result.status:', result.status);
        console.log('result.total_issues:', result.total_issues);
        console.log('result.page_issues:', result.page_issues);
        console.log('result.issues:', result.issues);
        if (result.issues) {
            console.log('result.issues.spelling_issues:', result.issues.spelling_issues);
            console.log('Number of spelling issues:', result.issues.spelling_issues?.length || 0);
        }
        if (result.page_issues) {
            console.log('Page issues array length:', result.page_issues.length);
            result.page_issues.forEach((pi, idx) => {
                console.log(`Page ${pi.page}: ${pi.issues} issues, ${pi.callouts?.length || 0} callouts`);
                if (idx === 0 && pi.callouts && pi.callouts.length > 0) {
                    console.log('First callout sample:', pi.callouts[0]);
                }
                // Debug: Log ALL callouts for first 3 pages to verify data structure
                if (idx < 3 && pi.callouts && pi.callouts.length > 0) {
                    console.log(`Page ${pi.page} ALL callouts:`, pi.callouts);
                }
            });
        }
        console.log('='.repeat(80));

        // Refresh upload history to show updated status
        loadUploadHistory();

        // Store results
        appState.validationDone = true;
        // Prefer canonical keys returned by backend
        appState.outputPath = result.annotated_pdf_url || result.annotated || result.annotated_pdf || null;
        // Legend canonical key
        appState.legendUrl = result.legend_pdf_url || result.legend || (result.report && result.report.legend_pdf_url) || null;
        console.log('DEBUG: PDF Validation - annotated_pdf_url:', result.annotated_pdf_url);
        console.log('DEBUG: PDF Validation - legend_pdf_url:', result.legend_pdf_url);
        console.log('DEBUG: PDF Validation - appState.outputPath:', appState.outputPath);
        console.log('DEBUG: PDF Validation - appState.legendUrl:', appState.legendUrl);
        // Store raw report for JSON download and further UI uses
        appState.rawReport = result.report || result;
        appState.totalIssues = result.total_issues || result.totalIssues || 0;
        appState.pageIssues = result.page_issues || result.page_issues || [];

        // Merge any top-level grammar_issues (from OCR pipeline) into pageIssues
        // so they appear as hover callouts in the preview. LanguageTool/OCR returns
        // bbox in image pixels (image_width/image_height). Convert to PDF points
        // by scaling to the page's PDF dimensions (defaults 595x842 when unknown).
        try {
            if (Array.isArray(result.grammar_issues) && result.grammar_issues.length > 0) {
                result.grammar_issues.forEach(gi => {
                    try {
                        // page in backend may be 0-based; appState.pageIssues uses 1-based pages
                        const pageNum = (typeof gi.page === 'number') ? (gi.page + 1) : (gi.page || 1);
                        let pageData = (appState.pageIssues || []).find(p => p && (p.page === pageNum || p.pageNum === pageNum));
                        if (!pageData) {
                            pageData = { page: pageNum, pageNum: pageNum, issues: [], callouts: [] };
                            appState.pageIssues = appState.pageIssues || [];
                            appState.pageIssues.push(pageData);
                        }

                        // Determine target PDF page dimensions (points)
                        const pdfW = (pageData.callouts && pageData.callouts[0] && (pageData.callouts[0].pageWidth || pageData.callouts[0].page_width)) || pageData.pageWidth || pageData.page_width || 595;
                        const pdfH = (pageData.callouts && pageData.callouts[0] && (pageData.callouts[0].pageHeight || pageData.callouts[0].page_height)) || pageData.pageHeight || pageData.page_height || 842;

                        const imgW = gi.image_width || gi.imageWidth || gi.image_width || pdfW;
                        const imgH = gi.image_height || gi.imageHeight || gi.image_height || pdfH;

                        if (gi.bbox && Array.isArray(gi.bbox) && gi.bbox.length === 4 && imgW > 0 && imgH > 0) {
                            const scaleX = pdfW / imgW;
                            const scaleY = pdfH / imgH;
                            const bboxPdf = [gi.bbox[0] * scaleX, gi.bbox[1] * scaleY, gi.bbox[2] * scaleX, gi.bbox[3] * scaleY].map(n => Number(n));
                            const norm = [bboxPdf[0] / pdfW, bboxPdf[1] / pdfH, bboxPdf[2] / pdfW, bboxPdf[3] / pdfH];

                            const call = Object.assign({}, gi, {
                                bbox: bboxPdf,
                                rect: bboxPdf,
                                page_width: pdfW,
                                page_height: pdfH,
                                pageWidth: pdfW,
                                pageHeight: pdfH,
                                norm_bbox: norm,
                                type: 'grammar',
                                msg: gi.message || gi.msg || gi.rule_id || 'Grammar issue'
                            });

                            // De-duplicate: skip if same word already exists OR bbox is within 8 points
                            const giWord = (gi.problem_word || gi.word || gi.text || '').toLowerCase().trim();
                            const exists = (pageData.callouts || []).some(c => {
                                if (!c) return false;
                                const cWord = (c.problem_word || c.word || c.text || '').toLowerCase().trim();
                                if (giWord && cWord && giWord === cWord) return true; // same word = duplicate
                                if (!Array.isArray(c.bbox) || c.bbox.length !== 4) return false;
                                return Math.abs(c.bbox[0] - bboxPdf[0]) < 8 && Math.abs(c.bbox[1] - bboxPdf[1]) < 8 && Math.abs(c.bbox[2] - bboxPdf[2]) < 8 && Math.abs(c.bbox[3] - bboxPdf[3]) < 8;
                            });
                            if (!exists) {
                                pageData.callouts = pageData.callouts || [];
                                pageData.issues = pageData.issues || [];
                                pageData.callouts.push(call);
                                pageData.issues.push(call);
                            }
                        }
                    } catch (e) {
                        console.warn('Failed to merge grammar issue into pageIssues', e, gi);
                    }
                });
            }
        } catch (e) {
            console.warn('merge grammar_issues failed', e);
        }
        appState.fontsUsed = result.fonts_used || result.fonts || [];
        // Extract all issue categories from result
        appState.detectedSpellingIssues = result.spelling_issues || (result.issues && result.issues.spelling_issues) || result.detected_spelling_issues || [];
        appState.detectedGrammarIssues = result.grammar_issues || [];
        appState.detectedFormattingIssues = result.double_spacing_issues || [];
        appState.detectedTitleCaseIssues = result.title_case_issues || [];
        appState.detectedCaseViolations = (result.title_case_issues || []).map(t => t.original || t.name || t.word || '');
        // Try to preserve original case for detected spelling words by scanning page callouts and annotations
        try {
            const normalizeFromCallouts = (word) => {
                if (!word) return word;
                const lw = String(word).toLowerCase();
                // search page_issues callouts and issues for original-cased occurrences
                if (Array.isArray(result.page_issues)) {
                    for (const pi of result.page_issues) {
                        // Handle both array and object formats for pi.issues
                        let issuesArray = [];
                        if (Array.isArray(pi.issues)) {
                            issuesArray = pi.issues;
                        } else if (pi.issues && typeof pi.issues === 'object') {
                            // Extract issues from object properties (spelling_issues, grammar_issues, etc.)
                            issuesArray = Object.values(pi.issues).flat().filter(i => i);
                        }
                        const callouts = (pi.callouts || []).concat(issuesArray);
                        for (const c of callouts) {
                            const text = (c.msg || c.message || c.text || c.title || '').toString();
                            if (!text) continue;
                            if (text.toLowerCase().includes(lw)) {
                                // try to extract exact matching substring preserving case
                                const re = new RegExp('\\b' + escapeRegExp(word) + '\\b', 'i');
                                const m = text.match(re);
                                if (m && m[0]) return m[0];
                                // fallback: return the full text if it equals the word case-insensitively
                                if (text.trim().toLowerCase() === lw) return text.trim();
                            }
                        }
                    }
                }
                // search annotations
                if (Array.isArray(result.annotations)) {
                    for (const a of result.annotations) {
                        const text = (a.msg || a.message || a.details || a.title || '').toString();
                        if (!text) continue;
                        if (text.toLowerCase().includes(lw)) {
                            const re = new RegExp('\\b' + escapeRegExp(word) + '\\b', 'i');
                            const m = text.match(re);
                            if (m && m[0]) return m[0];
                            if (text.trim().toLowerCase() === lw) return text.trim();
                        }
                    }
                }
                return word;
            };

            // helper
            function escapeRegExp(string) {
                return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }

            if (Array.isArray(appState.detectedSpellingIssues) && appState.detectedSpellingIssues.length > 0) {
                appState.detectedSpellingIssues = appState.detectedSpellingIssues.map(w => normalizeFromCallouts(w));
            }
        } catch (e) {
            console.warn('Failed to normalize spelling cases:', e);
        }
        // Fallback: populate from annotations if spelling issues missing
        if ((!appState.detectedSpellingIssues || appState.detectedSpellingIssues.length === 0) && Array.isArray(result.annotations)) {
            const spellingMsgs = result.annotations
                .filter(a => (a.type === 'spelling' || a.issue_type === 'spelling'))
                .map(a => a.msg || a.details || a.title || a.message)
                .filter(Boolean);
            if (spellingMsgs.length > 0) {
                appState.detectedSpellingIssues = spellingMsgs;
            }
        }
        appState.detectedCaseViolations = result.detected_case_violations || [];
        
        // Convert fonts_used array to fontsData object for font explorer
        if (appState.fontsUsed.length > 0) {
            appState.fontsData = {};
            appState.fontsUsed.forEach(font => {
                appState.fontsData[font.name] = font;
            });
        }

        // Use annotated previews if backend returned them (preferred)
        if (result.annotated_previews && Array.isArray(result.annotated_previews) && result.annotated_previews.length > 0) {
            appState.cachedPreviews = result.annotated_previews;
        }
        
        // Extract spelling issues from result and update sidebar
        console.log('DEBUG: Extracting spelling issues...');
        console.log('DEBUG: result.issues:', result.issues);
        console.log('DEBUG: appState.detectedSpellingIssues after extraction:', appState.detectedSpellingIssues);
        console.log('DEBUG: Length:', appState.detectedSpellingIssues.length);
        
        // Respect user's spell-check preference: if spell checking disabled, ignore spelling issues
        if (!spellEnabled) {
            console.log('Spell checking disabled by user; clearing spelling issues from results.');
            appState.detectedSpellingIssues = [];
            // Remove spelling issues from pageIssues if present
            try {
                appState.pageIssues = (appState.pageIssues || []).map(pi => {
                    const filteredIssues = (pi.issues || []).filter(i => (i.type || i.issue_type) !== 'spelling');
                    const filteredCallouts = (pi.callouts || []).filter(i => (i.type || i.issue_type) !== 'spelling');
                    return Object.assign({}, pi, {
                        issues: filteredIssues,
                        callouts: filteredCallouts,
                        spelling_count: 0
                    });
                });
                // Recompute totalIssues
                let newTotal = 0;
                appState.pageIssues.forEach(p => { newTotal += (p.issues || []).length; });
                appState.totalIssues = newTotal;
            } catch (e) {
                console.warn('Failed to strip spelling issues from pageIssues:', e);
            }
        }

        if (appState.detectedSpellingIssues && appState.detectedSpellingIssues.length > 0) {
            console.log('DEBUG: Calling updateSpellingIssuesSidebar with', appState.detectedSpellingIssues.length, 'issues');
            updateSpellingIssuesSidebar(appState.detectedSpellingIssues);
        } else {
            console.log('DEBUG: No spelling issues to display');
        }
        
        // Load fonts for Ethosh/Biorad brands
        // brand variable already declared at the top of the function
        console.log('DEBUG: Brand selected:', brand);
        if ((brand === 'Ethosh' || brand === 'Biorad') && appState.fileId) {
            console.log('DEBUG: Loading font explorer for', brand);
            await loadFontExplorer();
        } else {
            console.log('DEBUG: Skipping font explorer - brand:', brand, 'fileId:', appState.fileId);
        }
        
        // Update UI
        renderValidationResults();
        updateSidebarIssues();
        updateFontExplorer();
        
        document.getElementById('loader').style.display = 'none';
        document.getElementById('status-text').textContent = 'Validation complete!';
        
        // Show feedback modal
        showFeedbackModal();

        // Refresh upload history so the new row / updated status is visible
        loadUploadHistory();
        
        // Reset buttons and progress
        const runBtn2 = document.getElementById('run-validation-btn');
        const cancelBtn2 = document.getElementById('cancel-validation-btn');
        runBtn2.disabled = false;
        runBtn2.classList.remove('btn-running');
        runBtn2.style.display = 'inline-block';
        cancelBtn2.disabled = true;
        cancelBtn2.classList.remove('btn-cancelling');
        cancelBtn2.classList.add('btn-secondary');
        cancelBtn2.style.display = 'none';
        updateProgressBar(100);
        saveActiveReviewToSession();
        // Keep progress bar visible longer so users can see completion
        setTimeout(() => { document.getElementById('validation-progress').style.display = 'none'; }, 3000);
}


// Normalize various backend pageIssues shapes so preview overlay rendering
// receives consistent `callouts` with `rect`/`bbox` arrays, `norm_bbox`, and page dimensions.
function normalizePageIssuesForPreview() {
    if (!appState.pageIssues || !Array.isArray(appState.pageIssues)) return;

    appState.pageIssues.forEach(pageData => {
        // Ensure callouts array exists
        if (!Array.isArray(pageData.callouts)) {
            // If issues is an array with bbox-like items, promote them
            if (Array.isArray(pageData.issues)) {
                pageData.callouts = pageData.issues.filter(it => it && (it.rect || it.bbox || it.bounding_box || it.norm_bbox)).map(it => Object.assign({}, it));
            } else {
                pageData.callouts = [];
            }
        }

        // Try to infer page dimensions from pageData or defaults
        const inferredPageWidth = pageData.page_width || pageData.pageWidth || pageData.pageW || 612;
        const inferredPageHeight = pageData.page_height || pageData.pageHeight || pageData.pageH || 792;

        pageData.callouts.forEach(callout => {
            try {
                // Normalize rect/bbox: accept array [x0,y0,x1,y1] or object {x0,y0,x1,y1}
                let bbox = callout.rect || callout.bbox || callout.bounding_box || null;
                if (!bbox && callout.box) bbox = callout.box;

                if (bbox && typeof bbox === 'object' && !Array.isArray(bbox)) {
                    // object form -> convert to array if keys present
                    if ('x0' in bbox && 'y0' in bbox && 'x1' in bbox && 'y1' in bbox) {
                        bbox = [Number(bbox.x0), Number(bbox.y0), Number(bbox.x1), Number(bbox.y1)];
                    } else if ('left' in bbox && 'top' in bbox && 'right' in bbox && 'bottom' in bbox) {
                        bbox = [Number(bbox.left), Number(bbox.top), Number(bbox.right), Number(bbox.bottom)];
                    }
                }

                if (Array.isArray(bbox) && bbox.length === 4) {
                    // Ensure numbers
                    bbox = bbox.map(n => Number(n));
                    // Validate order
                    if (isFinite(bbox[0]) && isFinite(bbox[1]) && isFinite(bbox[2]) && isFinite(bbox[3])) {
                        // Assign normalized fields back
                        callout.rect = bbox;
                        callout.bbox = bbox;
                    }
                }

                // Ensure page dimensions are present on callout
                if (!callout.page_width) callout.page_width = inferredPageWidth;
                if (!callout.page_height) callout.page_height = inferredPageHeight;
                if (!callout.pageWidth) callout.pageWidth = callout.page_width;
                if (!callout.pageHeight) callout.pageHeight = callout.page_height;

                // Compute norm_bbox if missing and bbox present
                if ((!callout.norm_bbox || callout.norm_bbox.length !== 4) && Array.isArray(callout.bbox) && callout.pageWidth && callout.pageHeight) {
                    const [x0, y0, x1, y1] = callout.bbox;
                    const nx0 = x0 / callout.pageWidth;
                    const ny0 = y0 / callout.pageHeight;
                    const nx1 = x1 / callout.pageWidth;
                    const ny1 = y1 / callout.pageHeight;
                    if (isFinite(nx0) && isFinite(ny0) && isFinite(nx1) && isFinite(ny1)) {
                        callout.norm_bbox = [nx0, ny0, nx1, ny1];
                    }
                }
            } catch (e) {
                // non-fatal - move on
                console.debug('normalizePageIssuesForPreview: failed for callout', e);
            }
        });
    });
}

function cancelValidation() {
    appState.cancelRequested = true;
    document.getElementById('status-text').textContent = 'Cancellation requested...';
    // If there's an active job on the server, request cancellation
    if (appState.currentJobId) {
        fetch(getApiUrl(`/api/qc/cancel/${appState.currentJobId}`), { method: 'POST' }).then(() => {
            document.getElementById('status-text').textContent = 'Server cancellation requested';
        }).catch((e) => {
            console.warn('Server cancel request failed:', e);
        });
    }
}

function renderValidationResults() {
    const section = document.getElementById('results-section');
    section.style.display = 'block';
    section.classList.add('fade-in');
    
    document.getElementById('result-issues').textContent = appState.totalIssues;

    const messageDiv = document.getElementById('result-message');
    if (appState.totalIssues === 0) {
        messageDiv.className = 'result-message success';
        messageDiv.textContent = 'Great job! No validation issues found. The PDF is compliant.';
    } else {
        messageDiv.className = 'result-message warning';
        messageDiv.textContent = `Found ${appState.totalIssues} issues that require attention.`;
    }
    
    let spellingCount = 0;
    let grammarCount = 0;
    let formattingCount = 0;
    let titleCaseCount = 0;

    // Use the per-category arrays the backend returns (accurate by-category counts).
    // The summary's spelling_count/grammar_count are severity-based (error/warning), not
    // category-based, so they lump title_case and double_spacing into grammar_count.
    if (appState.rawReport) {
        if (Array.isArray(appState.rawReport.spelling_issues))
            spellingCount = appState.rawReport.spelling_issues.length;
        if (Array.isArray(appState.rawReport.grammar_issues))
            grammarCount = appState.rawReport.grammar_issues.length;
        if (Array.isArray(appState.rawReport.double_spacing_issues))
            formattingCount = appState.rawReport.double_spacing_issues.length;
        if (Array.isArray(appState.rawReport.title_case_issues))
            titleCaseCount = appState.rawReport.title_case_issues.length;
    }

    // Fallback: count from page_issues callouts/issues by type
    if (spellingCount === 0 && grammarCount === 0 && appState.pageIssues && Array.isArray(appState.pageIssues)) {
        appState.pageIssues.forEach(pageData => {
            const issues = pageData.callouts || pageData.issues || [];
            issues.forEach(issue => {
                const type = (issue.type || issue.issue_type || '').toString().toLowerCase();
                if (type === 'spelling') spellingCount++;
                else if (type === 'grammar') grammarCount++;
                else if (type === 'formatting' || type === 'spacing' || type === 'double_spacing') formattingCount++;
                else if (type === 'title_case' || type === 'titlecase') titleCaseCount++;
            });
        });
    }

    // Spelling count fallback: use detected list length so summary always matches sidebar
    if (spellingCount === 0 && appState.detectedSpellingIssues && Array.isArray(appState.detectedSpellingIssues) && appState.detectedSpellingIssues.length > 0) {
        spellingCount = appState.detectedSpellingIssues.length;
    }

    // Populate the 3 sub-metric cards (folds title-case into Formatting)
    document.getElementById('result-spelling').textContent = `${spellingCount}/${appState.totalIssues}`;
    document.getElementById('result-grammar').textContent = grammarCount;
    document.getElementById('result-formatting').textContent = formattingCount + titleCaseCount;

    // Render annotated preview
    if (appState.outputPath || (appState.cachedPreviews && appState.cachedPreviews.length > 0)) {
        renderAnnotatedPreview();
    }

    // Zone Detection section: keep it visible (already shown at upload time).
    // Re-render zone thumbnails using the preserved zone-annotated previews so
    // the blue/orange zone boxes are not replaced by the issue-annotated previews.
    const zonesSection = document.getElementById('zones-section');
    if (zonesSection && appState.cachedZonePreviews && appState.cachedZonePreviews.length > 0) {
        zonesSection.style.display = 'block';
        const zonesToggle = document.getElementById('zones-toggle');
        if (zonesToggle && zonesToggle.checked) {
            renderZoneResults(appState.cachedZones || [], appState.cachedZonePreviews);
        }
    }

    // Audit Log (preview + Spell Check Settings/Spelling Mistakes/Font Explorer)
    // only appears once validation has produced results to show.
    const auditLogSection = document.getElementById('audit-log-section');
    if (auditLogSection) auditLogSection.style.display = 'block';
}

function renderAnnotatedPreview() {
    const section = document.getElementById('preview-section');
    section.style.display = 'block';
    section.classList.add('fade-in');

    const resolveUrlForWindowOpen = (pathOrUrl) => {
        if (!pathOrUrl) return pathOrUrl;
        const value = String(pathOrUrl);
        // Absolute URLs or special schemes should be opened as-is.
        if (/^(https?:)?\/\//i.test(value) || /^data:|^blob:/i.test(value)) return value;
        // Backend typically returns relative API paths (e.g., /api/pdf/download/...).
        return getApiUrl(value);
    };
    
    // Set up download button
    const downloadBtn = document.getElementById('download-pdf-btn');
    console.log('DEBUG: renderAnnotatedPreview - appState.outputPath:', appState.outputPath);
    console.log('DEBUG: renderAnnotatedPreview - appState.legendUrl:', appState.legendUrl);
    if (appState.outputPath) {
        downloadBtn.textContent = 'Download Annotated PDF';
        downloadBtn.onclick = () => {
            logUserActivity('download_report', appState.uploadedFile ? appState.uploadedFile.name : (appState.fileId || 'document.pdf'), { format: 'annotated_pdf' });
            const url = resolveUrlForWindowOpen(appState.outputPath);
            const a = document.createElement('a');
            a.href = url;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        };
    } else {
        // No downloadable annotated PDF — offer JSON report download instead
        const label = 'Download JSON Report';
        downloadBtn.textContent = label;
        downloadBtn.onclick = () => {
            if (appState.rawReport) {
                logUserActivity('download_report', appState.uploadedFile ? appState.uploadedFile.name : (appState.fileId || 'document.json'), { format: 'json' });
                const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState.rawReport, null, 2));
                const a = document.createElement('a');
                a.href = dataStr;
                a.download = `report_${appState.fileId || 'document'}.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
        };
    }

    // Normalize page issues so preview overlay code can rely on consistent fields
    try { normalizePageIssuesForPreview(); } catch (e) { console.warn('normalizePageIssuesForPreview error:', e); }

    // Legend download button - with improved path handling for Ethosh brand
    const legendBtn = document.getElementById('download-legend-btn');
    if (appState.legendUrl) {
        legendBtn.style.display = 'inline-block';
        legendBtn.onclick = () => {
            logUserActivity('download_report', appState.uploadedFile ? appState.uploadedFile.name : (appState.fileId || 'document.pdf'), { format: 'legend' });
            // Ensure we have the correct legend URL
            const legendPath = appState.legendUrl.startsWith('/') ? appState.legendUrl : `/api/qc/legend/${appState.fileId}`;
            console.log('Opening legend PDF:', legendPath);
            window.open(resolveUrlForWindowOpen(legendPath), '_blank');
        };
    } else {
        legendBtn.style.display = 'none';
    }

    // JSON report download
    const jsonBtn = document.getElementById('download-json-btn');
    if (jsonBtn) {
        if (appState.rawReport) {
            jsonBtn.style.display = 'inline-block';
            jsonBtn.onclick = () => {
                const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState.rawReport, null, 2));
                const win = window.open();
                if (win) {
                    win.document.write('<pre>' + JSON.stringify(appState.rawReport, null, 2) + '</pre>');
                } else {
                    // fallback to downloading
                    const a = document.createElement('a');
                    a.href = dataStr;
                    a.download = 'report.json';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                }
            };
        } else {
            jsonBtn.style.display = 'none';
        }
    }
    
    // Render interactive issue boxes with hover tooltips
    const previewsDiv = document.getElementById('annotated-previews');
    previewsDiv.innerHTML = '';
    
    if (appState.cachedPreviews && appState.cachedPreviews.length > 0) {
        appState.cachedPreviews.forEach((preview, idx) => {
            const pageNum = idx + 1;
            // Robust page issue mapping: ONLY use explicit page number match, never use array index
            let pageIssues = {};
            if (Array.isArray(appState.pageIssues)) {
                const found = appState.pageIssues.find(p => p && (p.page === pageNum || p.pageNum === pageNum));
                pageIssues = found || {};
                if (!found) {
                    console.warn(`[Page ${pageNum}] No matching page_issues found in array of ${appState.pageIssues.length} items`);
                } else {
                    console.log(`[Page ${pageNum}] ✓ Found matching page_issues with page=${found.page}, ${found.callouts?.length || 0} callouts`);
                }
            } else if (appState.pageIssues && (pageNum in appState.pageIssues)) {
                pageIssues = appState.pageIssues[pageNum] || {};
            }
            // Compute issueCount while respecting spell-check preference (don't count spelling issues when disabled)
            let issueCount = 0;
            try {
                const spellEnabledNow = !!document.getElementById('spell-enabled') && document.getElementById('spell-enabled').checked;
                if (Array.isArray(pageIssues.issues) && pageIssues.issues.length > 0) {
                    issueCount = pageIssues.issues.filter(i => {
                        const t = ((i && (i.type || i.issue_type)) || '').toString().toLowerCase();
                        return spellEnabledNow || t !== 'spelling';
                    }).length;
                } else if (Array.isArray(pageIssues.callouts) && pageIssues.callouts.length > 0) {
                    issueCount = pageIssues.callouts.filter(i => {
                        const t = ((i && (i.type || i.issue_type)) || '').toString().toLowerCase();
                        return spellEnabledNow || t !== 'spelling';
                    }).length;
                }
            } catch (e) {
                issueCount = (Array.isArray(pageIssues.issues) ? pageIssues.issues.length : 0) || (Array.isArray(pageIssues.callouts) ? pageIssues.callouts.length : 0);
            }
            
            const pageContainer = document.createElement('div');
            pageContainer.className = 'preview-page-container page-slide-in';
            // mark the first page as active initially
            if (idx === 0) pageContainer.classList.add('active');
            pageContainer.dataset.page = pageNum; // For font highlighting
            pageContainer.dataset.pageNum = pageNum;
            pageContainer.style.position = 'relative';
            pageContainer.style.marginBottom = '20px';
            pageContainer.style.animationDelay = `${idx * 0.1}s`;
            

            // Image wrapper with relative positioning for issue overlays
            const imgWrapper = document.createElement('div');
            imgWrapper.className = 'img-wrapper';
            imgWrapper.style.position = 'relative';
            imgWrapper.style.display = idx === 0 ? 'block' : 'none'; // Initially hide pages > 1
            
            const img = document.createElement('img');
            img.src = `data:image/png;base64,${preview}`;
            img.className = 'preview-image page-image preview-page-img'; // Add page-image and preview-page-img classes
            img.alt = `Page ${pageNum}`;
            img.title = '';
            imgWrapper.appendChild(img);
            
            // Add interactive issue boxes for hover tooltips
            // Note: annotated_previews already have visual annotations,
            // but we add invisible hover boxes for interactivity.
            // Support both `callouts` and potential `issues` entries.
            const calloutsFromPage = [];
            const seenCallouts = new Set();
            const pushUnique = (it) => {
                if (!it) return;
                const rect = it.rect || it.bbox || it.bounding_box;
                const norm = it.norm_bbox;
                // Build a stable fingerprint; tolerate floats by rounding.
                const round4 = (n) => (typeof n === 'number' && isFinite(n)) ? Number(n.toFixed(4)) : n;
                const rectKey = Array.isArray(rect) && rect.length === 4 ? rect.map(round4).join(',') : '';
                const normKey = Array.isArray(norm) && norm.length === 4 ? norm.map(round4).join(',') : '';
                const typeKey = (it.type || it.issue_type || '').toString();
                // Include word and offset to distinguish different occurrences of the same word
                const wordKey = (it.problem_word || it.word || it.text || '').toString().toLowerCase();
                const offsetKey = (it.offset || 0).toString();
                const key = `${typeKey}|${rectKey}|${wordKey}|${offsetKey}`;
                if (seenCallouts.has(key)) return;
                seenCallouts.add(key);
                calloutsFromPage.push(it);
            };

            // IMPORTANT: Many backends return the same items in both `callouts` and `issues`.
            // Prefer `callouts` when present, otherwise fall back to `issues`.
            console.log(`[DEBUG Page ${pageNum}] pageIssues structure:`, pageIssues);
            console.log(`[DEBUG Page ${pageNum}] pageIssues.callouts type:`, typeof pageIssues.callouts, 'length:', pageIssues.callouts?.length);
            console.log(`[DEBUG Page ${pageNum}] pageIssues.issues type:`, typeof pageIssues.issues, 'length:', pageIssues.issues?.length);
            
            if (Array.isArray(pageIssues.callouts) && pageIssues.callouts.length > 0) {
                console.log(`[DEBUG Page ${pageNum}] Using callouts array with ${pageIssues.callouts.length} items`);
                pageIssues.callouts.forEach(pushUnique);
            } else if (Array.isArray(pageIssues.issues) && pageIssues.issues.length > 0) {
                console.log(`[DEBUG Page ${pageNum}] Falling back to issues array with ${pageIssues.issues.length} items`);
                // Normalize issue objects that may contain rect/bbox
                pageIssues.issues.forEach(it => {
                    if (it && (it.rect || it.bbox || it.bounding_box || it.norm_bbox)) {
                        pushUnique(it);
                    }
                });
            } else {
                console.warn(`[DEBUG Page ${pageNum}] NO callouts or issues found!`);
            }

            if (calloutsFromPage.length > 0) {
                // Respect user's preference: if spell checking is disabled, drop spelling callouts entirely
                let calloutsToRender = calloutsFromPage.slice();
                try {
                    const spellEnabledNow = !!document.getElementById('spell-enabled') && document.getElementById('spell-enabled').checked;
                    if (!spellEnabledNow) {
                        calloutsToRender = calloutsToRender.filter(it => {
                            const t = (it.type || it.issue_type || '').toString().toLowerCase();
                            return t !== 'spelling';
                        });
                    }
                } catch (e) {
                    console.warn('Failed to respect spell-enabled preference when rendering overlays:', e);
                }

                // DEDUPLICATION: For spelling issues, keep only one box per unique word
                // Group callouts by word and location, then take the first one
                const seenSpellingWords = new Set();
                let filteredCallouts = [];
                
                calloutsToRender.forEach(callout => {
                    const calloutType = (callout.type || callout.issue_type || '').toString().toLowerCase();
                    
                    if (calloutType === 'spelling') {
                        // For spelling: create unique key from word (case-insensitive)
                        const word = (callout.word || callout.problem_word || '').toLowerCase().trim();
                        // Keep spelling callouts: if no word property, always add; if word exists, only add if not seen before
                        if (!word || !seenSpellingWords.has(word)) {
                            if (word) {
                                seenSpellingWords.add(word);
                            }
                            filteredCallouts.push(callout);
                        }
                    } else {
                        // Keep all non-spelling issues (grammar, formatting, titlecase, etc.)
                        filteredCallouts.push(callout);
                    }
                });
                
                calloutsToRender = filteredCallouts;
                
                // Capture imgWrapper in closure to ensure correct scope per page
                const currentImgWrapper = imgWrapper;
                const currentPageNum = pageNum;
                
                console.log(`Page ${currentPageNum}: Deduplication complete - ${calloutsToRender.length} unique callouts (removed spelling duplicates)`);

                // Wait for image to load before positioning boxes
                img.onload = function() {
                    // Use naturalWidth/naturalHeight for actual image dimensions
                    // These are available even if the image is hidden
                    const imgWidth = this.naturalWidth;
                    const imgHeight = this.naturalHeight;

                    console.log(`Page ${currentPageNum}: Image loaded - natural size ${imgWidth}x${imgHeight}, ${calloutsToRender.length} callouts to render`);

                    // Skip if dimensions are still invalid
                    if (imgWidth === 0 || imgHeight === 0) {
                        console.warn(`Page ${currentPageNum}: Invalid image dimensions, skipping hover boxes`);
                        return;
                    }

                    // Remove existing overlay if present (avoid duplicates on re-render)
                    const existingOverlay = currentImgWrapper.querySelector('.page-issue-overlay');
                    if (existingOverlay) existingOverlay.remove();

                    // Create an overlay layer sized to the image where we place issue boxes
                    const overlay = document.createElement('div');
                    overlay.className = 'page-issue-overlay';
                    overlay.style.position = 'absolute';
                    overlay.style.top = '0';
                    overlay.style.left = '0';
                    overlay.style.width = '100%';
                    overlay.style.height = '100%';
                    overlay.style.pointerEvents = 'auto';
                    overlay.style.zIndex = '20';
                    currentImgWrapper.appendChild(overlay);

                    // Get page dimensions - try to get from first callout, fallback to standard sizes
                    let pageWidth = 612; // Default US Letter width
                    let pageHeight = 792; // Default US Letter height
                    
                    // Try to extract page dimensions from first callout
                    if (calloutsToRender.length > 0) {
                        const firstCallout = calloutsToRender[0];
                        if (firstCallout.page_width && firstCallout.page_height) {
                            pageWidth = firstCallout.page_width;
                            pageHeight = firstCallout.page_height;
                        } else if (firstCallout.pageWidth && firstCallout.pageHeight) {
                            pageWidth = firstCallout.pageWidth;
                            pageHeight = firstCallout.pageHeight;
                        }
                    }

                    console.log(`====== FRONTEND COORD DEBUG Page ${currentPageNum} ======`);
                    console.log(`Image natural size: ${imgWidth}x${imgHeight} px`);
                    console.log(`PDF dimensions: ${pageWidth.toFixed(2)}x${pageHeight.toFixed(2)} pt`);

                    // Calculate scaling factors using natural image size
                    const scaleX = imgWidth / pageWidth;
                    const scaleY = imgHeight / pageHeight;

                    console.log(`Scale factors: scaleX=${scaleX.toFixed(6)}, scaleY=${scaleY.toFixed(6)}`);

                    // Build a map to track how many boxes exist at each word location
                    // This allows us to offset multiple boxes on the same word
                    const wordLocationMap = new Map(); // key: "word|rect" -> count of boxes
                    calloutsToRender.forEach((callout) => {
                        const rect = callout.rect || callout.bbox || callout.bounding_box;
                        if (!rect || rect.length !== 4) return;
                        
                        const word = (callout.problem_word || callout.word || callout.text || '').toLowerCase().trim();
                        const rectKey = rect.map(v => Math.round(v * 100) / 100).join(',');
                        const locationKey = `${word}|${rectKey}`;
                        
                        if (!wordLocationMap.has(locationKey)) {
                            wordLocationMap.set(locationKey, { count: 0, indices: [] });
                        }
                        const entry = wordLocationMap.get(locationKey);
                        entry.indices.push(calloutsToRender.indexOf(callout));
                        entry.count++;
                    });

                    // Render overlay boxes with tooltips
                    let boxesAdded = 0;
                    calloutsToRender.forEach((callout, calloutIdx) => {
                        const rect = callout.rect || callout.bbox || callout.bounding_box;
                        if (!rect || rect.length !== 4) {
                            console.warn(`Page ${currentPageNum}: Callout ${calloutIdx} missing valid rect`);
                            return;
                        }

                        // Get location info and box offset for this callout
                        const word = (callout.problem_word || callout.word || callout.text || '').toLowerCase().trim();
                        const rectKey = rect.map(v => Math.round(v * 100) / 100).join(',');
                        const locationKey = `${word}|${rectKey}`;
                        const locationInfo = wordLocationMap.get(locationKey);
                        const boxIndexAtLocation = locationInfo ? locationInfo.indices.indexOf(calloutIdx) : 0;
                        const boxCountAtLocation = locationInfo ? locationInfo.count : 1;

                        // For images: bbox is already in PDF points from backend transformation
                        // For PDFs: bbox is in PDF points
                        // PRIORITY: Use norm_bbox (normalized 0-1) if available - most accurate for images
                        const [x0, y0, x1, y1] = rect;
                        
                        let pixelX0, pixelY0, pixelX1, pixelY1;
                        let coordSource = 'none';
                        
                        // PRIORITY: Use bbox (already in PDF points from backend transformation)
                        // Backend transforms all coordinates to PDF space for consistency
                        // bbox is in PDF points, convert to image pixels
                        const cPageWidth = callout.page_width || callout.pageWidth || pageWidth;
                        const cPageHeight = callout.page_height || callout.pageHeight || pageHeight;
                        const curScaleX = imgWidth / cPageWidth;
                        const curScaleY = imgHeight / cPageHeight;

                        pixelX0 = x0 * curScaleX;
                        pixelY0 = y0 * curScaleY;
                        pixelX1 = x1 * curScaleX;
                        pixelY1 = y1 * curScaleY;
                        coordSource = 'bbox_pdf';
                        console.log(`Callout ${calloutIdx} [${callout.type || 'unknown'}]: Using bbox [${x0.toFixed(1)}, ${y0.toFixed(1)}, ${x1.toFixed(1)}, ${y1.toFixed(1)}] × scale[${scaleX.toFixed(4)}, ${scaleY.toFixed(4)}] = [${pixelX0.toFixed(1)}, ${pixelY0.toFixed(1)}, ${pixelX1.toFixed(1)}, ${pixelY1.toFixed(1)}]px`);
                        
                        // Validate: if coordinates look invalid, try norm_bbox as fallback
                        const isInvalid = pixelX0 < 0 || pixelY0 < 0 || pixelX1 > imgWidth * 1.1 || pixelY1 > imgHeight * 1.1 || pixelX1 <= pixelX0 || pixelY1 <= pixelY0;
                        if (isInvalid && callout.norm_bbox && callout.norm_bbox.length === 4) {
                            // Fallback: use normalized coordinates (0-1) directly as percentages
                            // norm_bbox from backend is normalized to PDF dimensions (not original image)
                            const [nx0, ny0, nx1, ny1] = callout.norm_bbox;
                            
                            // Convert normalized coords to pixels using PDF page dimensions as reference
                            pixelX0 = nx0 * pageWidth * scaleX;
                            pixelY0 = ny0 * pageHeight * scaleY;
                            pixelX1 = nx1 * pageWidth * scaleX;
                            pixelY1 = ny1 * pageHeight * scaleY;
                            coordSource = 'norm_bbox_fallback';
                            console.warn(`Callout ${calloutIdx}: Invalid bbox detected, using norm_bbox fallback [${nx0.toFixed(4)}, ${ny0.toFixed(4)}, ${nx1.toFixed(4)}, ${ny1.toFixed(4)}] = [${pixelX0.toFixed(1)}, ${pixelY0.toFixed(1)}, ${pixelX1.toFixed(1)}, ${pixelY1.toFixed(1)}]px`);
                        }

                        // Create overlay box
                        const issueBox = document.createElement('div');
                        issueBox.className = 'issue-box';
                        issueBox.title = ''; // Prevent native tooltip
                        
                        const tooltipText = callout.msg || callout.message || callout.text || 'Issue detected';
                        const uniqueIssueId = callout.id || callout.issue_id || `${currentPageNum}-${boxesAdded}`;
                        
                        // Parse structured message if it contains formatted fields
                        let parsedData = {
                            original: callout.original,
                            // Backend sends 'suggestion' (singular); also support legacy 'suggested'
                            suggested: callout.suggested || callout.suggestion,
                            note: callout.note,
                            context: callout.context,
                            // Wrap single suggestion string into array so suggestion pills always render
                            suggestions: callout.suggestions || (callout.suggestion ? [callout.suggestion] : []),
                            problem_word: callout.problem_word,
                            rule_id: callout.rule_id
                        };
                        
                        // Parse multi-line structured messages (Title:, Context:, Suggestion:, Note:, etc.)
                        if (tooltipText.includes(':') && tooltipText.includes('\n')) {
                            const lines = tooltipText.split('\n');
                            lines.forEach(line => {
                                const trimmedLine = line.trim();
                                if (trimmedLine.startsWith('Title:')) {
                                    parsedData.original = trimmedLine.replace('Title:', '').trim().replace(/^[""]|[""]$/g, '');
                                } else if (trimmedLine.startsWith('Context:')) {
                                    parsedData.context = trimmedLine.replace('Context:', '').trim().replace(/^[""]|[""]$/g, '');
                                } else if (trimmedLine.startsWith('Suggestion:') && !trimmedLine.startsWith('Suggestions:')) {
                                    parsedData.suggested = trimmedLine.replace('Suggestion:', '').trim().replace(/^[""]|[""]$/g, '');
                                } else if (trimmedLine.startsWith('Suggestions:')) {
                                    const suggStr = trimmedLine.replace('Suggestions:', '').trim();
                                    // Parse semicolon or comma separated suggestions
                                    parsedData.suggestions = suggStr.split(/[;,]/).map(s => s.trim()).filter(Boolean);
                                } else if (trimmedLine.startsWith('Note:')) {
                                    parsedData.note = trimmedLine.replace('Note:', '').trim();
                                } else if (trimmedLine.startsWith('Issue:')) {
                                    if (!parsedData.note) {
                                        parsedData.note = trimmedLine.replace('Issue:', '').trim();
                                    }
                                } else if (trimmedLine.startsWith('Issues:')) {
                                    // Extract issue words (for title case)
                                    const issueWords = trimmedLine.replace('Issues:', '').trim();
                                    if (!parsedData.note && issueWords) {
                                        parsedData.note = `Issues with: ${issueWords}`;
                                    }
                                } else if (trimmedLine.startsWith('Rule:')) {
                                    parsedData.rule_id = trimmedLine.replace('Rule:', '').trim();
                                }
                            });
                        }
                        
                        // Special handling for LanguageTool's title case detection (not structured format)
                        // Message like: "Title case detected in body text. Words 'up', 'will'..."
                        // Problem word is the actual title text (multi-line)
                        if (tooltipText.includes('Title case detected') && callout.type === 'grammar') {
                            // Extract the actual title text (usually in next lines or from problem_word)
                            const lines = tooltipText.split('\n');
                            if (lines.length > 1) {
                                // First line is the message, rest is the title text
                                parsedData.note = lines[0].trim();
                                parsedData.context = lines.slice(1).join('\n').trim();
                                // Try to capitalize first letter of each word for suggestion
                                if (parsedData.context) {
                                    parsedData.suggested = parsedData.context
                                        .split(' ')
                                        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                                        .join(' ');
                                }
                            }
                        }
                        
                        issueBox.dataset.tooltip = tooltipText;
                        issueBox.dataset.type = callout.type || callout.issue_type || 'default';
                        issueBox.dataset.issueText = callout.text || callout.original || callout.word || '';
                        issueBox.dataset.pageNum = currentPageNum;
                        issueBox.dataset.issueId = uniqueIssueId;

                        if (appState.ignoredIssueIds && appState.ignoredIssueIds.has(uniqueIssueId)) {
                            issueBox.classList.add('issue-ignored');
                            issueBox.style.display = 'none';
                        }

                        // Correct category colors matching backend annotation service
                        const _issueTypeColors = {
                            spelling:       { border: 'rgba(220,53,69,0.95)',   bg: 'rgba(220,53,69,0.12)' },
                            grammar:        { border: 'rgba(40,167,69,0.95)',   bg: 'rgba(40,167,69,0.12)' },
                            design:         { border: 'rgba(255,140,0,0.95)',   bg: 'rgba(255,140,0,0.12)' },
                            titlecase:      { border: 'rgba(155,89,182,0.95)',  bg: 'rgba(155,89,182,0.12)' },
                            title_case:     { border: 'rgba(155,89,182,0.95)',  bg: 'rgba(155,89,182,0.12)' },
                            formatting:     { border: 'rgba(52,152,219,0.95)',  bg: 'rgba(52,152,219,0.12)' },
                            double_spacing: { border: 'rgba(52,152,219,0.95)',  bg: 'rgba(52,152,219,0.12)' },
                        };
                        const _tc = _issueTypeColors[issueBox.dataset.type] || _issueTypeColors.spelling;
                        
                        // The annotated PDF preview image already has crisp 1.5px colored bounding boxes
                        // drawn at exact text positions. The HTML overlay box provides seamless interactivity
                        // with clean hover/pinned feedback without competing dashed borders.
                        issueBox.style.boxSizing = 'border-box';
                        issueBox.style.borderRadius = '2px';
                        issueBox.style.border = '1.5px solid transparent';
                        issueBox.style.background = 'transparent';

                        issueBox.addEventListener('mouseenter', () => {
                            if (!issueBox.classList.contains('issue-pinned')) {
                                issueBox.style.border = `1.5px solid ${_tc.border}`;
                                issueBox.style.background = _tc.bg;
                            }
                        });
                        issueBox.addEventListener('mouseleave', () => {
                            if (!issueBox.classList.contains('issue-pinned')) {
                                issueBox.style.border = '1.5px solid transparent';
                                issueBox.style.background = 'transparent';
                            }
                        });

                        // Image region: one box for the whole image containing all issues
                        if (callout.is_image_region) {
                            issueBox.dataset.isImageRegion = 'true';
                            if (callout.all_issues) {
                                issueBox.dataset.allIssues = JSON.stringify(callout.all_issues);
                            }
                            issueBox.style.border = '2px solid rgba(255,140,0,0.9)';
                            issueBox.style.background = 'rgba(255,140,0,0.06)';
                            issueBox.style.cursor = 'pointer';
                            const lbl = document.createElement('div');
                            lbl.style.cssText = 'position:absolute;top:6px;right:6px;background:rgba(255,140,0,0.92);color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;pointer-events:none;white-space:nowrap;';
                            lbl.textContent = `${(callout.all_issues || []).length} image issue(s) — click`;
                            issueBox.appendChild(lbl);
                        }

                        // Store parsed data for structured tooltip display
                        issueBox.dataset.original = parsedData.original || '';
                        issueBox.dataset.suggested = parsedData.suggested || '';
                        issueBox.dataset.note = parsedData.note || '';
                        issueBox.dataset.context = parsedData.context || '';
                        if (parsedData.suggestions && Array.isArray(parsedData.suggestions)) {
                            issueBox.dataset.suggestions = JSON.stringify(parsedData.suggestions);
                        }
                        
                        // Click handler to pin tooltip
                        issueBox.addEventListener('click', (e) => {
                            e.stopPropagation();
                            e.preventDefault();

                            // Image region: show aggregated all-issues tooltip
                            if (issueBox.dataset.isImageRegion === 'true') {
                                const existingPinned = document.querySelector(`.pinned-issue-tooltip[data-issue-id="${uniqueIssueId}"]`);
                                if (existingPinned) {
                                    existingPinned.remove();
                                    issueBox.classList.remove('issue-pinned');
                                    return;
                                }
                                const hoverTooltip = document.getElementById('global-issue-tooltip');
                                if (hoverTooltip) hoverTooltip.style.display = 'none';
                                issueBox.classList.add('issue-pinned');
                                let allIssues = [];
                                try { allIssues = JSON.parse(issueBox.dataset.allIssues || '[]'); } catch (_) {}
                                showImageRegionTooltip({
                                    id: uniqueIssueId,
                                    page: currentPageNum,
                                    element: issueBox,
                                    issueBox: issueBox,
                                    allIssues
                                }, e);
                                return;
                            }

                            // Check if this tooltip is already pinned
                            const existingPinned = document.querySelector(`.pinned-issue-tooltip[data-issue-id="${uniqueIssueId}"]`);
                            if (existingPinned) {
                                // Close it and remove highlight
                                existingPinned.remove();
                                issueBox.classList.remove('issue-pinned');
                                return;
                            }
                            
                            // Hide hover tooltip when pinning
                            const hoverTooltip = document.getElementById('global-issue-tooltip');
                            if (hoverTooltip) hoverTooltip.style.display = 'none';
                            
                            // Add visual indicator that this issue is pinned
                            issueBox.classList.add('issue-pinned');
                            
                            // Create pinned tooltip with full callout data (use parsed if available)
                            showPinnedTooltip({
                                id: uniqueIssueId,
                                type: issueBox.dataset.type,
                                message: tooltipText,
                                word: issueBox.dataset.issueText,
                                page: currentPageNum,
                                element: issueBox,
                                issueBox: issueBox,
                                // Use parsed data with fallback to original callout fields
                                context: parsedData.context || callout.context,
                                suggestions: parsedData.suggestions || callout.suggestions,
                                original: parsedData.original || callout.original,
                                suggested: parsedData.suggested || callout.suggested,
                                note: parsedData.note || callout.note,
                                problem_word: parsedData.problem_word || callout.problem_word,
                                rule_id: parsedData.rule_id || callout.rule_id
                            }, e);
                        });

                        // Convert to percentages
                        const pctLeft = (pixelX0 / imgWidth) * 100;
                        const pctTop = (pixelY0 / imgHeight) * 100;
                        const pctWidth = ((pixelX1 - pixelX0) / imgWidth) * 100;
                        const pctHeight = ((pixelY1 - pixelY0) / imgHeight) * 100;
                        
                        console.log(`Callout ${calloutIdx}: FINAL CSS: left=${pctLeft.toFixed(2)}%, top=${pctTop.toFixed(2)}%, width=${pctWidth.toFixed(2)}%, height=${pctHeight.toFixed(2)}% [source=${coordSource}]`);

                        issueBox.style.position = 'absolute';
                        issueBox.style.left = `${pctLeft}%`;
                        issueBox.style.top = `${pctTop}%`;
                        issueBox.style.width = `${pctWidth}%`;
                        issueBox.style.height = `${pctHeight}%`;
                        issueBox.style.pointerEvents = 'auto';

                        // When multiple issues share the same word location, keep all boxes
                        // exactly on the word. The backend already drew distinct colored boxes
                        // (red=spelling, green=grammar) in the annotated preview image; the
                        // interactive overlay boxes just need to sit on top of the word so
                        // hover/click works. Shifting boxes below the word breaks interaction.
                        if (boxCountAtLocation > 1) {
                            console.log(`[MULTIPLE BOXES] Callout ${calloutIdx}: Box ${boxIndexAtLocation + 1} of ${boxCountAtLocation} at same location — keeping all at word position`);
                        }

                        overlay.appendChild(issueBox);
                        boxesAdded++;
                    });
                    
                    console.log(`Page ${currentPageNum}: Added ${boxesAdded} hover boxes successfully`);

                    // Tooltips are handled globally via initializeSmartTooltips()
                };

                // Trigger onload if image is already loaded (cached)
                if (img.complete && img.naturalWidth > 0) {
                    img.onload();
                }
            }
            
            pageContainer.appendChild(imgWrapper);
            previewsDiv.appendChild(pageContainer);
        });

        // Page navigation controls rendered below all pages
        const navControls = createPageNavigationControls(appState.cachedPreviews.length);
        previewsDiv.appendChild(navControls);
    } else {
        previewsDiv.innerHTML = `
            <div style="text-align:center; padding: 40px; background: #f8fafc; border-radius: 8px; border: 1px dashed #cbd5e1;">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" style="margin-bottom:10px;">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="16" y1="13" x2="8" y2="13"></line>
                    <line x1="16" y1="17" x2="8" y2="17"></line>
                    <polyline points="10 9 9 9 8 9"></polyline>
                </svg>
                <h3 style="margin:0; color:#334155; font-size:16px;">Text Document</h3>
                <p style="color:#64748b; margin-top:8px; font-size:14px;">Visual annotations are only supported for PDFs and Images.<br>Please review your results in the panels on the right.</p>
            </div>
        `;
    }
}

// ---------------------------------------------------------------------
// Hover-fade tooltip: a quick-glance popup for sidebar list items
// (Spelling Mistakes, Font Explorer). Auto-fades a few seconds after
// appearing, or as soon as the cursor leaves the item.
// ---------------------------------------------------------------------
let activeHoverFadeTooltip = null;
let hoverFadeTooltipTimer = null;

function hideHoverFadeTooltip() {
    if (hoverFadeTooltipTimer) {
        clearTimeout(hoverFadeTooltipTimer);
        hoverFadeTooltipTimer = null;
    }
    if (activeHoverFadeTooltip) {
        activeHoverFadeTooltip.remove();
        activeHoverFadeTooltip = null;
    }
}

// mouseEvent is optional; when provided the tooltip appears near the cursor
// instead of above the target element's bounding rect.
function showHoverFadeTooltip(targetEl, text, mouseEvent) {
    hideHoverFadeTooltip();
    if (!text) return;

    const tip = document.createElement('div');
    tip.className = 'hover-fade-tooltip';
    tip.textContent = text;
    document.body.appendChild(tip);

    // Position in a RAF so the browser has laid out the tooltip and
    // tip.offsetWidth / offsetHeight are accurate (not 0).
    requestAnimationFrame(() => {
        const tipW = tip.offsetWidth || 240;
        const tipH = tip.offsetHeight || 38;
        let top, left;

        if (mouseEvent) {
            // Show just above the cursor where the user is hovering
            top = mouseEvent.clientY - tipH - 14;
            left = mouseEvent.clientX - tipW / 2;
        } else {
            const rect = targetEl.getBoundingClientRect();
            top  = rect.top - tipH - 10;
            left = rect.left + rect.width / 2 - tipW / 2;
        }

        tip.style.top  = `${Math.max(8, top)}px`;
        tip.style.left = `${Math.max(8, Math.min(left, window.innerWidth - tipW - 8))}px`;
        tip.classList.add('visible');
    });

    activeHoverFadeTooltip = tip;
    hoverFadeTooltipTimer = setTimeout(hideHoverFadeTooltip, 3000);
}

// textOrFn: a string, or a function returning a string computed at hover time
function attachHoverFadeTooltip(el, textOrFn) {
    el.addEventListener('mouseenter', (e) => {
        const text = typeof textOrFn === 'function' ? textOrFn() : textOrFn;
        showHoverFadeTooltip(el, text, e);   // pass cursor position
    });
    el.addEventListener('mouseleave', hideHoverFadeTooltip);
}

function updateSpellingIssuesSidebar(spellingIssues) {
    const spellingList = document.getElementById('spelling-issues-list');
    if (!spellingList) return;
    
    if (!spellingIssues || spellingIssues.length === 0) {
        spellingList.innerHTML = '<p class="info-text">No spelling issues detected</p>';
        return;
    }
    
    spellingList.innerHTML = '';
    const frag = document.createDocumentFragment();

    spellingIssues.forEach((entry, index) => {
        let wordText = '';
        let pageNum = 1;
        let issueId = null;
        if (typeof entry === 'string') {
            wordText = entry;
            issueId = `iss_spell_${index}`;
        } else if (entry && typeof entry === 'object') {
            wordText = entry.word || entry.text || entry.msg || entry.original || '';
            pageNum = entry.page || entry.page_num || entry.pageNumber || 1;
            issueId = entry.id || entry.issue_id || `iss_spell_${pageNum}_${index}`;
        }
        if (!wordText) return;

        // Normalize ligature characters
        wordText = wordText
            .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi')
            .replace(/ﬄ/g, 'ffl').replace(/ﬀ/g, 'ff').replace(/ﬅ/g, 'st');

        // Filter out spaced/kerned PDF text
        if (/^([A-Za-z] ){2,}[A-Za-z]$/.test(wordText.trim())) return;

        const isApproved = appState.approvedSpellingWords && (
            appState.approvedSpellingWords.has(wordText) ||
            Array.from(appState.approvedSpellingWords).some(w => w.toLowerCase() === wordText.toLowerCase())
        );
        const isIgnored = appState.ignoredIssueIds && appState.ignoredIssueIds.has(issueId);

        const card = document.createElement('div');
        card.className = 'issue-card';
        card.dataset.type = 'spelling';
        card.dataset.word = wordText;
        card.dataset.issueId = issueId;
        card.dataset.page = String(pageNum);

        if (isIgnored) {
            card.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:rgba(239,68,68,0.05); border-radius:4px; opacity:0.65; border-left:3px solid #ef4444;';
        } else if (isApproved) {
            card.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:rgba(0,200,0,0.08); border-radius:4px; border-left:3px solid #00c853;';
        } else {
            card.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:rgba(0,0,0,0.03); border-radius:4px; border-left:3px solid #dc3545;';
        }

        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'flex:1; cursor:pointer;';
        infoDiv.onclick = () => openPreviewPage(pageNum);

        const wordSpan = document.createElement('strong');
        wordSpan.textContent = wordText;
        if (isIgnored) wordSpan.style.textDecoration = 'line-through';
        infoDiv.appendChild(wordSpan);

        const pageBadge = document.createElement('span');
        pageBadge.style.cssText = 'font-size:10px; color:#64748b; margin-left:8px; background:#e2e8f0; padding:1px 6px; border-radius:3px;';
        pageBadge.textContent = `Page ${pageNum}`;
        infoDiv.appendChild(pageBadge);

        if (isIgnored) {
            const ignBadge = document.createElement('span');
            ignBadge.style.cssText = 'font-size:10px; color:#ef4444; margin-left:6px; font-weight:700;';
            ignBadge.textContent = 'IGNORED';
            infoDiv.appendChild(ignBadge);
        }

        card.appendChild(infoDiv);

        const actionsContainer = document.createElement('div');
        actionsContainer.style.cssText = 'display:flex; align-items:center; gap:6px; margin-left:8px; flex-shrink:0;';

        if (isIgnored) {
            const undoBtn = document.createElement('button');
            undoBtn.className = 'btn btn-sm btn-outline';
            undoBtn.style.cssText = 'font-size:11px; padding:4px 8px; color:#0284c7; border-color:#0284c7; background:#f0f9ff; cursor:pointer; border-radius:4px;';
            undoBtn.textContent = 'Undo';
            undoBtn.title = 'Restore this occurrence for this review';
            undoBtn.onclick = async () => {
                await restoreIssue(issueId, { id: issueId, word: wordText, original: wordText, page: pageNum, type: 'spelling' });
            };
            actionsContainer.appendChild(undoBtn);
        } else if (isApproved) {
            const approvedLabel = document.createElement('span');
            approvedLabel.textContent = 'Approved';
            approvedLabel.style.cssText = 'font-size:11px; color:#00c853; font-weight:700;';
            actionsContainer.appendChild(approvedLabel);
        } else {
            const approveBtn = document.createElement('button');
            approveBtn.className = 'btn btn-sm';
            approveBtn.style.cssText = 'font-size:11px; padding:4px 8px;';
            approveBtn.textContent = 'Approve';
            approveBtn.title = 'Approve word and save to your persistent dictionary';
            approveBtn.onclick = async () => {
                approveBtn.disabled = true;
                const prev = approveBtn.textContent;
                approveBtn.textContent = '...';
                try {
                    await approveSpellingWord(wordText, approveBtn);
                } catch(e) {
                    approveBtn.disabled = false;
                    approveBtn.textContent = prev;
                }
            };
            actionsContainer.appendChild(approveBtn);

            const ignoreBtn = document.createElement('button');
            ignoreBtn.className = 'btn btn-sm btn-outline';
            ignoreBtn.style.cssText = 'font-size:11px; padding:4px 8px; color:#64748b; border-color:#cbd5e1; background:#fff; cursor:pointer; border-radius:4px;';
            ignoreBtn.textContent = 'Ignore';
            ignoreBtn.title = 'Ignore only this occurrence for this review';
            ignoreBtn.onclick = async () => {
                await ignoreIssue(issueId, { id: issueId, word: wordText, original: wordText, page: pageNum, type: 'spelling' });
            };
            actionsContainer.appendChild(ignoreBtn);
        }

        card.appendChild(actionsContainer);
        frag.appendChild(card);
    });

    spellingList.appendChild(frag);
}

function updateGrammarIssuesSidebar(grammarIssues) {
    const grammarList = document.getElementById('grammar-issues-list');
    if (!grammarList) return;

    if (!grammarIssues || grammarIssues.length === 0) {
        grammarList.innerHTML = '<p class="info-text">No grammar issues detected</p>';
        return;
    }

    grammarList.innerHTML = '';
    const frag = document.createDocumentFragment();

    grammarIssues.forEach((entry, index) => {
        const pageNum = entry.page || 1;
        const issueId = entry.id || entry.issue_id || `iss_gram_${pageNum}_${index}`;
        const origText = entry.problem_word || entry.original || entry.word || 'Grammar issue';
        const suggText = (entry.suggestions && entry.suggestions[0]) || entry.suggestion || '';
        const isIgnored = appState.ignoredIssueIds && appState.ignoredIssueIds.has(issueId);

        const card = document.createElement('div');
        card.className = 'issue-card';
        card.dataset.type = 'grammar';
        card.dataset.issueId = issueId;
        card.dataset.page = String(pageNum);

        if (isIgnored) {
            card.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:rgba(239,68,68,0.05); border-radius:4px; opacity:0.65; border-left:3px solid #ef4444;';
        } else {
            card.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:rgba(0,0,0,0.03); border-radius:4px; border-left:3px solid #28a745;';
        }

        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'flex:1; cursor:pointer;';
        infoDiv.onclick = () => openPreviewPage(pageNum);

        const origSpan = document.createElement('strong');
        origSpan.textContent = origText;
        if (isIgnored) origSpan.style.textDecoration = 'line-through';
        infoDiv.appendChild(origSpan);

        if (suggText) {
            const arr = document.createElement('span');
            arr.textContent = ' → ';
            arr.style.cssText = 'color:#64748b; font-size:12px;';
            infoDiv.appendChild(arr);

            const suggSpan = document.createElement('span');
            suggSpan.textContent = suggText;
            suggSpan.style.cssText = 'color:#16a34a; font-weight:600; font-size:12px;';
            infoDiv.appendChild(suggSpan);
        }

        const pageBadge = document.createElement('span');
        pageBadge.style.cssText = 'font-size:10px; color:#64748b; margin-left:8px; background:#e2e8f0; padding:1px 6px; border-radius:3px;';
        pageBadge.textContent = `Page ${pageNum}`;
        infoDiv.appendChild(pageBadge);

        if (isIgnored) {
            const ignBadge = document.createElement('span');
            ignBadge.style.cssText = 'font-size:10px; color:#ef4444; margin-left:6px; font-weight:700;';
            ignBadge.textContent = 'IGNORED';
            infoDiv.appendChild(ignBadge);
        }

        card.appendChild(infoDiv);

        const actionsContainer = document.createElement('div');
        actionsContainer.style.cssText = 'display:flex; align-items:center; gap:6px; margin-left:8px; flex-shrink:0;';

        if (isIgnored) {
            const undoBtn = document.createElement('button');
            undoBtn.className = 'btn btn-sm btn-outline';
            undoBtn.style.cssText = 'font-size:11px; padding:4px 8px; color:#0284c7; border-color:#0284c7; background:#f0f9ff; cursor:pointer; border-radius:4px;';
            undoBtn.textContent = 'Undo';
            undoBtn.title = 'Restore this error for this review';
            undoBtn.onclick = async () => {
                await restoreIssue(issueId, { id: issueId, word: origText, original: origText, page: pageNum, type: 'grammar' });
            };
            actionsContainer.appendChild(undoBtn);
        } else {
            const ignoreBtn = document.createElement('button');
            ignoreBtn.className = 'btn btn-sm btn-outline';
            ignoreBtn.style.cssText = 'font-size:11px; padding:4px 8px; color:#64748b; border-color:#cbd5e1; background:#fff; cursor:pointer; border-radius:4px;';
            ignoreBtn.textContent = 'Ignore';
            ignoreBtn.title = 'Ignore only this occurrence for this review';
            ignoreBtn.onclick = async () => {
                await ignoreIssue(issueId, { id: issueId, word: origText, original: origText, page: pageNum, type: 'grammar' });
            };
            actionsContainer.appendChild(ignoreBtn);
        }

        card.appendChild(actionsContainer);
        frag.appendChild(card);
    });

    grammarList.appendChild(frag);
}

function updateCaseViolationsSidebar(caseIssues) {
    const violationsList = document.getElementById('case-violations-list');
    if (!violationsList) return;

    if (!caseIssues || caseIssues.length === 0) {
        violationsList.innerHTML = '<p class="info-text">No case violations found</p>';
        return;
    }

    violationsList.innerHTML = '';
    const frag = document.createDocumentFragment();

    caseIssues.forEach((entry, index) => {
        let name = '';
        let pageNum = 1;
        let issueId = null;
        let suggText = '';
        if (typeof entry === 'string') {
            name = entry;
            issueId = `iss_case_${index}`;
        } else if (entry && typeof entry === 'object') {
            name = entry.original || entry.name || entry.word || '';
            suggText = entry.suggestion || '';
            pageNum = entry.page || 1;
            issueId = entry.id || entry.issue_id || `iss_case_${pageNum}_${index}`;
        }
        if (!name) return;

        const isIgnored = appState.ignoredIssueIds && appState.ignoredIssueIds.has(issueId);

        const card = document.createElement('div');
        card.className = 'issue-card';
        card.dataset.type = 'title_case';
        card.dataset.issueId = issueId;
        card.dataset.page = String(pageNum);

        if (isIgnored) {
            card.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:rgba(239,68,68,0.05); border-radius:4px; opacity:0.65; border-left:3px solid #ef4444;';
        } else {
            card.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:rgba(0,0,0,0.03); border-radius:4px; border-left:3px solid #9b59b6;';
        }

        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'flex:1; cursor:pointer;';
        infoDiv.onclick = () => openPreviewPage(pageNum);

        const nameSpan = document.createElement('strong');
        nameSpan.textContent = name;
        if (isIgnored) nameSpan.style.textDecoration = 'line-through';
        infoDiv.appendChild(nameSpan);

        if (suggText && suggText !== name) {
            const arr = document.createElement('span');
            arr.textContent = ' → ';
            arr.style.cssText = 'color:#64748b; font-size:12px;';
            infoDiv.appendChild(arr);

            const suggSpan = document.createElement('span');
            suggSpan.textContent = suggText;
            suggSpan.style.cssText = 'color:#8e44ad; font-weight:600; font-size:12px;';
            infoDiv.appendChild(suggSpan);
        }

        const pageBadge = document.createElement('span');
        pageBadge.style.cssText = 'font-size:10px; color:#64748b; margin-left:8px; background:#e2e8f0; padding:1px 6px; border-radius:3px;';
        pageBadge.textContent = `Page ${pageNum}`;
        infoDiv.appendChild(pageBadge);

        if (isIgnored) {
            const ignBadge = document.createElement('span');
            ignBadge.style.cssText = 'font-size:10px; color:#ef4444; margin-left:6px; font-weight:700;';
            ignBadge.textContent = 'IGNORED';
            infoDiv.appendChild(ignBadge);
        }

        card.appendChild(infoDiv);

        const actionsContainer = document.createElement('div');
        actionsContainer.style.cssText = 'display:flex; align-items:center; gap:6px; margin-left:8px; flex-shrink:0;';

        if (isIgnored) {
            const undoBtn = document.createElement('button');
            undoBtn.className = 'btn btn-sm btn-outline';
            undoBtn.style.cssText = 'font-size:11px; padding:4px 8px; color:#0284c7; border-color:#0284c7; background:#f0f9ff; cursor:pointer; border-radius:4px;';
            undoBtn.textContent = 'Undo';
            undoBtn.title = 'Restore this error for this review';
            undoBtn.onclick = async () => {
                await restoreIssue(issueId, { id: issueId, word: name, original: name, page: pageNum, type: 'title_case' });
            };
            actionsContainer.appendChild(undoBtn);
        } else {
            const approveBtn = document.createElement('button');
            approveBtn.className = 'btn btn-sm';
            approveBtn.style.cssText = 'font-size:11px; padding:4px 8px;';
            approveBtn.textContent = 'Approve';
            approveBtn.title = 'Approve name/brand';
            approveBtn.onclick = async () => {
                await approveCaseViolation(name);
            };
            actionsContainer.appendChild(approveBtn);

            const ignoreBtn = document.createElement('button');
            ignoreBtn.className = 'btn btn-sm btn-outline';
            ignoreBtn.style.cssText = 'font-size:11px; padding:4px 8px; color:#64748b; border-color:#cbd5e1; background:#fff; cursor:pointer; border-radius:4px;';
            ignoreBtn.textContent = 'Ignore';
            ignoreBtn.title = 'Ignore only this occurrence for this review';
            ignoreBtn.onclick = async () => {
                await ignoreIssue(issueId, { id: issueId, word: name, original: name, page: pageNum, type: 'title_case' });
            };
            actionsContainer.appendChild(ignoreBtn);
        }

        card.appendChild(actionsContainer);
        frag.appendChild(card);
    });

    violationsList.appendChild(frag);
}

function updateFormattingIssuesSidebar(formattingIssues) {
    const formatList = document.getElementById('formatting-issues-list');
    if (!formatList) return;

    if (!formattingIssues || formattingIssues.length === 0) {
        formatList.innerHTML = '<p class="info-text">No spacing or formatting issues found</p>';
        return;
    }

    formatList.innerHTML = '';
    const frag = document.createDocumentFragment();

    formattingIssues.forEach((entry, index) => {
        const pageNum = entry.page || 1;
        const issueId = entry.id || entry.issue_id || `iss_fmt_${pageNum}_${index}`;
        const origText = entry.original || entry.word || 'Spacing issue';
        const suggText = entry.suggestion || '';
        const isIgnored = appState.ignoredIssueIds && appState.ignoredIssueIds.has(issueId);

        const card = document.createElement('div');
        card.className = 'issue-card';
        card.dataset.type = 'double_spacing';
        card.dataset.issueId = issueId;
        card.dataset.page = String(pageNum);

        if (isIgnored) {
            card.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:rgba(239,68,68,0.05); border-radius:4px; opacity:0.65; border-left:3px solid #ef4444;';
        } else {
            card.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:6px; background:rgba(0,0,0,0.03); border-radius:4px; border-left:3px solid #3498db;';
        }

        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'flex:1; cursor:pointer;';
        infoDiv.onclick = () => openPreviewPage(pageNum);

        const origSpan = document.createElement('strong');
        origSpan.textContent = origText;
        if (isIgnored) origSpan.style.textDecoration = 'line-through';
        infoDiv.appendChild(origSpan);

        if (suggText) {
            const arr = document.createElement('span');
            arr.textContent = ' → ';
            arr.style.cssText = 'color:#64748b; font-size:12px;';
            infoDiv.appendChild(arr);

            const suggSpan = document.createElement('span');
            suggSpan.textContent = suggText;
            suggSpan.style.cssText = 'color:#2980b9; font-weight:600; font-size:12px;';
            infoDiv.appendChild(suggSpan);
        }

        const pageBadge = document.createElement('span');
        pageBadge.style.cssText = 'font-size:10px; color:#64748b; margin-left:8px; background:#e2e8f0; padding:1px 6px; border-radius:3px;';
        pageBadge.textContent = `Page ${pageNum}`;
        infoDiv.appendChild(pageBadge);

        if (isIgnored) {
            const ignBadge = document.createElement('span');
            ignBadge.style.cssText = 'font-size:10px; color:#ef4444; margin-left:6px; font-weight:700;';
            ignBadge.textContent = 'IGNORED';
            infoDiv.appendChild(ignBadge);
        }

        card.appendChild(infoDiv);

        const actionsContainer = document.createElement('div');
        actionsContainer.style.cssText = 'display:flex; align-items:center; gap:6px; margin-left:8px; flex-shrink:0;';

        if (isIgnored) {
            const undoBtn = document.createElement('button');
            undoBtn.className = 'btn btn-sm btn-outline';
            undoBtn.style.cssText = 'font-size:11px; padding:4px 8px; color:#0284c7; border-color:#0284c7; background:#f0f9ff; cursor:pointer; border-radius:4px;';
            undoBtn.textContent = 'Undo';
            undoBtn.title = 'Restore this error for this review';
            undoBtn.onclick = async () => {
                await restoreIssue(issueId, { id: issueId, word: origText, original: origText, page: pageNum, type: 'double_spacing' });
            };
            actionsContainer.appendChild(undoBtn);
        } else {
            const ignoreBtn = document.createElement('button');
            ignoreBtn.className = 'btn btn-sm btn-outline';
            ignoreBtn.style.cssText = 'font-size:11px; padding:4px 8px; color:#64748b; border-color:#cbd5e1; background:#fff; cursor:pointer; border-radius:4px;';
            ignoreBtn.textContent = 'Ignore';
            ignoreBtn.title = 'Ignore only this occurrence for this review';
            ignoreBtn.onclick = async () => {
                await ignoreIssue(issueId, { id: issueId, word: origText, original: origText, page: pageNum, type: 'double_spacing' });
            };
            actionsContainer.appendChild(ignoreBtn);
        }

        card.appendChild(actionsContainer);
        frag.appendChild(card);
    });

    formatList.appendChild(frag);
}

function updatePreviewImages(previews) {
    if (!Array.isArray(previews) || previews.length === 0) return;
    appState.cachedPreviews = previews;
    appState.annotatedPreviews = previews;
    if (batchState.activeReviewIndex !== -1 && batchState.results[batchState.activeReviewIndex] && batchState.results[batchState.activeReviewIndex].result) {
        batchState.results[batchState.activeReviewIndex].result.annotated_previews = previews;
    }
    const containers = document.querySelectorAll('.preview-page-container');
    containers.forEach((pc, idx) => {
        if (previews[idx]) {
            const img = pc.querySelector('.preview-image') || pc.querySelector('.preview-page-img') || pc.querySelector('img.page-image') || pc.querySelector('img');
            if (img) {
                img.src = `data:image/png;base64,${previews[idx]}`;
            }
        }
    });
    saveActiveReviewToSession();
}

function switchErrorCategoryTab(category) {
    const tabs = document.querySelectorAll('.error-tab-btn');
    tabs.forEach(btn => {
        const isMatch = btn.dataset.category === category;
        btn.classList.toggle('active', isMatch);
        btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    const spellingSec = document.getElementById('spelling-mistakes-section');
    const grammarSec = document.getElementById('grammar-issues-section');
    const caseSec = document.getElementById('case-violations-section');
    const formatSec = document.getElementById('formatting-issues-section');

    if (category === 'all') {
        if (spellingSec) spellingSec.style.display = 'block';
        if (grammarSec) grammarSec.style.display = 'block';
        if (caseSec) caseSec.style.display = 'block';
        if (formatSec) formatSec.style.display = 'block';
    } else if (category === 'spelling') {
        if (spellingSec) spellingSec.style.display = 'block';
        if (grammarSec) grammarSec.style.display = 'none';
        if (caseSec) caseSec.style.display = 'none';
        if (formatSec) formatSec.style.display = 'none';
    } else if (category === 'grammar') {
        if (spellingSec) spellingSec.style.display = 'none';
        if (grammarSec) grammarSec.style.display = 'block';
        if (caseSec) caseSec.style.display = 'none';
        if (formatSec) formatSec.style.display = 'none';
    } else if (category === 'case') {
        if (spellingSec) spellingSec.style.display = 'none';
        if (grammarSec) grammarSec.style.display = 'none';
        if (caseSec) caseSec.style.display = 'block';
        if (formatSec) formatSec.style.display = 'none';
    } else if (category === 'formatting') {
        if (spellingSec) spellingSec.style.display = 'none';
        if (grammarSec) grammarSec.style.display = 'none';
        if (caseSec) caseSec.style.display = 'none';
        if (formatSec) formatSec.style.display = 'block';
    }
}

function initErrorCategoryTabs() {
    const tabs = document.querySelectorAll('.error-tab-btn');
    tabs.forEach(btn => {
        btn.onclick = () => {
            const cat = btn.dataset.category || 'all';
            switchErrorCategoryTab(cat);
        };
    });
}

function updateErrorCategoryCounts() {
    const isIgnored = (id) => appState.ignoredIssueIds && appState.ignoredIssueIds.has(id);

    // 1. Spelling count
    let spellingCount = 0;
    if (Array.isArray(appState.detectedSpellingIssues)) {
        appState.detectedSpellingIssues.forEach((item, idx) => {
            const id = typeof item === 'object' && item ? (item.id || item.issue_id || `iss_spell_${idx}`) : `iss_spell_${idx}`;
            if (!isIgnored(id)) spellingCount++;
        });
    }

    // 2. Grammar count
    let grammarCount = 0;
    if (Array.isArray(appState.detectedGrammarIssues)) {
        appState.detectedGrammarIssues.forEach((item, idx) => {
            const id = typeof item === 'object' && item ? (item.id || item.issue_id || `iss_gram_${idx}`) : `iss_gram_${idx}`;
            if (!isIgnored(id)) grammarCount++;
        });
    }

    // 3. Case & Title count
    let caseCount = 0;
    const caseList = (appState.detectedTitleCaseIssues && appState.detectedTitleCaseIssues.length > 0)
        ? appState.detectedTitleCaseIssues
        : appState.detectedCaseViolations;
    if (Array.isArray(caseList)) {
        caseList.forEach((item, idx) => {
            const id = typeof item === 'object' && item ? (item.id || item.issue_id || `iss_case_${idx}`) : `iss_case_${idx}`;
            if (!isIgnored(id)) caseCount++;
        });
    }

    // 4. Formatting count
    let formattingCount = 0;
    if (Array.isArray(appState.detectedFormattingIssues)) {
        appState.detectedFormattingIssues.forEach((item, idx) => {
            const id = typeof item === 'object' && item ? (item.id || item.issue_id || `iss_fmt_${idx}`) : `iss_fmt_${idx}`;
            if (!isIgnored(id)) formattingCount++;
        });
    }

    // Total active non-ignored count
    const totalCount = spellingCount + grammarCount + caseCount + formattingCount;
    appState.totalIssues = totalCount;

    // Update error category tab badges
    const elAll = document.getElementById('error-count-all');
    const elSpell = document.getElementById('error-count-spelling');
    const elGram = document.getElementById('error-count-grammar');
    const elCase = document.getElementById('error-count-case');
    const elFmt = document.getElementById('error-count-formatting');

    if (elAll) elAll.textContent = totalCount;
    if (elSpell) elSpell.textContent = spellingCount;
    if (elGram) elGram.textContent = grammarCount;
    if (elCase) elCase.textContent = caseCount;
    if (elFmt) elFmt.textContent = formattingCount;

    // Synchronize metric cards in Validation Results
    const totalEl = document.getElementById('result-issues');
    if (totalEl) totalEl.textContent = totalCount;

    const resSpell = document.getElementById('result-spelling');
    if (resSpell) resSpell.textContent = `${spellingCount}/${totalCount}`;

    const resGram = document.getElementById('result-grammar');
    if (resGram) resGram.textContent = grammarCount;

    const resFmt = document.getElementById('result-formatting');
    if (resFmt) resFmt.textContent = formattingCount + caseCount;

    const msgEl = document.getElementById('result-message');
    if (msgEl) {
        if (totalCount === 0) {
            msgEl.className = 'result-message success';
            msgEl.textContent = 'Great job! No validation issues found. The document is compliant.';
        } else {
            msgEl.className = 'result-message warning';
            msgEl.textContent = `Found ${totalCount} issue${totalCount === 1 ? '' : 's'} that require attention.`;
        }
    }

    // Synchronize batch document result if reviewing a batch item
    if (batchState.activeReviewIndex !== -1 && batchState.results[batchState.activeReviewIndex]) {
        const item = batchState.results[batchState.activeReviewIndex];
        if (item.result) {
            item.result.total_issues = totalCount;
            if (item.result.summary) {
                item.result.summary.spelling_count = spellingCount;
                item.result.summary.grammar_count = grammarCount;
                item.result.summary.title_case_count = caseCount;
                item.result.summary.formatting_count = formattingCount;
                const baseScore = 100 - (totalCount * 4);
                item.result.summary.overall_score = Math.max(0, Math.min(100, baseScore));
            }
        }
        updateBatchItemStatus(batchState.activeReviewIndex, 'completed', `Score: ${item.result.summary?.overall_score ?? 100}/100 • ${totalCount} issue${totalCount === 1 ? '' : 's'} (${item.result.summary?.verdict || ''})`);
    }
}

function resolveWordAnnotationsForCurrentDocument(word) {
    if (!word) return 0;
    const wordNorm = word.trim().toLowerCase();
    
    // 1. Gather all matching issue IDs from detected spelling issues
    const removedIds = [];
    if (Array.isArray(appState.detectedSpellingIssues)) {
        appState.detectedSpellingIssues.forEach(item => {
            const text = (typeof item === 'string' ? item : (item?.word || item?.text || item?.original || '')).toLowerCase().trim();
            if (text === wordNorm) {
                const iid = item?.id || item?.issue_id;
                if (iid && !removedIds.includes(iid)) removedIds.push(iid);
            }
        });
        appState.detectedSpellingIssues = appState.detectedSpellingIssues.filter(item => {
            const text = (typeof item === 'string' ? item : (item?.word || item?.text || item?.original || '')).toLowerCase().trim();
            return text !== wordNorm;
        });
    }

    // 2. Remove matching issue boxes from preview overlay
    let removedCount = 0;
    const containers = document.querySelectorAll('.preview-page-container');
    containers.forEach(pc => {
        const overlay = pc.querySelector('.page-issue-overlay');
        if (!overlay) return;
        const boxes = Array.from(overlay.querySelectorAll('.issue-box'));
        let removedOnPage = 0;
        boxes.forEach(box => {
            const issueType = (box.dataset.type || '').toLowerCase();
            const issueText = (box.dataset.issueText || box.dataset.original || '').toLowerCase().trim();
            const tooltip = (box.dataset.tooltip || '').toLowerCase();
            const isSpelling = !issueType || issueType === 'spelling' || issueType === 'default';
            const matchesWord = issueText === wordNorm || tooltip.includes(`word: "${wordNorm}"`) || tooltip.includes(`"${wordNorm}"`);
            if (isSpelling && matchesWord) {
                const iid = box.dataset.issueId;
                if (iid) {
                    if (!removedIds.includes(iid)) removedIds.push(iid);
                    appState.ignoredIssueIds = appState.ignoredIssueIds || new Set();
                    appState.ignoredIssueIds.add(iid);
                    document.querySelectorAll(`.pinned-issue-tooltip[data-issue-id="${iid}"]`).forEach(t => t.remove());
                }
                box.classList.add('issue-ignored');
                box.style.display = 'none';
                box.remove();
                removedOnPage++;
                removedCount++;
            }
        });
        if (removedOnPage > 0) {
            const header = pc.querySelector('.preview-page-header');
            if (header) {
                const remaining = overlay.querySelectorAll('.issue-box:not(.issue-ignored)').length;
                header.innerHTML = header.innerHTML.replace(/Issues:\s*\d+/, `Issues: ${remaining}`);
            }
        }
    });

    removedIds.forEach(iid => {
        appState.ignoredIssueIds = appState.ignoredIssueIds || new Set();
        appState.ignoredIssueIds.add(iid);
        document.querySelectorAll(`.pinned-issue-tooltip[data-issue-id="${iid}"]`).forEach(t => t.remove());
    });

    // 3. Update sidebar and counts
    updateSidebarIssues();
    updateErrorCategoryCounts();

    // 4. Update batch document if in batch review
    if (batchState.activeReviewIndex !== -1 && batchState.results[batchState.activeReviewIndex]) {
        const item = batchState.results[batchState.activeReviewIndex];
        item.ignoredIssueIds = new Set(appState.ignoredIssueIds || []);
        if (item.result) {
            item.result.spelling_issues = [...(appState.detectedSpellingIssues || [])];
        }
    }

    // 5. Sync to backend ignore for the word and all its occurrence IDs in one call
    if (appState.currentJobId) {
        const token = getStoredToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        fetch(getApiUrl(`/api/qc/ignore/${appState.currentJobId}`), {
            method: 'POST',
            headers,
            body: JSON.stringify({
                issue_ids: removedIds,
                word: word,
                original: word
            })
        }).then(r => r.json()).then(data => {
            if (data.annotated_previews && data.annotated_previews.length > 0) {
                appState.annotatedPreviews = data.annotated_previews;
                updatePreviewImages(data.annotated_previews);
            }
        }).catch(e => console.warn('Could not sync word ignore to backend:', e));
    }

    saveActiveReviewToSession();
    return Math.max(removedCount, removedIds.length);
}

function updateSidebarIssues() {
    // 1. Spelling issues
    const spellingList = document.getElementById('spelling-issues-list');
    if (spellingList) {
        if (appState.detectedSpellingIssues && appState.detectedSpellingIssues.length > 0) {
            updateSpellingIssuesSidebar(appState.detectedSpellingIssues);
        } else if (appState.validationDone) {
            spellingList.innerHTML = '<p class="info-text">All Good - No spelling issues found</p>';
        }
    }

    // 2. Grammar issues
    const grammarList = document.getElementById('grammar-issues-list');
    if (grammarList) {
        if (appState.detectedGrammarIssues && appState.detectedGrammarIssues.length > 0) {
            updateGrammarIssuesSidebar(appState.detectedGrammarIssues);
        } else if (appState.validationDone) {
            grammarList.innerHTML = '<p class="info-text">All Good - No grammar issues found</p>';
        }
    }

    // 3. Case & Title violations
    const violationsList = document.getElementById('case-violations-list');
    if (violationsList) {
        const caseIssues = (appState.detectedTitleCaseIssues && appState.detectedTitleCaseIssues.length > 0)
            ? appState.detectedTitleCaseIssues
            : appState.detectedCaseViolations;
        if (caseIssues && caseIssues.length > 0) {
            updateCaseViolationsSidebar(caseIssues);
        } else if (appState.validationDone) {
            violationsList.innerHTML = '<p class="info-text">No case violations found</p>';
        }
    }

    // 4. Formatting issues
    const formatList = document.getElementById('formatting-issues-list');
    if (formatList) {
        if (appState.detectedFormattingIssues && appState.detectedFormattingIssues.length > 0) {
            updateFormattingIssuesSidebar(appState.detectedFormattingIssues);
        } else if (appState.validationDone) {
            formatList.innerHTML = '<p class="info-text">No spacing or formatting issues found</p>';
        }
    }

    // Synchronize counts
    updateErrorCategoryCounts();
}

async function approveSpellingWord(word, anchorEl) {
    // Confirm before approving
    const confirmed = await showApproveWordModal(word, anchorEl);
    if (!confirmed) {
        return false;
    }
    
    try {
        const token = getStoredToken();
        const authHeaders = { 'Content-Type': 'application/json' };
        if (token) authHeaders['Authorization'] = `Bearer ${token}`;

        // 1. Save to user-specific dictionary in backend/database
        let userDictOk = false;
        try {
            const userResp = await fetch(getApiUrl('/api/user/dictionary'), {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ word })
            });
            if (userResp.ok) userDictOk = true;
        } catch (e) {
            console.warn('Could not save to user dictionary:', e);
        }

        // 2. Also call admin approved words for system backwards compatibility
        const response = await fetch(getApiUrl('/api/admin/approved_words'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ word })
        }).catch(() => ({ ok: false }));
        
        if (userDictOk || response.ok) {
            // Mark word as approved
            if (!appState.approvedSpellingWords) {
                appState.approvedSpellingWords = new Set();
            }
            appState.approvedSpellingWords.add(word);
            
            showUploadStatus(`Approved '${word}' — added to your dictionary`, 'success');
            showToast(`'${word}' added to your personal dictionary. It will not be flagged in future validations.`, 'success');

            // Log activity
            logUserActivity('add_dictionary', appState.uploadedFile ? appState.uploadedFile.name : (appState.fileId || ''), { word });

            // Immediately resolve annotations for this word on the active document only
            resolveWordAnnotationsForCurrentDocument(word);

            return true;
        } else {
            showUploadStatus(`Failed to approve '${word}'`, 'error');
            return false;
        }
    } catch (error) {
        console.error('Approve error:', error);
        showUploadStatus(`Error: ${error.message}`, 'error');
        return false;
    }
}

async function approveAllSpelling() {
    const wordsToApprove = [...appState.detectedSpellingIssues];
    
    // Filter out already approved words (case-insensitive)
    const unapprovedWords = wordsToApprove.filter(w => 
        !appState.approvedSpellingWords || !Array.from(appState.approvedSpellingWords).some(approved => approved.toLowerCase() === w.toLowerCase())
    );
    
    if (unapprovedWords.length === 0) {
        showUploadStatus('All words are already approved', 'success');
        return;
    }
    
    // Confirm before approving all
    const confirmed = await showApproveAllModal(unapprovedWords);
    if (!confirmed) {
        return;
    }
    
    try {
        // Approve all words in parallel
        const promises = unapprovedWords.map(word =>
            fetch(getApiUrl('/api/admin/approved_words'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ word })
            })
        );
        
        await Promise.all(promises);
        
        // Mark all as approved
        if (!appState.approvedSpellingWords) {
            appState.approvedSpellingWords = new Set();
        }
        unapprovedWords.forEach(w => appState.approvedSpellingWords.add(w));
        
        showUploadStatus(`Approved ${unapprovedWords.length} words — updating UI locally...`, 'success');

        // Remove approved words from detected list and update sidebar
        appState.detectedSpellingIssues = (appState.detectedSpellingIssues || []).filter(w => !unapprovedWords.includes(w));
        updateSpellingIssuesSidebar(appState.detectedSpellingIssues);

        // Remove visible hover boxes for approved words (page-local update)
        try {
            const containers = document.querySelectorAll('.preview-page-container');
            containers.forEach(pc => {
                const overlay = pc.querySelector('.page-issue-overlay');
                if (!overlay) return;
                const boxes = Array.from(overlay.querySelectorAll('.issue-box'));
                let removed = 0;
                boxes.forEach(box => {
                    const tip = (box.dataset.tooltip || '');
                    for (const w of unapprovedWords) {
                        if (tip.includes(w)) {
                            box.remove();
                            removed++;
                            break;
                        }
                    }
                });
                if (removed > 0) {
                    const header = pc.querySelector('.preview-page-header');
                    if (header) {
                        const remaining = overlay.querySelectorAll('.issue-box').length;
                        header.innerHTML = header.innerHTML.replace(/Issues: \d+/, `Issues: ${remaining}`);
                    }
                }
            });
        } catch (err) {
            console.warn('Failed to remove local annotations for approved words:', err);
        }
    } catch (error) {
        console.error('Approve all error:', error);
        showUploadStatus(`Error: ${error.message}`, 'error');
    }
}

async function handleFontHighlighting(event) {
    const selectedFont = event.target.value;
    
    // Clear any existing highlights
    clearFontHighlights();
    
    if (!selectedFont || !appState.fontsData[selectedFont]) {
        console.log('No font selected or font data missing');
        return;
    }
    
    if (!appState.fileId) {
        console.error('No fileId available for font highlighting');
        return;
    }
    
    const fontData = appState.fontsData[selectedFont];
    const pages = fontData.pages || [];
    
    console.log(`Highlighting font "${selectedFont}" on ${pages.length} page(s):`, pages);
    
    // Highlight font instances on each page where it appears
    for (const pageNum of pages) {
        try {
            const pageContainer = document.querySelector(`.preview-page-container[data-page-num="${pageNum}"]`);
            if (!pageContainer) {
                console.warn(`Page container not found for page ${pageNum}`);
                continue;
            }
            
            const imgWrapper = pageContainer.querySelector('.img-wrapper');
            if (!imgWrapper) {
                console.warn(`Image wrapper not found for page ${pageNum}`);
                continue;
            }
            
            const img = imgWrapper.querySelector('img');
            if (!img) {
                console.warn(`Image not found for page ${pageNum}`);
                continue;
            }
            
            // Wait for image to load if needed
            await new Promise(resolve => {
                if (img.complete && img.naturalWidth > 0) {
                    resolve();
                } else {
                    img.onload = () => resolve();
                    setTimeout(resolve, 1000); // Timeout fallback
                }
            });
            
            // Use naturalWidth for actual image dimensions (works even when hidden)
            const imgWidth = img.naturalWidth;
            const imgHeight = img.naturalHeight;
            
            // Check if image actually loaded
            if (imgWidth === 0 || imgHeight === 0) {
                console.warn(`Page ${pageNum}: Image not loaded yet (${imgWidth}x${imgHeight})`);
                continue;
            }
            
            // Fetch font rectangles from backend for this page
            const response = await fetch(getApiUrl(`/api/pdf/fonts/${encodeURIComponent(appState.fileId)}/highlight?font_name=${encodeURIComponent(selectedFont)}&page_num=${pageNum}`));
            if (!response.ok) {
                console.warn(`Failed to fetch font highlights for page ${pageNum}: ${response.status}`);
                continue;
            }
            
            const data = await response.json();
            const pageRects = data.rects || [];
            const pageWidth = data.page_width || 612;
            const pageHeight = data.page_height || 792;
            
            console.log(`Page ${pageNum}: Found ${pageRects.length} font instances, PDF size ${pageWidth}x${pageHeight}, natural image size ${imgWidth}x${imgHeight}`);
            
            if (pageRects.length === 0) continue;
            
            // Calculate scaling using natural dimensions
            const scaleX = imgWidth / pageWidth;
            const scaleY = imgHeight / pageHeight;
            
            // Create highlight layer
            const highlightLayer = document.createElement('div');
            highlightLayer.className = 'font-highlight-layer';
            highlightLayer.style.position = 'absolute';
            highlightLayer.style.top = '0';
            highlightLayer.style.left = '0';
            highlightLayer.style.width = '100%';
            highlightLayer.style.height = '100%';
            highlightLayer.style.pointerEvents = 'none';
            highlightLayer.style.zIndex = '15';
            
            // Draw highlight boxes using percentages
            pageRects.forEach((rect, idx) => {
                const box = document.createElement('div');
                box.className = 'font-highlight-box';
                box.style.position = 'absolute';
                
                // Calculate pixel positions
                const pixelX0 = rect.x0 * scaleX;
                const pixelY0 = rect.y0 * scaleY;
                const pixelX1 = rect.x1 * scaleX;
                const pixelY1 = rect.y1 * scaleY;
                
                // Convert to percentages for responsive sizing
                const pctLeft = (pixelX0 / imgWidth) * 100;
                const pctTop = (pixelY0 / imgHeight) * 100;
                const pctWidth = ((pixelX1 - pixelX0) / imgWidth) * 100;
                const pctHeight = ((pixelY1 - pixelY0) / imgHeight) * 100;
                
                box.style.left = pctLeft + '%';
                box.style.top = pctTop + '%';
                box.style.width = pctWidth + '%';
                box.style.height = pctHeight + '%';
                box.style.backgroundColor = 'rgba(255, 255, 0, 0.3)';
                box.style.border = '1px solid rgb(255, 193, 7)';
                highlightLayer.appendChild(box);
            });
            
            imgWrapper.appendChild(highlightLayer);
            console.log(`Page ${pageNum}: Added ${pageRects.length} highlight boxes`);
        } catch (error) {
            console.error(`Error highlighting font on page ${pageNum}:`, error);
        }
    }
}

function clearFontHighlights() {
    document.querySelectorAll('.font-highlight-layer').forEach(layer => layer.remove());
}

async function approveCaseViolation(name) {
    try {
        const response = await fetch(getApiUrl('/api/admin/approved_product_names'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
        });
        
        if (response.ok) {
            appState.detectedCaseViolations = appState.detectedCaseViolations.filter(n => n !== name);
            updateSidebarIssues();
            showUploadStatus(`Added '${name}' to approved product names`, 'success');
        } else {
            showUploadStatus(`Failed to approve '${name}'`, 'error');
        }
    } catch (error) {
        console.error('Approve error:', error);
        showUploadStatus(`Error: ${error.message}`, 'error');
    }
}

function updateFontExplorer() {
    const explorerDiv = document.getElementById('font-explorer');
    if (appState.fontsData && Object.keys(appState.fontsData).length > 0) {
        const fontList = Object.keys(appState.fontsData).sort();
        explorerDiv.innerHTML = `
            <div class="font-chip-list">
                ${fontList.map(font => `<div class="font-item" data-font="${font}">${font}</div>`).join('')}
            </div>
            <label>Select font to highlight:</label>
            <select id="font-select" class="input-field">
                <option value="">None</option>
                ${fontList.map(font => {
                    const fontInfo = appState.fontsData[font];
                    const pages = fontInfo.pages || [];
                    const pageList = pages.join(', ');
                    return `<option value="${font}">${font} (pages: ${pageList})</option>`;
                }).join('')}
            </select>
            <div style="margin-top: 12px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                    <input type="checkbox" id="font-highlight-checkbox" disabled style="cursor: pointer;">
                    <span>Show highlights on PDF</span>
                </label>
            </div>
            <div style="margin-top: 8px;">
                <p class="info-text">${fontList.length} font(s) detected</p>
            </div>
        `;

        // Add event listener for font selection
        const fontSelect = document.getElementById('font-select');
        const highlightCheckbox = document.getElementById('font-highlight-checkbox');

        // Hover tooltip + click-to-select on each font chip
        explorerDiv.querySelectorAll('.font-item').forEach(chip => {
            const font = chip.dataset.font;
            const pages = (appState.fontsData[font] && appState.fontsData[font].pages) || [];
            attachHoverFadeTooltip(chip, () => `${font} — used on page(s): ${pages.join(', ') || 'n/a'}`);
            chip.addEventListener('click', () => {
                explorerDiv.querySelectorAll('.font-item').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                if (fontSelect) {
                    fontSelect.value = font;
                    fontSelect.dispatchEvent(new Event('change'));
                }
            });
        });

        if (fontSelect) {
            fontSelect.addEventListener('change', (event) => {
                const selectedFont = event.target.value;
                
                // Enable/disable checkbox based on selection
                if (highlightCheckbox) {
                    highlightCheckbox.disabled = !selectedFont;
                    if (!selectedFont) {
                        highlightCheckbox.checked = false;
                        clearFontHighlights();
                    } else {
                        // Auto-check when font is selected
                        highlightCheckbox.checked = true;
                        handleFontHighlighting(event);
                    }
                }
            });
        }
        
        if (highlightCheckbox) {
            highlightCheckbox.addEventListener('change', (event) => {
                if (event.target.checked && fontSelect && fontSelect.value) {
                    handleFontHighlighting({ target: fontSelect });
                } else {
                    clearFontHighlights();
                }
            });
        }
    } else if (appState.validationDone) {
        explorerDiv.innerHTML = '<p class="info-text">No fonts detected in this PDF</p>';
    } else {
        explorerDiv.innerHTML = '<p class="info-text">Upload a PDF to explore fonts</p>';
    }
}

function onConfigChange() {
    const currentConfig = getCurrentConfig();
    const configChanged = JSON.stringify(currentConfig) !== JSON.stringify(appState.lastConfig);
    
    if (configChanged) {
        appState.lastConfig = currentConfig;
        clearValidationResults();
    }

    // Persist config to localStorage so choices (like disabling spelling) survive reloads
    saveConfigToLocalStorage(currentConfig);

    // If user disabled spelling, remove detected spelling issues from UI/state
    if (!currentConfig.spellEnabled) {
        appState.detectedSpellingIssues = [];
        updateSpellingIssuesSidebar(appState.detectedSpellingIssues);
        updateSidebarIssues();
    }
}

function getCurrentConfig() {
    return {
        brand: document.getElementById('brand-select').value,
        spellEnabled: document.getElementById('spell-enabled').checked,
        spellLanguage: document.getElementById('spell-language').value,
        runPdfOcr: appState.preferHybrid === true
    };
}

// Persist user config in localStorage
function saveConfigToLocalStorage(config) {
    try {
        localStorage.setItem('qc_config', JSON.stringify(config || getCurrentConfig()));
    } catch (e) {
        console.warn('Could not save config to localStorage:', e);
    }
}

// Load saved config and apply to UI elements
function loadSavedConfig() {
    try {
        const raw = localStorage.getItem('qc_config');
        if (!raw) return;
        const saved = JSON.parse(raw);

        if (saved.brand) {
            const brandEl = document.getElementById('brand-select');
            if (brandEl) {
                brandEl.value = saved.brand;
                appState.currentBrand = saved.brand;
            }
        }

        if (typeof saved.spellEnabled === 'boolean') {
            const spellEl = document.getElementById('spell-enabled');
            if (spellEl) spellEl.checked = saved.spellEnabled;
        }

        if (saved.spellLanguage) {
            const langEl = document.getElementById('spell-language');
            if (langEl) langEl.value = saved.spellLanguage;
        }

        if (typeof saved.runPdfOcr === 'boolean') {
            appState.preferHybrid = saved.runPdfOcr;
            const contentTypeSelect = document.getElementById('content-type-select');
            if (contentTypeSelect) contentTypeSelect.value = saved.runPdfOcr ? 'hybrid' : 'text';
        }

        // Apply brand-dependent UI updates
        updateBrandFeatureDisplay();

        // If spelling is disabled, remove any previously detected spelling issues
        if (saved.spellEnabled === false) {
            appState.detectedSpellingIssues = [];
            updateSpellingIssuesSidebar(appState.detectedSpellingIssues);
            updateSidebarIssues();
        }

        // Save loaded config as lastConfig to avoid immediate change-trigger
        // Enforce default preferences on every page load:
        // - Enable spell checking
        // - Enable title case detection
        try {
            const spellEl = document.getElementById('spell-enabled');
            const titleEl = document.getElementById('title-case-enabled');
            if (spellEl) spellEl.checked = true;
            if (titleEl) titleEl.checked = true;
        } catch (e) {}

        appState.lastConfig = getCurrentConfig();
    } catch (e) {
        console.warn('Could not load saved config:', e);
    }
}

function clearValidationResults() {
    appState.validationDone = false;
    appState.outputPath = null;
    appState.totalIssues = 0;
    appState.pageIssues = [];
    appState.fontsUsed = [];
    appState.detectedSpellingIssues = [];
    appState.ignoredIssueIds = new Set();
    appState.ignoredIssuesData = new Map();
    try { sessionStorage.removeItem('qc_active_review'); } catch (e) {}
    
    // Clear DOM elements
    document.getElementById('results-section').style.display = 'none';
    document.getElementById('preview-section').style.display = 'none';

    // Audit Log only reappears once the next validation run completes
    const auditLogSection = document.getElementById('audit-log-section');
    if (auditLogSection) auditLogSection.style.display = 'none';

    // Zone Detection is NOT cleared here — zone data (text/image boxes) is fetched
    // at upload time and is independent of validation results. It stays visible.

    // Clear spelling and grammar issue lists
    const spellingList = document.getElementById('spelling-issues-list');
    if (spellingList) {
        spellingList.innerHTML = '<p class="info-text">No validation run yet</p>';
    }
    
    const grammarList = document.getElementById('grammar-issues-list');
    if (grammarList) {
        grammarList.innerHTML = '<p class="info-text">No validation run yet</p>';
    }
}

function createPageNavigationControls(totalPages) {
    const nav = document.createElement('div');
    nav.className = 'page-navigation';
    nav.innerHTML = `
        <button class="btn btn-sm" onclick="navigatePage(-1)">← Previous</button>
        <span class="page-indicator">Page <span id="current-page">1</span> of ${totalPages}</span>
        <button class="btn btn-sm" onclick="navigatePage(1)">Next →</button>
    `;
    return nav;
}

function navigatePage(direction) {
    const pages = document.querySelectorAll('.preview-page-container');
    const currentPageEl = document.getElementById('current-page');
    let currentPage = parseInt(currentPageEl.textContent);

    // Clear any pinned tooltips when changing pages
    document.querySelectorAll('.pinned-issue-tooltip').forEach(t => t.remove());
    document.querySelectorAll('.issue-pinned').forEach(el => el.classList.remove('issue-pinned'));
    
    // Hide current page
    if (pages[currentPage - 1]) {
        // remove active marker and hide image wrapper when hiding
        pages[currentPage - 1].classList.remove('active');
        pages[currentPage - 1].style.display = 'none';
        const prevImgWrap = pages[currentPage - 1].querySelector('.img-wrapper');
        if (prevImgWrap) prevImgWrap.style.display = 'none';
        // mark as collapsed and update icon
        pages[currentPage - 1].dataset.collapsed = 'true';
        const prevHeader = pages[currentPage - 1].querySelector('.preview-page-header .expand-icon');
        if (prevHeader) prevHeader.textContent = '▶';
    }

    // Update page number
    currentPage += direction;
    if (currentPage < 1) currentPage = 1;
    if (currentPage > pages.length) currentPage = pages.length;

    // Show new page
    if (pages[currentPage - 1]) {
        pages[currentPage - 1].style.display = 'block';
        pages[currentPage - 1].classList.add('active');
        // ensure the image wrapper for the active page is visible
        const newImgWrap = pages[currentPage - 1].querySelector('.img-wrapper');
        if (newImgWrap) newImgWrap.style.display = 'block';
        // ensure expanded state and update icon
        pages[currentPage - 1].dataset.collapsed = 'false';
        const newHeader = pages[currentPage - 1].querySelector('.preview-page-header .expand-icon');
        if (newHeader) newHeader.textContent = '▼';
        pages[currentPage - 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    currentPageEl.textContent = currentPage;
}


function showImageRegionTooltip(issue, clickEvt) {
    const tooltip = document.createElement('div');
    tooltip.className = 'pinned-issue-tooltip';
    tooltip.dataset.issueId = issue.id;

    let maxZIndex = 10004;
    document.querySelectorAll('.pinned-issue-tooltip').forEach(t => {
        const z = parseInt(t.style.zIndex || 10004);
        if (z >= maxZIndex) maxZIndex = z + 1;
    });
    tooltip.style.zIndex = maxZIndex;

    const allIssues = issue.allIssues || [];

    let issueRows = '';
    allIssues.forEach((iss, idx) => {
        const issId = iss.id || iss.issue_id || `iss_img_row_${issue.page}_${idx}`;
        const isRowIgnored = appState.ignoredIssueIds && appState.ignoredIssueIds.has(issId);
        const catColor = iss.category === 'spelling' ? '#dc3545' : iss.category === 'grammar' ? '#28a745' : '#3498db';
        issueRows += `
            <div class="image-region-issue-row" data-issue-id="${issId}" style="padding:8px;margin-bottom:8px;background:rgba(255,255,255,0.04);border-radius:4px;border-left:3px solid ${catColor};display:flex;justify-content:space-between;align-items:flex-start;gap:8px;${isRowIgnored ? 'opacity:0.6;' : ''}">
                <div style="flex:1;">
                    <div style="display:flex;gap:6px;align-items:center;margin-bottom:5px;">
                        <span style="background:${catColor};color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px;">${iss.category.toUpperCase()}</span>
                        <span style="background:${catColor}22;color:${catColor};font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;">${iss.severity}</span>
                        ${isRowIgnored ? '<span style="color:#ef4444;font-size:10px;font-weight:700;">IGNORED</span>' : ''}
                    </div>
                    ${iss.original ? `<div style="margin-bottom:4px;"><strong style="color:#ff9090;">Original:</strong> <span style="color:#fff;font-style:italic;${isRowIgnored ? 'text-decoration:line-through;' : ''}">"${iss.original}"</span></div>` : ''}
                    ${iss.suggestion ? `<div style="margin-bottom:4px;"><strong style="color:#90ff90;">Suggestion:</strong> <span style="color:#b3ffb3;font-style:italic;">"${iss.suggestion}"</span></div>` : ''}
                    <div style="color:#bbb;font-size:11px;line-height:1.4;">${iss.description}</div>
                </div>
                <div style="flex-shrink:0;margin-top:2px;">
                    ${isRowIgnored ? `
                        <button class="btn-row-restore" data-issue-id="${issId}" style="background:rgba(56,189,248,0.15); border:1px solid #38bdf8; color:#7dd3fc; padding:3px 8px; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer;">Undo</button>
                    ` : `
                        <button class="btn-row-ignore" data-issue-id="${issId}" style="background:rgba(239,68,68,0.15); border:1px solid #ef4444; color:#fca5a5; padding:3px 8px; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer;">Ignore</button>
                    `}
                </div>
            </div>
        `;
    });

    const isIgnored = appState.ignoredIssueIds && appState.ignoredIssueIds.has(issue.id);

    tooltip.innerHTML = `
        <div class="pinned-tooltip-header" style="border-left: 4px solid #ff8c00;">
            <div class="pinned-tooltip-badges">
                <span class="issue-type-badge" style="background-color:#ff8c00;">IMAGE</span>
                <span class="issue-page-badge">Page ${issue.page}</span>
                <span style="font-size:11px;color:#ccc;margin-left:6px;">${allIssues.length} issue(s) found</span>
                ${isIgnored ? '<span style="background:rgba(239,68,68,0.25);color:#fca5a5;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;margin-left:4px;">IGNORED</span>' : ''}
            </div>
            <button class="pinned-close-btn">✕</button>
        </div>
        <div class="pinned-tooltip-body" style="max-height:340px;overflow-y:auto;">
            ${issueRows || '<div style="color:#aaa;padding:8px;">No issue details available.</div>'}
        </div>
        <div class="pinned-tooltip-footer" style="padding: 10px 14px; background: rgba(0,0,0,0.35); border-top: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: flex-end; align-items: center; gap: 8px;">
            ${isIgnored ? `
                <button class="btn-restore-issue" style="background:rgba(56,189,248,0.15); border:1px solid #38bdf8; color:#7dd3fc; padding:5px 12px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:5px;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                    Undo Ignore
                </button>
            ` : `
                <button class="btn-ignore-issue" style="background:rgba(239,68,68,0.15); border:1px solid #ef4444; color:#fca5a5; padding:5px 12px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:5px;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                    Ignore Error
                </button>
            `}
        </div>
    `;

    // Row-level ignore and restore buttons
    tooltip.querySelectorAll('.btn-row-ignore').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const rowIssId = btn.dataset.issueId;
            const targetIss = allIssues.find(i => (i.id || i.issue_id) === rowIssId) || { id: rowIssId, page: issue.page };
            btn.disabled = true;
            btn.textContent = '...';
            await ignoreIssue(rowIssId, targetIss);
            showImageRegionTooltip(issue, clickEvt);
        });
    });

    tooltip.querySelectorAll('.btn-row-restore').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const rowIssId = btn.dataset.issueId;
            const targetIss = allIssues.find(i => (i.id || i.issue_id) === rowIssId) || { id: rowIssId, page: issue.page };
            btn.disabled = true;
            btn.textContent = '...';
            await restoreIssue(rowIssId, targetIss);
            showImageRegionTooltip(issue, clickEvt);
        });
    });

    const imgIgnoreBtn = tooltip.querySelector('.btn-ignore-issue');
    if (imgIgnoreBtn) {
        imgIgnoreBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            imgIgnoreBtn.disabled = true;
            imgIgnoreBtn.textContent = 'Ignoring...';
            await ignoreIssue(issue.id, issue, tooltip);
        });
    }

    const imgRestoreBtn = tooltip.querySelector('.btn-restore-issue');
    if (imgRestoreBtn) {
        imgRestoreBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            imgRestoreBtn.disabled = true;
            imgRestoreBtn.textContent = 'Restoring...';
            await restoreIssue(issue.id, issue, tooltip);
        });
    }

    const closeBtn = tooltip.querySelector('.pinned-close-btn');
    closeBtn.addEventListener('click', () => {
        tooltip.remove();
        if (issue.issueBox) issue.issueBox.classList.remove('issue-pinned');
    });

    tooltip.addEventListener('mousedown', () => {
        let newMaxZ = 10004;
        document.querySelectorAll('.pinned-issue-tooltip').forEach(t => {
            const z = parseInt(t.style.zIndex || 10004);
            if (z >= newMaxZ) newMaxZ = z + 1;
        });
        tooltip.style.zIndex = newMaxZ;
    });

    document.body.appendChild(tooltip);

    // Double-rAF so layout is complete and getBoundingClientRect() returns real dimensions.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const tr = tooltip.getBoundingClientRect();
        const tw = tr.width  || 320;
        const th = tr.height || 200;

        // Position beside the image: find the img-wrapper and anchor to its right edge
        const pageContainer = issue.issueBox ? issue.issueBox.closest('.preview-page-container') : null;
        const imgWrapper = pageContainer ? pageContainer.querySelector('.img-wrapper') : null;

        let left, top;
        if (imgWrapper) {
            const imgRect = imgWrapper.getBoundingClientRect();
            left = imgRect.right + 16;
            top = imgRect.top + 20;
            if (left + tw > vw - 12) left = imgRect.left - tw - 16;
        } else {
            const anchorX = clickEvt ? clickEvt.clientX : vw / 2;
            const anchorY = clickEvt ? clickEvt.clientY : vh / 2;
            left = anchorX + 18;
            top = anchorY - th / 2;
            if (left + tw > vw - 12) left = anchorX - tw - 18;
        }

        if (left < 10) left = 10;
        if (top + th > vh - 12) top = vh - th - 12;
        if (top < 10) top = 10;

        tooltip.style.left = `${left}px`;
        tooltip.style.top  = `${top}px`;

        makeDraggable(tooltip);
        setTimeout(() => tooltip.classList.add('active'), 10);
    }));
}

function showPinnedTooltip(issue, clickEvt) {
    const typeLabel = (issue.type || 'issue').toUpperCase();
    const typeColor = {
        'spelling': '#dc3545',
        'grammar': '#3498db',
        'design': '#ff8c00',
        'titlecase': '#9b59b6',
        'formatting': '#f39c12'
    }[issue.type] || '#dc3545';
    
    const tooltip = document.createElement('div');
    tooltip.className = 'pinned-issue-tooltip';
    tooltip.dataset.issueId = issue.id;
    
    // Track the highest z-index for stacking
    let maxZIndex = 10004;
    document.querySelectorAll('.pinned-issue-tooltip').forEach(t => {
        const z = parseInt(t.style.zIndex || 10004);
        if (z >= maxZIndex) maxZIndex = z + 1;
    });
    tooltip.style.zIndex = maxZIndex;
    // Format context, suggestion, and note - CONSISTENT FORMAT FOR ALL TYPES
    let contextText = '';
    let suggestionText = '';
    let noteText = '';

    // Populate fields consistently, preferring structured fields when present
    if (issue.context) contextText = issue.context;
    if (!contextText && issue.problem_word) contextText = issue.problem_word;
    if (!contextText && issue.original) contextText = issue.original;
    if (!contextText && issue.word) contextText = issue.word;

    // Suggestion: try replacements first, then suggestions/suggested
    if (issue.replacements && Array.isArray(issue.replacements) && issue.replacements.length > 0) {
        suggestionText = issue.replacements[0];
    } else if (issue.suggestions && Array.isArray(issue.suggestions) && issue.suggestions.length > 0) {
        suggestionText = issue.suggestions[0];
    } else if (issue.suggestions && typeof issue.suggestions === 'string') {
        suggestionText = issue.suggestions;
    } else if (issue.suggested) {
        suggestionText = issue.suggested;
    }

    // Note/message (initial raw text)
    noteText = issue.message || issue.note || (issue.rule_id ? `Rule: ${issue.rule_id}` : '');

    // For grammar issues that use structured multi-line messages (Context:/Suggestion:/Note:),
    // parse the message into dedicated fields so the pinned tooltip can render them separately.
    if ((issue.type === 'grammar' || issue.type === 'titlecase') && typeof noteText === 'string' && noteText.includes(':')) {
        const lines = noteText.split('\n');
        let parsedContext = '';
        let parsedSuggestion = '';
        let parsedNote = '';

        lines.forEach((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('Context:')) {
                parsedContext = trimmed.replace('Context:', '').trim().replace(/^['"]|['"]$/g, '');
            } else if (trimmed.startsWith('Suggestion:') && !trimmed.startsWith('Suggestions:')) {
                parsedSuggestion = trimmed.replace('Suggestion:', '').trim().replace(/^['"]|['"]$/g, '');
            } else if (trimmed.startsWith('Suggestions:')) {
                // keep raw suggestions in case we want to surface them later
                const suggStr = trimmed.replace('Suggestions:', '').trim();
                issue.suggestions = suggStr.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
            } else if (trimmed.startsWith('Note:')) {
                parsedNote = trimmed.replace('Note:', '').trim();
            }
        });

        if (parsedContext) contextText = contextText || parsedContext;
        if (parsedSuggestion) suggestionText = suggestionText || parsedSuggestion;
        if (parsedNote) noteText = parsedNote;
    }

    // Normalize text for dedup checks
    const normalizeText = (t) => String(t || '').trim().toLowerCase();
    const contextNorm = normalizeText(contextText);
    const suggestionNorm = normalizeText(suggestionText);
    const noteNorm = normalizeText(noteText);

    // Build tooltip content in the strict Context / Suggestion / Note order
    let bodyContent = '';
    if (contextText && contextText.trim()) {
        bodyContent += `<div class="tooltip-section" style="background: rgba(77,184,255,0.1); border-left: 3px solid #4db8ff; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #4db8ff;">Context:</strong> <span style="font-style: italic;">"${contextText}"</span></div>`;
    }
    if (suggestionText && suggestionText.trim() && suggestionNorm !== contextNorm) {
        bodyContent += `<div class="tooltip-section" style="background: rgba(102,255,102,0.1); border-left: 3px solid #66ff66; padding: 8px; margin-bottom: 8px; border-radius: 4px;"><strong style="color: #66ff66;">Suggestion:</strong> <span style="color: #b3ffb3;">"${suggestionText}"</span></div>`;
    }
    if (noteText && noteText.trim() && noteNorm !== contextNorm && noteNorm !== suggestionNorm) {
        bodyContent += `<div class="tooltip-section" style="background: rgba(255,167,38,0.1); border-left: 3px solid #ffa726; padding: 8px; border-radius: 4px;"><strong style="color: #ffa726;">Note:</strong> <span style="color: #ddd;">${noteText}</span></div>`;
    }
    if (!bodyContent) {
        const fallbackText = issue.context || issue.word || issue.text || issue.message || 'Issue detected';
        bodyContent = `<div class="tooltip-section">${fallbackText}</div>`;
    }
    
    const isIgnored = appState.ignoredIssueIds && appState.ignoredIssueIds.has(issue.id);

    tooltip.innerHTML = `
        <div class="pinned-tooltip-header" style="border-left: 4px solid ${typeColor};">
            <div class="pinned-tooltip-badges">
                <span class="issue-type-badge" style="background-color: ${typeColor};">${typeLabel}</span>
                <span class="issue-page-badge">Page ${issue.page}</span>
                ${isIgnored ? '<span style="background:rgba(239,68,68,0.25);color:#fca5a5;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;margin-left:4px;">IGNORED</span>' : ''}
            </div>
            <button class="pinned-close-btn">✕</button>
        </div>
        <div class="pinned-tooltip-body">
            ${bodyContent}
        </div>
        <div class="pinned-tooltip-footer" style="padding: 10px 14px; background: rgba(0,0,0,0.35); border-top: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: flex-end; align-items: center; gap: 8px;">
            ${isIgnored ? `
                <button class="btn-restore-issue" style="background:rgba(56,189,248,0.15); border:1px solid #38bdf8; color:#7dd3fc; padding:5px 12px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:5px;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                    Undo Ignore
                </button>
            ` : `
                <button class="btn-ignore-issue" style="background:rgba(239,68,68,0.15); border:1px solid #ef4444; color:#fca5a5; padding:5px 12px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:5px;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                    Ignore Error
                </button>
            `}
        </div>
    `;

    const pinIgnoreBtn = tooltip.querySelector('.btn-ignore-issue');
    if (pinIgnoreBtn) {
        pinIgnoreBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            pinIgnoreBtn.disabled = true;
            pinIgnoreBtn.textContent = 'Ignoring...';
            await ignoreIssue(issue.id, issue, tooltip);
        });
    }

    const pinRestoreBtn = tooltip.querySelector('.btn-restore-issue');
    if (pinRestoreBtn) {
        pinRestoreBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            pinRestoreBtn.disabled = true;
            pinRestoreBtn.textContent = 'Restoring...';
            await restoreIssue(issue.id, issue, tooltip);
        });
    }
    
    // Close button handler
    const closeBtn = tooltip.querySelector('.pinned-close-btn');
    closeBtn.addEventListener('click', () => {
        tooltip.remove();
        // Remove highlight from issue box
        if (issue.issueBox) {
            issue.issueBox.classList.remove('issue-pinned');
        }
    });
    
    // Click anywhere on tooltip to bring to front
    tooltip.addEventListener('mousedown', () => {
        let newMaxZ = 10004;
        document.querySelectorAll('.pinned-issue-tooltip').forEach(t => {
            const z = parseInt(t.style.zIndex || 10004);
            if (z >= newMaxZ) newMaxZ = z + 1;
        });
        tooltip.style.zIndex = newMaxZ;
    });
    
    document.body.appendChild(tooltip);

    // Double-rAF: first frame lets the browser lay out the tooltip so
    // getBoundingClientRect() returns real dimensions, not zeros.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const tr = tooltip.getBoundingClientRect();
        const tw = tr.width  || 320;
        const th = tr.height || 200;

        // Anchor beside the issue box, not at raw click coordinates.
        // This keeps the tooltip next to the flagged word/region regardless
        // of where on the box the user clicked.
        const boxEl = issue.issueBox || issue.element;
        const boxRect = boxEl ? boxEl.getBoundingClientRect() : null;

        let anchorRight  = boxRect ? boxRect.right  : (clickEvt ? clickEvt.clientX : vw / 2);
        let anchorLeft   = boxRect ? boxRect.left   : anchorRight;
        let anchorMidY   = boxRect ? boxRect.top + boxRect.height / 2
                                   : (clickEvt ? clickEvt.clientY : vh / 2);

        let left = anchorRight + 18;          // to the right of the box
        let top  = anchorMidY - th / 2;      // vertically centred on the box

        if (left + tw > vw - 12) left = anchorLeft - tw - 18;  // flip left if overflows
        if (left < 10) left = 10;
        if (top + th > vh - 12) top = vh - th - 12;
        if (top < 10) top = 10;

        tooltip.style.left = `${left}px`;
        tooltip.style.top  = `${top}px`;

        makeDraggable(tooltip);
        setTimeout(() => tooltip.classList.add('active'), 10);
    }));
}

function makeDraggable(element) {
    const header = element.querySelector('.pinned-tooltip-header');
    if (!header) return;
    
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 0;
    let yOffset = 0;
    
    header.style.cursor = 'move';
    
    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    
    function dragStart(e) {
        // Don't drag if clicking on close button
        if (e.target.closest('.pinned-close-btn')) {
            return;
        }
        
        const rect = element.getBoundingClientRect();
        initialX = e.clientX - rect.left;
        initialY = e.clientY - rect.top;
        
        isDragging = true;
        element.style.transition = 'none';
    }
    
    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            
            // Keep within viewport bounds
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const rect = element.getBoundingClientRect();
            
            currentX = Math.max(0, Math.min(currentX, viewportWidth - rect.width));
            currentY = Math.max(0, Math.min(currentY, viewportHeight - rect.height));
            
            element.style.left = currentX + 'px';
            element.style.top = currentY + 'px';
        }
    }
    
    function dragEnd(e) {
        if (isDragging) {
            isDragging = false;
            element.style.transition = '';
        }
    }
}

function showUploadStatus(message, type = 'success') {
    if (type === 'error') {
        showErrorToast(message);
        return;
    }
    const statusDiv = document.getElementById('upload-status');
    statusDiv.textContent = message;
    statusDiv.className = `upload-status ${type}`;
}

let errorToastTimer = null;

function showErrorToast(message) {
    const toast = document.getElementById('error-toast');
    const text = document.getElementById('error-toast-text');
    if (!toast || !text) return;

    text.textContent = message;
    toast.classList.add('show');

    clearTimeout(errorToastTimer);
    errorToastTimer = setTimeout(() => toast.classList.remove('show'), 6000);
}

function hideErrorToast() {
    const toast = document.getElementById('error-toast');
    if (!toast) return;
    clearTimeout(errorToastTimer);
    toast.classList.remove('show');
}

function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// Make functions globally accessible for inline onclick handlers
window.approveSpellingWord = approveSpellingWord;
window.approveCaseViolation = approveCaseViolation;
window.navigatePage = navigatePage;

// ========================================
// FONT EXPLORER MODULE
// ========================================

async function loadFontExplorer() {
    if (!appState.fileId) return;

    const fontExplorerDiv = document.getElementById('font-explorer');
    fontExplorerDiv.innerHTML = '<p class="info-text">Loading fonts...</p>';

    try {
        const response = await fetch(getApiUrl(`/api/pdf/fonts/${appState.fileId}`));
        if (!response.ok) throw new Error('Failed to fetch fonts');
        const data = await response.json();
        // Backend returns {font_name: {pages, page_count}} — store directly
        appState.fontsData = data.fonts || {};
        updateFontExplorer();
    } catch (error) {
        console.error('Font explorer error:', error);
        fontExplorerDiv.innerHTML = '<p class="error-text">Failed to load fonts</p>';
    }
}

// ========================================
// Modal Dialog Helpers
// ========================================

/**
 * Show modal for approving a single word
 * @param {string} word - Word to approve
 * @returns {Promise<boolean>} true if user confirms, false otherwise
 */
function showApproveWordModal(word, anchorEl) {
    return new Promise((resolve) => {
        // Build a fresh popover div directly on <body> — avoids all CSS cascade,
        // stacking context, and containing-block issues from the .modal structure.
        const popW = 260;
        const popH = 160;

        const popover = document.createElement('div');
        popover.style.cssText = [
            'position:fixed',
            'z-index:999999',
            'background:#fff',
            'border-radius:10px',
            'padding:20px',
            `width:${popW}px`,
            'box-shadow:0 6px 24px rgba(0,0,0,0.2),0 0 0 1px rgba(0,0,0,0.06)',
            'font-family:Inter,sans-serif',
        ].join(';');

        popover.innerHTML = `
            <h3 style="margin:0 0 10px;font-size:15px;font-weight:700;color:#2b318d;">Add to Dictionary</h3>
            <p style="margin:0 0 8px;font-size:13px;">Add "<strong>${word}</strong>" to approved dictionary?</p>
            <p style="margin:0 0 14px;font-size:12px;color:#666;">This will prevent it from being flagged as a spelling error in future validations.</p>
            <div style="display:flex;gap:8px;">
                <button id="_approve-yes" style="flex:1;padding:8px;background:#2b318d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">Add to Dictionary</button>
                <button id="_approve-no" style="flex:1;padding:8px;background:#eee;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>
            </div>`;

        // Position next to the anchor button
        let top, left;
        if (anchorEl) {
            const rect = anchorEl.getBoundingClientRect();
            top = rect.bottom + 8;
            left = rect.left;
            if (top + popH > window.innerHeight - 8) top = rect.top - popH - 8;
            if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
        } else {
            top = (window.innerHeight - popH) / 2;
            left = (window.innerWidth - popW) / 2;
        }
        popover.style.top = `${Math.max(8, top)}px`;
        popover.style.left = `${Math.max(8, left)}px`;

        document.body.appendChild(popover);

        const cleanup = () => document.body.removeChild(popover);

        popover.querySelector('#_approve-yes').addEventListener('click', () => { cleanup(); resolve(true); });
        popover.querySelector('#_approve-no').addEventListener('click', () => { cleanup(); resolve(false); });

        // Dismiss on outside click
        const onOutside = (e) => {
            if (!popover.contains(e.target)) {
                cleanup();
                document.removeEventListener('mousedown', onOutside);
                resolve(false);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
    });
}

/**
 * Show modal for approving multiple words
 * @param {string[]} words - Array of words to approve
 * @returns {Promise<boolean>} true if user confirms, false otherwise
 */
function showApproveAllModal(words) {
    return new Promise((resolve) => {
        const modal = document.getElementById('approve-all-modal');
        const countSpan = document.getElementById('approve-all-count');
        const wordsList = document.getElementById('approve-all-words');
        const yesBtn = document.getElementById('approve-all-yes-btn');
        const noBtn = document.getElementById('approve-all-no-btn');
        
        countSpan.textContent = words.length;
        wordsList.textContent = words.join(', ');
        modal.style.display = 'flex';
        
        const handleYes = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(true);
        };
        
        const handleNo = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(false);
        };
        
        const cleanup = () => {
            yesBtn.removeEventListener('click', handleYes);
            noBtn.removeEventListener('click', handleNo);
        };
        
        yesBtn.addEventListener('click', handleYes);
        noBtn.addEventListener('click', handleNo);
    });
}

// ========================================
// Parallel Batch Processing (Up to 5 documents)
// ========================================

const batchState = {
    files: [],
    results: [],
    isRunning: false,
    cancelled: false,
    activeReviewIndex: -1
};

function renderSelectedFilesChips(files) {
    const container = document.getElementById('selected-files-container');
    const countEl = document.getElementById('selected-files-count');
    const listEl = document.getElementById('selected-files-list');
    const clearBtn = document.getElementById('clear-selected-files-btn');
    if (!container || !listEl) return;

    if (!files || files.length === 0) {
        container.style.display = 'none';
        listEl.innerHTML = '';
        return;
    }

    container.style.display = 'block';
    if (countEl) countEl.textContent = `${files.length} of 5 documents selected`;

    listEl.innerHTML = '';
    files.forEach((f, idx) => {
        const chip = document.createElement('div');
        chip.className = 'selected-file-chip';
        const sizeMb = (f.size / (1024 * 1024)).toFixed(1);
        chip.innerHTML = `
            <span>📄 ${f.name} (${sizeMb} MB)</span>
            <span class="selected-file-remove" title="Remove file" onclick="removeSelectedBatchFile(${idx})">&times;</span>
        `;
        listEl.appendChild(chip);
    });

    if (clearBtn) {
        clearBtn.onclick = () => {
            const input = document.getElementById('file-upload');
            if (input) input.value = '';
            appState.selectedBatchFiles = [];
            container.style.display = 'none';
            listEl.innerHTML = '';
            const batchSec = document.getElementById('batch-section');
            if (batchSec) batchSec.style.display = 'none';
        };
    }
}

function removeSelectedBatchFile(index) {
    if (!appState.selectedBatchFiles) return;
    appState.selectedBatchFiles.splice(index, 1);
    renderSelectedFilesChips(appState.selectedBatchFiles);
    if (appState.selectedBatchFiles.length === 0) {
        const input = document.getElementById('file-upload');
        if (input) input.value = '';
        const batchSec = document.getElementById('batch-section');
        if (batchSec && !batchState.isRunning) batchSec.style.display = 'none';
    }
}

/**
 * Handle batch upload & parallel validation of up to 5 documents
 * @param {File[]} files - Array of files to process
 */
async function handleBatchUpload(files) {
    if (!files || files.length === 0) return;

    // Enforce 5-document limit
    if (files.length > 5) {
        showToast("Maximum 5 documents allowed per batch. Processing first 5 documents.", "warning");
        files = files.slice(0, 5);
    }

    // Prevent duplicate submissions
    if (batchState.isRunning) {
        showToast("A batch is already running. Please wait or cancel.", "info");
        return;
    }

    batchState.isRunning = true;
    batchState.files = files;
    batchState.results = new Array(files.length).fill(null);
    batchState.cancelled = false;
    batchState.activeReviewIndex = -1;

    // Disable run button and file input to prevent duplicate submission
    const runBtn = document.getElementById('run-validation-btn');
    const fileInput = document.getElementById('file-upload');
    if (runBtn) {
        runBtn.disabled = true;
        runBtn.classList.add('btn-running');
    }
    if (fileInput) fileInput.disabled = true;

    // Show batch section and hide single-file loader/status
    const batchSec = document.getElementById('batch-section');
    if (batchSec) batchSec.style.display = 'block';

    const statusSec = document.getElementById('status-section');
    if (statusSec) statusSec.style.display = 'none';

    // Update batch counter header
    const batchTotalEl = document.getElementById('batch-total');
    if (batchTotalEl) batchTotalEl.textContent = files.length;
    const batchCurrentEl = document.getElementById('batch-current');
    if (batchCurrentEl) batchCurrentEl.textContent = '0';
    const batchOverallBar = document.getElementById('batch-overall-bar');
    if (batchOverallBar) batchOverallBar.style.width = '0%';

    // Clear and build batch item cards
    const batchList = document.getElementById('batch-progress-list');
    if (batchList) {
        batchList.innerHTML = '';
        files.forEach((file, index) => {
            const batchItem = createBatchItem(file, index);
            batchList.appendChild(batchItem);
        });
    }

    // Configure cancel and download all buttons
    const cancelBtn = document.getElementById('batch-cancel-btn');
    const downloadAllBtn = document.getElementById('batch-download-all-btn');

    if (cancelBtn) {
        cancelBtn.textContent = 'Cancel All';
        cancelBtn.disabled = false;
        cancelBtn.style.display = 'inline-block';
        cancelBtn.onclick = cancelAllBatch;
    }
    if (downloadAllBtn) {
        downloadAllBtn.style.display = 'none';
    }

    // Run parallel validation for all documents concurrently
    // One document's failure does NOT interrupt others!
    const promises = files.map((file, idx) => processBatchDocument(file, idx));
    await Promise.allSettled(promises);

    batchState.isRunning = false;
    if (runBtn) {
        runBtn.disabled = false;
        runBtn.classList.remove('btn-running');
    }
    if (fileInput) fileInput.disabled = false;

    // Show download all button if any documents completed
    const completedCount = batchState.results.filter(r => r && r.status === 'completed').length;
    if (completedCount > 0 && downloadAllBtn) {
        downloadAllBtn.style.display = 'inline-block';
        downloadAllBtn.onclick = downloadAllBatchResults;
    }

    if (cancelBtn) {
        cancelBtn.textContent = 'Close';
    }

    showToast(`Batch validation completed: ${completedCount} of ${files.length} documents successful.`, completedCount === files.length ? 'success' : 'info');
}

/**
 * Create a batch item UI element
 */
function createBatchItem(file, index) {
    const div = document.createElement('div');
    div.className = 'batch-item';
    div.id = `batch-item-${index}`;

    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);

    div.innerHTML = `
        <div class="batch-item-header">
            <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; color:#6366f1;">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
                <div class="batch-item-name" title="${file.name}">
                    ${file.name} <span style="font-size:0.75rem; color:#64748b; font-weight:normal;">(${sizeMb} MB)</span>
                </div>
            </div>
            <div class="batch-item-status batch-status-pending">Pending</div>
        </div>
        <div class="batch-item-progress" style="display:none;">
            <div class="batch-progress-bar-container">
                <div class="batch-progress-bar" style="width:0%"></div>
            </div>
            <div class="batch-progress-text">0%</div>
        </div>
        <div class="batch-item-message" style="display:none;"></div>
        <div class="batch-item-actions" style="display:none; justify-content:flex-end; gap:8px;">
            <button type="button" class="btn btn-secondary btn-batch-review" style="padding:4px 10px; font-size:0.75rem;" onclick="reviewBatchDocument(${index})">Review</button>
            <button type="button" class="btn btn-retry btn-batch-retry" style="display:none; padding:4px 10px; font-size:0.75rem;" onclick="retryBatchDocument(${index})">Retry</button>
        </div>
    `;

    return div;
}

/**
 * Process a single document concurrently within the batch
 */
async function processBatchDocument(file, index) {
    const itemEl = document.getElementById(`batch-item-${index}`);
    if (!itemEl) return;

    try {
        // Step 1: Pre-validation of file extension and size
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        const allowedExts = ['.pdf', '.docx', '.txt', '.xml', '.csv', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.jfif'];
        if (!allowedExts.includes(ext)) {
            throw new Error(`Unsupported file type '${ext}'. Allowed: PDF, DOCX, TXT, XML, CSV, JPG, PNG, WEBP.`);
        }
        if (file.size > 20 * 1024 * 1024) {
            throw new Error(`File exceeds max size limit of 20 MB (${(file.size / (1024 * 1024)).toFixed(1)} MB).`);
        }

        // Step 2: Upload to backend
        updateBatchItemStatus(index, 'processing', 'Uploading document...');
        showBatchProgress(index, 10);

        const currentBrand = document.getElementById('brand-select')?.value || 'Ethosh';
        const ctSelect = document.getElementById('content-type-select');
        const docContent = ctSelect ? ctSelect.value : 'text';

        const formData = new FormData();
        formData.append('file', file);
        formData.append('brand', currentBrand);
        formData.append('document_content', docContent);

        const token = getStoredToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const uploadResp = await fetch(getApiUrl('/api/pdf/upload'), {
            method: 'POST',
            headers,
            body: formData
        });

        if (!uploadResp.ok) {
            const errJson = await uploadResp.json().catch(() => ({}));
            throw new Error(errJson.detail || `Upload failed with HTTP ${uploadResp.status}`);
        }

        const uploadData = await uploadResp.json();
        const fileId = uploadData.file_id;
        const uploadId = uploadData.upload_id || "";

        showBatchProgress(index, 25);
        updateBatchItemMessage(index, 'Starting validation job...');

        // Step 3: Start background validation job with active category toggles
        const toggleSettings = getQCToggleSettings();
        const startResp = await fetch(getApiUrl('/api/qc/start_validate'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body: JSON.stringify({
                file_id: fileId,
                brand: currentBrand,
                upload_id: uploadId,
                check_spelling: toggleSettings.check_spelling,
                check_capitalization: toggleSettings.check_capitalization,
                check_punctuation: toggleSettings.check_punctuation,
                check_grammar: toggleSettings.check_grammar
            })
        });

        if (!startResp.ok) {
            const errJson = await startResp.json().catch(() => ({}));
            throw new Error(errJson.detail || `Validation start failed with HTTP ${startResp.status}`);
        }

        const startData = await startResp.json();
        const jobId = startData.job_id;

        // Step 4: Poll job status independently until done or error
        let result = null;
        while (true) {
            if (batchState.cancelled) {
                try {
                    await fetch(getApiUrl(`/api/qc/cancel/${jobId}`), { method: 'POST' });
                } catch (_) {}
                updateBatchItemStatus(index, 'error', 'Validation cancelled by user');
                batchState.results[index] = { status: 'cancelled', file, error: 'Cancelled by user' };
                return;
            }

            await new Promise(r => setTimeout(r, 1000));

            const statusResp = await fetch(getApiUrl(`/api/qc/status/${jobId}`));
            if (!statusResp.ok) continue;

            const st = await statusResp.json();
            const prog = Math.min(99, Math.max(25, st.progress || 25));
            showBatchProgress(index, prog);
            updateBatchItemMessage(index, `Validating (${prog}%)...`);

            if (st.status === 'done') {
                result = st.result;
                break;
            } else if (st.status === 'error') {
                throw new Error(st.error || 'Validation job encountered an error.');
            } else if (st.status === 'cancelled') {
                throw new Error('Validation was cancelled.');
            }
        }

        // Step 5: Completed successfully
        showBatchProgress(index, 100);
        batchState.results[index] = {
            status: 'completed',
            file,
            fileId,
            uploadId,
            jobId,
            result,
            ignoredIssueIds: new Set(),
            ignoredIssuesData: new Map()
        };

        const score = result.summary?.overall_score ?? 100;
        const totalIssues = result.total_issues ?? 0;
        const verdict = result.summary?.verdict || '';
        updateBatchItemStatus(index, 'completed', `Score: ${score}/100 • ${totalIssues} issue${totalIssues === 1 ? '' : 's'} (${verdict})`);

        // Show Review button
        showBatchItemActions(index, { canReview: true, canRetry: false });

        // Update overall batch progress counter
        updateBatchOverallProgress();

        // Update batch document tabs in the review switcher
        updateBatchDocSwitcherTabs();

        // If this is the first completed document, automatically activate review
        if (batchState.activeReviewIndex === -1) {
            reviewBatchDocument(index);
        }

    } catch (err) {
        console.error(`Batch error on item ${index} (${file.name}):`, err);
        batchState.results[index] = {
            status: 'error',
            file,
            error: err.message
        };
        updateBatchItemStatus(index, 'error', `Failed: ${err.message}`);
        showBatchItemActions(index, { canReview: false, canDownload: false, canRetry: true });
        updateBatchOverallProgress();
    }
}

/**
 * Retry a failed document in the batch independently
 */
async function retryBatchDocument(index) {
    const file = batchState.files[index];
    if (!file) return;

    updateBatchItemStatus(index, 'processing', 'Retrying validation...');
    showBatchProgress(index, 5);
    showBatchItemActions(index, { canReview: false, canDownload: false, canRetry: false });

    await processBatchDocument(file, index);
}

/**
 * Switch review workspace to inspect a specific completed batch document
 */
function reviewBatchDocument(index) {
    const item = batchState.results[index];
    if (!item || item.status !== 'completed' || !item.result) return;

    // Save previous active document's review state (ignored issues) before switching
    if (batchState.activeReviewIndex !== -1 && batchState.results[batchState.activeReviewIndex]) {
        const prev = batchState.results[batchState.activeReviewIndex];
        prev.ignoredIssueIds = new Set(appState.ignoredIssueIds || []);
        prev.ignoredIssuesData = new Map(appState.ignoredIssuesData || []);
    }

    batchState.activeReviewIndex = index;

    // Load into appState
    appState.currentJobId = item.jobId;
    appState.fileId = item.fileId;
    appState.uploadId = item.uploadId;
    appState.uploadedFile = item.file;
    appState.fileName = item.file.name;
    appState.result = item.result;
    appState.rawReport = item.result;
    appState.totalIssues = item.result.total_issues;
    appState.pageIssues = item.result.page_issues || [];
    appState.cachedPreviews = item.result.annotated_previews || [];
    appState.annotatedPreviews = item.result.annotated_previews || [];
    appState.outputPath = item.result.annotated_pdf_url || `/api/qc/annotated/${item.jobId}`;
    appState.legendUrl = item.result.legend_pdf_url || `/api/qc/legend/${item.jobId}`;
    appState.detectedSpellingIssues = item.result.spelling_issues || [];
    appState.detectedGrammarIssues = item.result.grammar_issues || [];
    appState.detectedFormattingIssues = item.result.double_spacing_issues || [];
    appState.detectedTitleCaseIssues = item.result.title_case_issues || [];
    appState.detectedCaseViolations = (item.result.title_case_issues || []).map(t => t.original || t.name || t.word || '');

    // Restore this document's own review-specific ignored set without overwriting
    if (!item.ignoredIssueIds) item.ignoredIssueIds = new Set();
    if (!item.ignoredIssuesData) item.ignoredIssuesData = new Map();
    appState.ignoredIssueIds = new Set(item.ignoredIssueIds);
    appState.ignoredIssuesData = new Map(item.ignoredIssuesData);

    const ignoredCount = appState.ignoredIssueIds ? appState.ignoredIssueIds.size : 0;
    appState.totalIssues = Math.max(0, (item.result.total_issues ?? 0) - ignoredCount);

    // Show sections
    const auditSec = document.getElementById('audit-log-section');
    if (auditSec) auditSec.style.display = 'block';

    const resSec = document.getElementById('results-section');
    if (resSec) resSec.style.display = 'block';

    const prevSec = document.getElementById('preview-section');
    if (prevSec) prevSec.style.display = 'block';

    // Show batch document switcher tabs
    const switcher = document.getElementById('batch-doc-switcher');
    if (switcher) switcher.style.display = 'block';
    updateBatchDocSwitcherTabs();

    const backBtn = document.getElementById('batch-back-to-list-btn');
    if (backBtn) {
        backBtn.onclick = () => {
            const batchSec = document.getElementById('batch-section');
            if (batchSec) {
                batchSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        };
    }

    // Render previews with real bounding boxes and dark tooltips
    if (appState.cachedPreviews && appState.cachedPreviews.length > 0) {
        renderAnnotatedPreview();
    }

    // Update all sidebar categories: Spelling, Grammar, Title Case, Formatting
    updateSidebarIssues();

    // Display validation summary counters & verdict
    renderValidationResults();

    // Update PDF download buttons to point to this document's job
    const dlPdfBtn = document.getElementById('download-pdf-btn');
    if (dlPdfBtn) {
        dlPdfBtn.onclick = () => {
            window.open(getApiUrl(`/api/qc/annotated/${item.jobId}`), '_blank');
        };
    }
    const dlLegendBtn = document.getElementById('download-legend-btn');
    if (dlLegendBtn) {
        dlLegendBtn.style.display = 'inline-block';
        dlLegendBtn.onclick = () => {
            window.open(getApiUrl(`/api/qc/legend/${item.jobId}`), '_blank');
        };
    }

    saveActiveReviewToSession();
    auditSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Update document switcher tabs above audit log
 */
function updateBatchDocSwitcherTabs() {
    const tabsContainer = document.getElementById('batch-doc-tabs');
    if (!tabsContainer) return;

    tabsContainer.innerHTML = '';
    batchState.results.forEach((res, idx) => {
        if (!res || res.status !== 'completed') return;

        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = `batch-doc-tab ${idx === batchState.activeReviewIndex ? 'active' : ''}`;
        const score = res.result?.summary?.overall_score ?? 100;
        tab.innerHTML = `
            <span>${res.file.name}</span>
            <span style="font-size:0.7rem; opacity:0.85; padding:1px 6px; border-radius:10px; background:rgba(0,0,0,0.12);">${score}/100</span>
        `;
        tab.onclick = () => reviewBatchDocument(idx);
        tabsContainer.appendChild(tab);
    });
}

/**
 * Cancel all in-flight batch jobs
 */
async function cancelAllBatch() {
    batchState.cancelled = true;
    const cancelBtn = document.getElementById('batch-cancel-btn');
    if (cancelBtn) {
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelling...';
    }

    for (let i = 0; i < batchState.results.length; i++) {
        const item = batchState.results[i];
        if (item?.jobId && item.status !== 'completed' && item.status !== 'error') {
            try {
                await fetch(getApiUrl(`/api/qc/cancel/${item.jobId}`), { method: 'POST' });
            } catch (_) {}
            updateBatchItemStatus(i, 'error', 'Cancelled by user');
        }
    }

    batchState.isRunning = false;
    const runBtn = document.getElementById('run-validation-btn');
    const fileInput = document.getElementById('file-upload');
    if (runBtn) {
        runBtn.disabled = false;
        runBtn.classList.remove('btn-running');
    }
    if (fileInput) fileInput.disabled = false;

    if (cancelBtn) {
        cancelBtn.textContent = 'Close';
        cancelBtn.disabled = false;
        cancelBtn.onclick = () => {
            const batchSec = document.getElementById('batch-section');
            if (batchSec) batchSec.style.display = 'none';
        };
    }
}

/**
 * Update batch overall progress bar
 */
function updateBatchOverallProgress() {
    const total = batchState.files.length;
    if (!total) return;

    const finishedCount = batchState.results.filter(r => r && (r.status === 'completed' || r.status === 'error' || r.status === 'cancelled')).length;

    const currentEl = document.getElementById('batch-current');
    if (currentEl) currentEl.textContent = finishedCount;

    const pct = Math.round((finishedCount / total) * 100);
    const barEl = document.getElementById('batch-overall-bar');
    if (barEl) barEl.style.width = `${pct}%`;
}

/**
 * Update batch item status badge and message
 */
function updateBatchItemStatus(index, status, message = '') {
    const item = document.getElementById(`batch-item-${index}`);
    if (!item) return;

    const statusEl = item.querySelector('.batch-item-status');
    if (statusEl) {
        statusEl.className = `batch-item-status batch-status-${status}`;
        statusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    }

    if (message) {
        updateBatchItemMessage(index, message);
    }

    item.classList.remove('batch-completed', 'batch-error');
    if (status === 'completed') {
        item.classList.add('batch-completed');
    } else if (status === 'error') {
        item.classList.add('batch-error');
    }
}

/**
 * Update batch item progress bar
 */
function showBatchProgress(index, percent) {
    const item = document.getElementById(`batch-item-${index}`);
    if (!item) return;

    const progressDiv = item.querySelector('.batch-item-progress');
    const progressBar = item.querySelector('.batch-progress-bar');
    const progressText = item.querySelector('.batch-progress-text');

    if (progressDiv) progressDiv.style.display = 'block';
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressText) progressText.textContent = `${Math.round(percent)}%`;
}

/**
 * Update batch item message text
 */
function updateBatchItemMessage(index, message) {
    const item = document.getElementById(`batch-item-${index}`);
    if (!item) return;

    const messageEl = item.querySelector('.batch-item-message');
    if (messageEl) {
        messageEl.textContent = message;
        messageEl.style.display = message ? 'block' : 'none';
    }
}

/**
 * Show/hide batch item action buttons
 */
function showBatchItemActions(index, { canReview = false, canRetry = false } = {}) {
    const item = document.getElementById(`batch-item-${index}`);
    if (!item) return;

    const actionsEl = item.querySelector('.batch-item-actions');
    if (!actionsEl) return;

    const reviewBtn = actionsEl.querySelector('.btn-batch-review');
    const retryBtn = actionsEl.querySelector('.btn-batch-retry');

    if (reviewBtn) reviewBtn.style.display = canReview ? 'inline-block' : 'none';
    if (retryBtn) retryBtn.style.display = canRetry ? 'inline-block' : 'none';

    actionsEl.style.display = (canReview || canRetry) ? 'flex' : 'none';
}

/**
 * Download result for a specific batch item
 */
function downloadBatchResult(index) {
    const item = batchState.results[index];
    if (!item || item.status !== 'completed' || !item.jobId) return;

    const url = getApiUrl(`/api/qc/annotated/${item.jobId}`);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.file.name.replace(/\.[^.]+$/, '_annotated.pdf');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

/**
 * Download all completed batch results sequentially
 */
async function downloadAllBatchResults() {
    const completed = batchState.results.filter(r => r && r.status === 'completed');
    if (completed.length === 0) {
        showToast('No completed documents to download.', 'warning');
        return;
    }

    showToast(`Downloading ${completed.length} annotated PDF(s)...`, 'info');
    for (let i = 0; i < batchState.results.length; i++) {
        if (batchState.results[i]?.status === 'completed') {
            downloadBatchResult(i);
            await new Promise(r => setTimeout(r, 400));
        }
    }
}


// Make batch functions globally accessible
window.downloadBatchResult = downloadBatchResult;
window.reviewBatchDocument = reviewBatchDocument;
window.retryBatchDocument = retryBatchDocument;
window.removeSelectedBatchFile = removeSelectedBatchFile;

// ─────────────────────────────────────────────────────────────────────────────
// IGNORE ERROR & RESTORE / UNDO IMPLEMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ignore a specific issue occurrence during the current review.
 * Dismisses only the selected occurrence using a unique issue ID,
 * removes its annotation/highlight, and updates results, counts, preview, and backend.
 */
async function ignoreIssue(issueId, issue, tooltipEl) {
    if (!issueId) return;

    appState.ignoredIssueIds = appState.ignoredIssueIds || new Set();
    appState.ignoredIssueIds.add(issueId);

    appState.ignoredIssuesData = appState.ignoredIssuesData || new Map();
    appState.ignoredIssuesData.set(issueId, issue || {});

    // Sync back to batch document state if reviewing a batch item
    if (batchState.activeReviewIndex !== -1 && batchState.results[batchState.activeReviewIndex]) {
        batchState.results[batchState.activeReviewIndex].ignoredIssueIds = new Set(appState.ignoredIssueIds);
        batchState.results[batchState.activeReviewIndex].ignoredIssuesData = new Map(appState.ignoredIssuesData);
    }

    // Hide the specific issue box in the preview overlay
    let boxEl = issue?.issueBox || issue?.element;
    if (!boxEl && issueId) {
        boxEl = document.querySelector(`.issue-box[data-issue-id="${issueId}"]`);
    }
    if (!boxEl && (issue?.word || issue?.original)) {
        const targetWord = (issue.word || issue.original).toLowerCase().trim();
        const page = issue.page;
        const candidateBoxes = Array.from(document.querySelectorAll('.issue-box:not(.issue-ignored)'));
        for (const b of candidateBoxes) {
            const bText = (b.dataset.issueText || b.dataset.original || '').toLowerCase().trim();
            const bPage = parseInt(b.dataset.pageNum, 10);
            if ((!page || bPage === page) && (bText === targetWord || bText.includes(targetWord))) {
                boxEl = b;
                break;
            }
        }
    }
    if (boxEl) {
        boxEl.classList.add('issue-ignored');
        boxEl.style.display = 'none';
        boxEl.classList.remove('issue-pinned');
    }

    // Decrement total issues count
    if (typeof appState.totalIssues === 'number' && appState.totalIssues > 0) {
        appState.totalIssues -= 1;
    }

    // Update summary counters
    updateMetricCountersAfterIgnore(issue?.type || 'spelling', -1);

    // Update or remove tooltip
    if (tooltipEl) {
        tooltipEl.remove();
    } else {
        document.querySelectorAll(`.pinned-issue-tooltip[data-issue-id="${issueId}"]`).forEach(t => t.remove());
    }

    // Update page header count
    if (issue?.page) {
        updatePageHeaderIssueCount(issue.page);
    }

    // Update all sidebar categories and category tabs synchronously
    updateSidebarIssues();
    updateErrorCategoryCounts();

    // Show toast with Undo capability
    const wordLabel = issue?.word || issue?.original || 'Error';
    showToast(`Ignored "${wordLabel}". Identical errors elsewhere remain flagged.`, 'info', {
        actionText: 'Undo',
        onAction: () => restoreIssue(issueId, issue)
    });

    // Sync with backend API
    if (appState.currentJobId) {
        try {
            const token = getStoredToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const resp = await fetch(getApiUrl(`/api/qc/ignore/${appState.currentJobId}`), {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    issue_id: issueId,
                    original: issue?.word || issue?.original || ''
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                console.log('Ignore synced with backend:', data);
                if (data.annotated_previews && data.annotated_previews.length > 0) {
                    appState.annotatedPreviews = data.annotated_previews;
                    updatePreviewImages(data.annotated_previews);
                }
            }
        } catch (err) {
            console.warn('Could not sync ignore with backend:', err);
        }
    }

    saveActiveReviewToSession();
}

/**
 * Restore an ignored issue occurrence during the current review (Undo).
 */
async function restoreIssue(issueId, issue, tooltipEl) {
    if (!issueId) return;

    if (appState.ignoredIssueIds) {
        appState.ignoredIssueIds.delete(issueId);
    }
    if (appState.ignoredIssuesData) {
        appState.ignoredIssuesData.delete(issueId);
    }

    // Sync back to batch document state if reviewing a batch item
    if (batchState.activeReviewIndex !== -1 && batchState.results[batchState.activeReviewIndex]) {
        batchState.results[batchState.activeReviewIndex].ignoredIssueIds = new Set(appState.ignoredIssueIds || []);
        batchState.results[batchState.activeReviewIndex].ignoredIssuesData = new Map(appState.ignoredIssuesData || []);
    }

    const issueData = issue || (appState.ignoredIssuesData && appState.ignoredIssuesData.get(issueId)) || {};

    // Restore the issue box in the preview overlay
    let boxEl = issueData.issueBox || issueData.element;
    if (!boxEl && issueId) {
        boxEl = document.querySelector(`.issue-box[data-issue-id="${issueId}"]`);
    }
    if (!boxEl && (issueData.word || issueData.original)) {
        const targetWord = (issueData.word || issueData.original).toLowerCase().trim();
        const page = issueData.page;
        const candidateBoxes = Array.from(document.querySelectorAll('.issue-box.issue-ignored'));
        for (const b of candidateBoxes) {
            const bText = (b.dataset.issueText || b.dataset.original || '').toLowerCase().trim();
            const bPage = parseInt(b.dataset.pageNum, 10);
            if ((!page || bPage === page) && (bText === targetWord || bText.includes(targetWord))) {
                boxEl = b;
                break;
            }
        }
    }
    if (boxEl) {
        boxEl.classList.remove('issue-ignored');
        boxEl.style.display = '';
    }

    // Increment total issues count
    appState.totalIssues = (appState.totalIssues || 0) + 1;

    // Update summary counters
    updateMetricCountersAfterIgnore(issueData.type || 'spelling', 1);

    if (tooltipEl) {
        tooltipEl.remove();
    } else {
        document.querySelectorAll(`.pinned-issue-tooltip[data-issue-id="${issueId}"]`).forEach(t => t.remove());
    }

    if (issueData.page) {
        updatePageHeaderIssueCount(issueData.page);
    }

    // Update all sidebar categories and category tabs synchronously
    updateSidebarIssues();
    updateErrorCategoryCounts();

    const wordLabel = issueData.word || issueData.original || 'Error';
    showToast(`Restored "${wordLabel}".`, 'success');

    // Sync with backend API
    if (appState.currentJobId) {
        try {
            const token = getStoredToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const resp = await fetch(getApiUrl(`/api/qc/restore/${appState.currentJobId}`), {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    issue_id: issueId,
                    original: issueData.word || issueData.original || ''
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                console.log('Restore synced with backend:', data);
                if (data.annotated_previews && data.annotated_previews.length > 0) {
                    appState.annotatedPreviews = data.annotated_previews;
                    updatePreviewImages(data.annotated_previews);
                }
            }
        } catch (err) {
            console.warn('Could not sync restore with backend:', err);
        }
    }

    saveActiveReviewToSession();
}

/**
 * Persist active review session to sessionStorage so state survives page refresh.
 */
function saveActiveReviewToSession() {
    try {
        if (!appState.validationDone && (!batchState.results || batchState.results.length === 0)) {
            return;
        }
        const data = {
            currentJobId: appState.currentJobId,
            fileId: appState.fileId,
            uploadId: appState.uploadId,
            fileName: appState.uploadedFile ? appState.uploadedFile.name : (appState.fileName || ''),
            totalIssues: appState.totalIssues,
            validationDone: appState.validationDone,
            cachedPreviews: appState.cachedPreviews || [],
            annotatedPreviews: appState.annotatedPreviews || [],
            detectedSpellingIssues: appState.detectedSpellingIssues || [],
            detectedGrammarIssues: appState.detectedGrammarIssues || [],
            detectedTitleCaseIssues: appState.detectedTitleCaseIssues || [],
            detectedFormattingIssues: appState.detectedFormattingIssues || [],
            detectedCaseViolations: appState.detectedCaseViolations || [],
            pageIssues: appState.pageIssues || [],
            outputPath: appState.outputPath,
            legendUrl: appState.legendUrl,
            ignoredIssueIds: Array.from(appState.ignoredIssueIds || []),
            ignoredIssuesData: Array.from(appState.ignoredIssuesData ? appState.ignoredIssuesData.entries() : []),
            activeReviewIndex: batchState.activeReviewIndex,
            timestamp: Date.now()
        };
        sessionStorage.setItem('qc_active_review', JSON.stringify(data));
    } catch (e) {
        console.warn('Could not save active review to sessionStorage:', e);
    }
}

/**
 * Restore active review session on page refresh from sessionStorage.
 */
async function restoreActiveReviewFromSession() {
    try {
        const raw = sessionStorage.getItem('qc_active_review');
        if (!raw) return;
        const data = JSON.parse(raw);
        if (!data || (!data.currentJobId && (!data.cachedPreviews || data.cachedPreviews.length === 0))) return;

        // Restore appState
        appState.currentJobId = data.currentJobId;
        appState.fileId = data.fileId;
        appState.uploadId = data.uploadId;
        appState.fileName = data.fileName;
        appState.totalIssues = data.totalIssues;
        appState.validationDone = data.validationDone;
        appState.cachedPreviews = data.cachedPreviews || [];
        appState.annotatedPreviews = data.annotatedPreviews || [];
        appState.detectedSpellingIssues = data.detectedSpellingIssues || [];
        appState.detectedGrammarIssues = data.detectedGrammarIssues || [];
        appState.detectedTitleCaseIssues = data.detectedTitleCaseIssues || [];
        appState.detectedFormattingIssues = data.detectedFormattingIssues || [];
        appState.detectedCaseViolations = data.detectedCaseViolations || [];
        appState.pageIssues = data.pageIssues || [];
        appState.outputPath = data.outputPath;
        appState.legendUrl = data.legendUrl;
        appState.ignoredIssueIds = new Set(data.ignoredIssueIds || []);
        appState.ignoredIssuesData = new Map(data.ignoredIssuesData || []);

        // Sync with backend if jobId is present to get fresh status & previews
        if (data.currentJobId) {
            try {
                const token = getStoredToken();
                const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                const res = await fetch(getApiUrl(`/api/qc/status/${data.currentJobId}`), { headers });
                if (res.ok) {
                    const jobStat = await res.json();
                    if (jobStat && jobStat.result) {
                        if (jobStat.result.annotated_previews && jobStat.result.annotated_previews.length > 0) {
                            appState.cachedPreviews = jobStat.result.annotated_previews;
                            appState.annotatedPreviews = jobStat.result.annotated_previews;
                        }
                        if (jobStat.result.page_issues) {
                            appState.pageIssues = jobStat.result.page_issues;
                        }
                    }
                }
            } catch (err) {
                console.warn('Could not sync restored job with backend status:', err);
            }
        }

        if (appState.validationDone || (appState.cachedPreviews && appState.cachedPreviews.length > 0)) {
            const resSec = document.getElementById('results-section');
            if (resSec) resSec.style.display = 'block';
            const prevSec = document.getElementById('preview-section');
            if (prevSec) prevSec.style.display = 'block';
            const auditSec = document.getElementById('audit-log-section');
            if (auditSec) auditSec.style.display = 'block';

            renderAnnotatedPreview();
            updateSidebarIssues();
            updateErrorCategoryCounts();
        }
    } catch (e) {
        console.warn('Error restoring active review from session:', e);
    }
}

function updateMetricCountersAfterIgnore(type, delta) {
    const totalEl = document.getElementById('result-issues');
    if (totalEl) totalEl.textContent = appState.totalIssues;

    const msgEl = document.getElementById('result-message');
    if (msgEl) {
        if (appState.totalIssues === 0) {
            msgEl.className = 'result-message success';
            msgEl.textContent = 'Great job! No validation issues found. The PDF is compliant.';
        } else {
            msgEl.className = 'result-message warning';
            msgEl.textContent = `Found ${appState.totalIssues} issues that require attention.`;
        }
    }

    const spellingEl = document.getElementById('result-spelling');
    const grammarEl = document.getElementById('result-grammar');
    const formatEl = document.getElementById('result-formatting');

    if (spellingEl) {
        let currentSpelling = parseInt(spellingEl.textContent.split('/')[0], 10) || 0;
        if (type === 'spelling' || type === 'spell') {
            currentSpelling = Math.max(0, currentSpelling + delta);
        }
        spellingEl.textContent = `${currentSpelling}/${appState.totalIssues}`;
    }

    if (grammarEl && (type === 'grammar' || type === 'grammatical')) {
        let currentGrammar = parseInt(grammarEl.textContent, 10) || 0;
        grammarEl.textContent = Math.max(0, currentGrammar + delta);
    }

    if (formatEl && (type === 'formatting' || type === 'titlecase' || type === 'title_case' || type === 'design')) {
        let currentFormat = parseInt(formatEl.textContent, 10) || 0;
        formatEl.textContent = Math.max(0, currentFormat + delta);
    }
}

function updatePageHeaderIssueCount(pageNum) {
    if (!pageNum) return;
    const containers = document.querySelectorAll('.preview-page-container');
    containers.forEach(pc => {
        const pnum = parseInt(pc.dataset.pageNum || pc.dataset.page, 10);
        if (pnum === pageNum) {
            const overlay = pc.querySelector('.page-issue-overlay');
            const header = pc.querySelector('.preview-page-header');
            if (overlay && header) {
                const remaining = overlay.querySelectorAll('.issue-box:not(.issue-ignored)').length;
                header.innerHTML = header.innerHTML.replace(/Issues:\s*\d+/, `Issues: ${remaining}`);
            }
        }
    });
}

function isWordFullyIgnored(wordText) {
    if (!wordText || !appState.ignoredIssuesData) return false;
    const norm = wordText.toLowerCase().trim();
    for (const [id, data] of appState.ignoredIssuesData.entries()) {
        const w = (data.word || data.original || data.message || '').toLowerCase().trim();
        if (w === norm && appState.ignoredIssueIds?.has(id)) {
            return true;
        }
    }
    return false;
}

async function ignoreWordIssues(wordText, pageNum) {
    const norm = (wordText || '').toLowerCase().trim();
    let targetBox = null;
    const boxes = Array.from(document.querySelectorAll('.issue-box:not(.issue-ignored)'));
    for (const box of boxes) {
        const bText = (box.dataset.issueText || box.dataset.original || box.dataset.tooltip || '').toLowerCase().trim();
        if (bText.includes(norm) || norm.includes(bText)) {
            if (pageNum && parseInt(box.dataset.pageNum, 10) === pageNum) {
                targetBox = box;
                break;
            } else if (!targetBox) {
                targetBox = box;
            }
        }
    }

    const issueId = targetBox ? targetBox.dataset.issueId : (appState.currentJobId ? `iss_${pageNum || 1}_${norm}` : `iss_${Date.now()}`);
    const issueData = {
        id: issueId,
        word: wordText,
        original: wordText,
        page: pageNum || (targetBox ? parseInt(targetBox.dataset.pageNum, 10) : 1),
        type: 'spelling',
        element: targetBox,
        issueBox: targetBox
    };

    await ignoreIssue(issueId, issueData);
}

async function restoreWordIssues(wordText) {
    const norm = (wordText || '').toLowerCase().trim();
    if (!appState.ignoredIssuesData) return;
    for (const [id, data] of appState.ignoredIssuesData.entries()) {
        const w = (data.word || data.original || data.message || '').toLowerCase().trim();
        if (w === norm && appState.ignoredIssueIds?.has(id)) {
            await restoreIssue(id, data);
            break;
        }
    }
}

function showToast(message, type = 'info', action = null) {
    let container = document.getElementById('app-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'app-toast-container';
        container.style.cssText = 'position:fixed; bottom:24px; right:24px; z-index:99999; display:flex; flex-direction:column; gap:10px; max-width:420px; pointer-events:none;';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    const bg = type === 'success' ? '#0f766e' : type === 'error' ? '#b91c1c' : '#1e2875';
    toast.style.cssText = `background:${bg}; color:#fff; padding:12px 18px; border-radius:10px; box-shadow:0 10px 25px -5px rgba(0,0,0,0.3); font-size:13px; font-weight:500; display:flex; align-items:center; justify-content:space-between; gap:12px; transition:all 0.25s ease; opacity:0; transform:translateY(10px); pointer-events:auto;`;

    const textSpan = document.createElement('span');
    textSpan.textContent = message;
    toast.appendChild(textSpan);

    if (action && action.actionText && action.onAction) {
        const actionBtn = document.createElement('button');
        actionBtn.textContent = action.actionText;
        actionBtn.style.cssText = 'background:#fff; color:#1e2875; border:none; border-radius:6px; padding:4px 10px; font-weight:700; font-size:12px; cursor:pointer; flex-shrink:0;';
        actionBtn.onclick = () => {
            toast.remove();
            action.onAction();
        };
        toast.appendChild(actionBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none; border:none; color:rgba(255,255,255,0.7); cursor:pointer; font-size:14px; padding:0 4px;';
    closeBtn.onclick = () => toast.remove();
    toast.appendChild(closeBtn);

    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
        if (toast.parentNode) {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            setTimeout(() => toast.remove(), 300);
        }
    }, 6000);
}

// ─────────────────────────────────────────────────────────────────────────────
// USER-SPECIFIC ACTIVITY & REVIEW HISTORY
// ─────────────────────────────────────────────────────────────────────────────

let userHistoryData = [];

async function loadFullUserHistory(forceRefresh = false) {
    const tbody = document.getElementById('history-table-body');
    if (!tbody) return;

    if (!userHistoryData.length || forceRefresh) {
        tbody.innerHTML = '<tr><td colspan="4" class="table-empty">Loading activity history...</td></tr>';
    }

    try {
        const token = getStoredToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(getApiUrl('/api/user/history'), { headers });
        if (!res.ok) {
            tbody.innerHTML = '<tr><td colspan="4" class="table-empty" style="color:#ef4444;">Failed to load activity history.</td></tr>';
            return;
        }

        const data = await res.json();
        userHistoryData = Array.isArray(data.activities) ? data.activities : [];
        filterAndRenderHistory();
    } catch (err) {
        console.error('Error loading history:', err);
        tbody.innerHTML = '<tr><td colspan="4" class="table-empty" style="color:#ef4444;">Network error loading history.</td></tr>';
    }
}

function filterAndRenderHistory() {
    const tbody = document.getElementById('history-table-body');
    if (!tbody) return;

    const searchTerm = (document.getElementById('history-search-input')?.value || '').trim().toLowerCase();
    const actionFilter = (document.getElementById('history-action-filter')?.value || '').trim().toLowerCase();

    const filtered = userHistoryData.filter(item => {
        if (actionFilter && (item.action_type || '').toLowerCase() !== actionFilter) {
            return false;
        }
        if (searchTerm) {
            const doc = (item.document_name || '').toLowerCase();
            const act = (item.action_type || '').toLowerCase();
            const det = JSON.stringify(item.details || {}).toLowerCase();
            return doc.includes(searchTerm) || act.includes(searchTerm) || det.includes(searchTerm);
        }
        return true;
    });

    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No activity records found matching your filter.</td></tr>';
        return;
    }

    const actionBadges = {
        'upload': { label: 'Upload', class: 'badge-action-upload' },
        'review': { label: 'Validation Review', class: 'badge-action-review' },
        'ignore_error': { label: 'Ignored Error', class: 'badge-action-ignore' },
        'restore_error': { label: 'Restored Error', class: 'badge-action-restore' },
        'add_dictionary': { label: 'Dictionary Added', class: 'badge-action-dict-add' },
        'remove_dictionary': { label: 'Dictionary Removed', class: 'badge-action-dict-remove' },
        'download_report': { label: 'Report Download', class: 'badge-action-download' }
    };

    tbody.innerHTML = filtered.map(item => {
        const badgeInfo = actionBadges[item.action_type] || { label: item.action_type, class: 'badge-action-upload' };
        const dateStr = item.created_at ? new Date(item.created_at).toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
        }) : '-';

        let detailsStr = '';
        if (typeof item.details === 'object' && item.details !== null) {
            if (item.details.summary) {
                const s = item.details.summary;
                detailsStr = `Total issues: ${s.total_issues || 0} (${s.spelling_mistakes || 0} spelling, ${s.grammar_mistakes || 0} grammar, ${s.formatting_mistakes || 0} formatting)`;
            } else if (item.details.word) {
                detailsStr = `Word: "${item.details.word}"`;
                if (item.details.issue_id) detailsStr += ` (Issue: ${item.details.issue_id})`;
            } else if (item.details.format) {
                detailsStr = `Format: ${item.details.format}`;
            } else {
                detailsStr = Object.entries(item.details).map(([k, v]) => `${k}: ${v}`).join(', ');
            }
        } else {
            detailsStr = String(item.details || '-');
        }

        const docName = item.document_name || '-';

        return `<tr>
            <td style="white-space:nowrap; color:#64748b; font-size:0.825rem;">${dateStr}</td>
            <td><span class="badge-action ${badgeInfo.class}">${badgeInfo.label}</span></td>
            <td style="font-weight:600; color:#1e2875; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHistoryHtml(docName)}">
                <span style="display:inline-flex; align-items:center; gap:6px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2B318D" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    ${escapeHistoryHtml(docName)}
                </span>
            </td>
            <td style="color:#475569; font-size:0.85rem;">${escapeHistoryHtml(detailsStr)}</td>
        </tr>`;
    }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// USER-SPECIFIC PERSISTENT DICTIONARY
// ─────────────────────────────────────────────────────────────────────────────

let userDictionaryData = [];

async function loadUserDictionary() {
    const tbody = document.getElementById('dictionary-table-body');
    const badge = document.getElementById('dictionary-count-badge');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="3" class="table-empty">Loading dictionary...</td></tr>';

    try {
        const token = getStoredToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(getApiUrl('/api/user/dictionary'), { headers });
        if (!res.ok) {
            tbody.innerHTML = '<tr><td colspan="3" class="table-empty" style="color:#ef4444;">Failed to load dictionary.</td></tr>';
            return;
        }

        const data = await res.json();
        userDictionaryData = Array.isArray(data.words) ? data.words : [];
        if (badge) badge.textContent = `${userDictionaryData.length} word${userDictionaryData.length === 1 ? '' : 's'}`;
        filterAndRenderDictionary();
    } catch (err) {
        console.error('Error loading dictionary:', err);
        tbody.innerHTML = '<tr><td colspan="3" class="table-empty" style="color:#ef4444;">Network error loading dictionary.</td></tr>';
    }
}

function filterAndRenderDictionary() {
    const tbody = document.getElementById('dictionary-table-body');
    if (!tbody) return;

    const term = (document.getElementById('dict-search-input')?.value || '').trim().toLowerCase();
    const filtered = userDictionaryData.filter(item => {
        const w = (typeof item === 'string' ? item : item.word || '').toLowerCase();
        return !term || w.includes(term);
    });

    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="table-empty">No words in dictionary matching your filter.</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map(item => {
        const word = typeof item === 'string' ? item : item.word;
        const dateStr = (typeof item === 'object' && item.created_at)
            ? new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '-';

        return `<tr>
            <td style="font-weight:600; color:#1e2875; font-size:0.95rem;">${escapeHistoryHtml(word)}</td>
            <td style="color:#64748b; font-size:0.85rem;">${dateStr}</td>
            <td style="text-align:right;">
                <button class="btn btn-sm btn-outline btn-remove-dict" data-word="${escapeHistoryHtml(word)}" style="color:#ef4444; border-color:#fca5a5; padding:4px 10px; font-size:11px; cursor:pointer;">
                    Remove
                </button>
            </td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('.btn-remove-dict').forEach(btn => {
        btn.addEventListener('click', () => {
            const word = btn.dataset.word;
            if (word) handleRemoveDictionaryWord(word);
        });
    });
}

async function handleAddDictionaryWord() {
    const input = document.getElementById('dict-add-input');
    const word = (input?.value || '').trim();
    if (!word) return;

    try {
        const token = getStoredToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(getApiUrl('/api/user/dictionary'), {
            method: 'POST',
            headers,
            body: JSON.stringify({ word })
        });
        if (res.ok) {
            input.value = '';
            appState.approvedSpellingWords.add(word);
            showToast(`"${word}" added to your personal dictionary.`, 'success');
            loadUserDictionary();
            // Immediately remove corresponding annotations and update results for active document
            resolveWordAnnotationsForCurrentDocument(word);
        } else {
            showToast('Could not add word to dictionary.', 'error');
        }
    } catch (e) {
        console.error('Add dictionary word failed:', e);
        showToast('Network error adding word.', 'error');
    }
}

async function handleRemoveDictionaryWord(word) {
    if (!confirm(`Remove "${word}" from your dictionary? It may be flagged in future document validations.`)) {
        return;
    }

    try {
        const token = getStoredToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(getApiUrl(`/api/user/dictionary/${encodeURIComponent(word)}`), {
            method: 'DELETE',
            headers
        });
        if (res.ok) {
            appState.approvedSpellingWords.delete(word);
            if (appState.approvedSpellingWords) {
                for (const w of Array.from(appState.approvedSpellingWords)) {
                    if (w.toLowerCase() === word.toLowerCase()) {
                        appState.approvedSpellingWords.delete(w);
                    }
                }
            }
            showToast(`"${word}" removed from dictionary.`, 'info');
            loadUserDictionary();
        } else {
            showToast('Could not remove word from dictionary.', 'error');
        }
    } catch (e) {
        console.error('Remove dictionary word failed:', e);
        showToast('Network error removing word.', 'error');
    }
}

async function logUserActivity(actionType, docName, details = {}) {
    try {
        const token = getStoredToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        await fetch(getApiUrl('/api/user/activity'), {
            method: 'POST',
            headers,
            body: JSON.stringify({
                action_type: actionType,
                document_name: docName,
                details
            })
        });
    } catch (e) {
        console.warn('Could not log user activity:', e);
    }
}

// Global window bindings for inline HTML / events
window.ignoreIssue = ignoreIssue;
window.restoreIssue = restoreIssue;
window.loadFullUserHistory = loadFullUserHistory;
window.loadUserDictionary = loadUserDictionary;

