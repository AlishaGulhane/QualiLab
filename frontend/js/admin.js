function getApiUrl(endpoint) {
    const baseUrl = window.APP_CONFIG?.API_BASE_URL || '';
    if (!baseUrl) return endpoint;
    return `${baseUrl.replace(/\/$/, '')}${endpoint}`;
}

function getStoredToken() {
    try {
        const raw = localStorage.getItem('auth_session');
        if (!raw) return null;
        const session = JSON.parse(raw);
        return session?.access_token || null;
    } catch {
        return null;
    }
}

export async function loadAdminDashboard() {
    await Promise.all([loadStats(), loadUsers(), loadUploads()]);
}

async function loadStats() {
    const statEls = {
        users: document.getElementById('stat-users'),
        pdfs: document.getElementById('stat-pdfs'),
        jobs: document.getElementById('stat-jobs'),
    };

    try {
        const response = await fetch(getApiUrl('/api/admin/stats'), {
            headers: { Authorization: `Bearer ${getStoredToken()}` },
        });
        if (!response.ok) throw new Error('Failed to load stats');
        const data = await response.json();
        const stats = data.stats || {};

        statEls.users.textContent = stats.total_users ?? '-';
        statEls.pdfs.textContent = stats.total_pdfs_uploaded ?? '-';
        const successJobs = stats.total_successful_jobs ?? 0;
        statEls.jobs.innerHTML = String(successJobs);
    } catch (err) {
        console.error('Admin stats error:', err);
        Object.values(statEls).forEach((el) => { if (el) el.textContent = 'Error'; });
    }
}

let selectedOrgs = null;

function renderUsersTable(users) {
    const tbody = document.getElementById('users-table-body');
    if (!tbody) return;

    const q = (document.getElementById('user-search')?.value || '').toLowerCase().trim();

    const filtered = users.filter(u => {
        if (selectedOrgs && !selectedOrgs.has(u.organization || '-')) return false;
        if (q) {
            const name = [u.first_name, u.last_name].filter(Boolean).join(' ').toLowerCase();
            const email = (u.email || '').toLowerCase();
            if (!name.includes(q) && !email.includes(q)) return false;
        }
        return true;
    });

    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No users found</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map((u) => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Unknown';
        const email = u.email || '-';
        const org = u.organization || '-';
        const role = u.role || 'USER';
        const joined = u.created_at ? new Date(u.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '-';

        return `<tr class="user-row">
                <td>${escapeHtml(name)}</td>
            <td>${escapeHtml(email)}</td>
            <td>${escapeHtml(org)}</td>
            <td><span class="role-badge ${role === 'ADMIN' ? 'admin' : 'user'}">${escapeHtml(role)}</span></td>
            <td>${escapeHtml(joined)}</td>
            <td style="text-align:center;white-space:nowrap;">
                <button class="btn-role-user" data-user-id="${escapeHtml(u.id)}" data-user-name="${escapeHtml(name)}" data-user-role="${escapeHtml(role)}" onclick="event.stopPropagation(); window.toggleUserRole('${escapeHtml(u.id)}', '${escapeHtml(name)}', '${escapeHtml(role)}')" title="Toggle role">${role === 'ADMIN' ? 'Demote' : 'Promote'}</button>
                <button class="btn-delete-user" data-user-id="${escapeHtml(u.id)}" data-user-name="${escapeHtml(name)}" onclick="event.stopPropagation(); window.deleteUser('${escapeHtml(u.id)}', '${escapeHtml(name)}')" title="Delete user">Delete</button>
            </td>
        </tr>`;
    }).join('');
}

function rebuildOrgFilter() {
    const users = window.__adminUsers || [];
    const list = document.getElementById('org-filter-list');
    if (!list) return;

    const orgs = [...new Set(users.map(u => u.organization || '-').filter(Boolean))].sort();
    if (!orgs.length) return;

    if (!selectedOrgs) selectedOrgs = new Set(orgs);

    list.innerHTML = orgs.map(o => `
        <label class="org-filter-item">
            <input type="checkbox" value="${escapeHtml(o)}" ${selectedOrgs.has(o) ? 'checked' : ''}>
            ${escapeHtml(o)}
        </label>
    `).join('');

    updateOrgFilterBadge(orgs);

    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            if (cb.checked) {
                selectedOrgs.add(cb.value);
            } else {
                selectedOrgs.delete(cb.value);
            }
            if (!selectedOrgs.size) selectedOrgs = new Set(orgs);
            updateOrgFilterBadge(orgs);
            renderUsersTable(users);
        });
    });
}

function updateOrgFilterBadge(allOrgs) {
    const badge = document.getElementById('org-filter-badge');
    if (!badge) return;
    if (!selectedOrgs || selectedOrgs.size === allOrgs.length) {
        badge.style.display = 'none';
    } else {
        badge.textContent = selectedOrgs.size;
        badge.style.display = 'inline';
    }
}

async function loadUsers() {
    const tbody = document.getElementById('users-table-body');
    if (!tbody) return;

    try {
        const response = await fetch(getApiUrl('/api/admin/users'), {
            headers: { Authorization: `Bearer ${getStoredToken()}` },
        });
        if (!response.ok) throw new Error('Failed to load users');
        const data = await response.json();
        const users = data.users || [];
        window.__adminUsers = users;
        selectedOrgs = null;
        rebuildOrgFilter();
        renderUsersTable(users);
    } catch (err) {
        console.error('Admin users error:', err);
        tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Failed to load users</td></tr>';
    }
}

document.getElementById('filter-org')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('org-filter-dropdown');
    if (dd) dd.classList.toggle('active');
});

document.addEventListener('click', () => {
    const dd = document.getElementById('org-filter-dropdown');
    if (dd) dd.classList.remove('active');
});

document.getElementById('org-select-all')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const users = window.__adminUsers || [];
    const orgs = [...new Set(users.map(u => u.organization || '-').filter(Boolean))].sort();
    selectedOrgs = new Set(orgs);
    document.querySelectorAll('#org-filter-list input[type="checkbox"]').forEach(cb => cb.checked = true);
    updateOrgFilterBadge(orgs);
    renderUsersTable(users);
});

document.getElementById('user-search')?.addEventListener('input', () => {
    const users = window.__adminUsers || [];
    renderUsersTable(users);
});

document.getElementById('org-clear-all')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const users = window.__adminUsers || [];
    const orgs = [...new Set(users.map(u => u.organization || '-').filter(Boolean))].sort();
    selectedOrgs = new Set();
    document.querySelectorAll('#org-filter-list input[type="checkbox"]').forEach(cb => cb.checked = false);
    updateOrgFilterBadge(orgs);
    renderUsersTable(users);
});

async function loadUploads() {
    const tbody = document.getElementById('uploads-table-body');
    if (!tbody) return;

    try {
        const response = await fetch(getApiUrl('/api/admin/uploads'), {
            headers: { Authorization: `Bearer ${getStoredToken()}` },
        });
        if (!response.ok) throw new Error('Failed to load uploads');
        const data = await response.json();
        const uploads = data.uploads || [];

        if (!uploads.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No uploads found</td></tr>';
            return;
        }

        let feedbackMap = {};
        try {
            const fbResp = await fetch(getApiUrl('/api/admin/feedback'), {
                headers: { Authorization: `Bearer ${getStoredToken()}` },
            });
            if (fbResp.ok) {
                const fbData = await fbResp.json();
                (fbData.feedback || []).forEach(fb => {
                    feedbackMap[fb.upload_id] = fb;
                });
            }
        } catch (err) {
            console.warn('Failed to load feedback:', err);
        }

        tbody.innerHTML = uploads.map((u) => {
            const user = u.users || {};
            const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';
            const userEmail = user.email || '-';
            const status = u.status || 'unknown';
            const uploadedAt = u.uploaded_at ? new Date(u.uploaded_at).toLocaleString() : '-';
            const fb = feedbackMap[u.id];
            const rating = fb ? '\u2605'.repeat(fb.rating) + '\u2606'.repeat(5 - fb.rating) : '-';
            const comment = fb && fb.comment ? fb.comment : '-';

            return `<tr>
                <td>${escapeHtml(userName)}</td>
                <td>${escapeHtml(userEmail)}</td>
                <td>${escapeHtml(u.filename || '-')}</td>
                <td><span class="status-badge status-${status}">${escapeHtml(status)}</span></td>
                <td class="feedback-rating">${rating}</td>
                <td class="feedback-comment-cell">${escapeHtml(comment)}</td>
                <td>${escapeHtml(uploadedAt)}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('Admin uploads error:', err);
        tbody.innerHTML = '<tr><td colspan="7" class="table-empty">Failed to load uploads</td></tr>';
    }
}

function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

async function deleteUser(userId, userName) {
    if (!confirm(`Are you sure you want to delete "${userName}"?\n\nThis will permanently remove the user and all their associated uploads and feedback. This action cannot be undone.`)) {
        return;
    }
    try {
        const response = await fetch(getApiUrl(`/api/admin/users/${userId}`), {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${getStoredToken()}` },
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to delete user');
        }
        loadUsers();
    } catch (err) {
        alert('Error deleting user: ' + err.message);
    }
}
async function toggleUserRole(userId, userName, currentRole) {
    const newRole = currentRole === 'ADMIN' ? 'USER' : 'ADMIN';
    const action = newRole === 'ADMIN' ? 'promote' : 'demote';
    if (!confirm(`Are you sure you want to ${action} "${userName}" to ${newRole}?`)) {
        return;
    }
    try {
        const response = await fetch(getApiUrl(`/api/admin/users/${userId}/role`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getStoredToken()}` },
            body: JSON.stringify({ role: newRole }),
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to update role');
        }
        loadUsers();
    } catch (err) {
        alert('Error updating role: ' + err.message);
    }
}
window.deleteUser = deleteUser;
window.toggleUserRole = toggleUserRole;