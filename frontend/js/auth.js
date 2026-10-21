/**
 * Authentication module — custom JWT backend.
 *
 * All auth state is stored in localStorage:
 *   auth_user    — JSON user profile
 *   auth_session — JSON { access_token, expires_in, ... }
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _apiBase() {
    return (window.APP_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
}

async function _post(path, body) {
    const resp = await fetch(`${_apiBase()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: 'Request failed' }));
        throw new Error(err.detail || 'Request failed');
    }
    return resp.json();
}

// ---------------------------------------------------------------------------
// Core auth operations
// ---------------------------------------------------------------------------

export async function registerWithProfile({ first_name, last_name, email, password, confirm_password, organization }) {
    const data = await _post('/api/auth/register', {
        first_name,
        last_name,
        email,
        password,
        confirm_password,
        organization,
    });

    const { user, session } = data;
    localStorage.setItem('auth_user', JSON.stringify(user));
    if (session) {
        localStorage.setItem('auth_session', JSON.stringify(session));
    }
    return user;
}

export async function loginWithProfile(email, password) {
    const data = await _post('/api/auth/login', { email, password });

    const { user, session } = data;
    localStorage.setItem('auth_user', JSON.stringify(user));
    if (session) {
        localStorage.setItem('auth_session', JSON.stringify(session));
    }
    return user;
}

export async function signOut() {
    localStorage.removeItem('auth_user');
    localStorage.removeItem('auth_session');
}

// ---------------------------------------------------------------------------
// Dev bypass defaults (only active when window.APP_CONFIG?.DEV_BYPASS_AUTH is true)
// ---------------------------------------------------------------------------
const DEV_DEFAULT_USER = {
    id: "dev_admin_user_id",
    email: "shree.sonar@ethosh.com",
    first_name: "Shree",
    last_name: "Sonar",
    organization: "Ethosh",
    role: "ADMIN"
};

const DEV_DEFAULT_SESSION = {
    access_token: "dev-bypass-token",
    expires_in: 86400
};

// ---------------------------------------------------------------------------
// Session / profile accessors
// ---------------------------------------------------------------------------

export function getStoredUser() {
    try {
        const raw = localStorage.getItem('auth_user');
        if (raw) return JSON.parse(raw);
    } catch {
        // ignore parse error
    }
    if (window.APP_CONFIG?.DEV_BYPASS_AUTH) {
        return DEV_DEFAULT_USER;
    }
    return null;
}

export function getStoredSession() {
    try {
        const raw = localStorage.getItem('auth_session');
        if (raw) return JSON.parse(raw);
    } catch {
        // ignore parse error
    }
    if (window.APP_CONFIG?.DEV_BYPASS_AUTH) {
        return DEV_DEFAULT_SESSION;
    }
    return null;
}

export function isAuthenticated() {
    if (window.APP_CONFIG?.DEV_BYPASS_AUTH) return true;
    const user = getStoredUser();
    const session = getStoredSession();
    if (!user || !session?.access_token) return false;
    if (session.access_token === 'dev-bypass-token') {
        localStorage.removeItem('auth_user');
        localStorage.removeItem('auth_session');
        return false;
    }
    return true;
}

export function isAdmin() {
    if (window.APP_CONFIG?.DEV_BYPASS_AUTH) return true;
    const user = getStoredUser();
    return !!(user && user.role === 'ADMIN');
}

/**
 * Ask the backend to issue a fresh token.
 * If the server rejects the request (token too old / invalid), clears storage
 * and returns null so the caller can redirect to login.
 */
export async function refreshSession() {
    if (window.APP_CONFIG?.DEV_BYPASS_AUTH) {
        return getStoredSession();
    }
    const session = getStoredSession();
    if (!session?.access_token) return null;

    try {
        const resp = await fetch(`${_apiBase()}/api/auth/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`,
            },
        });
        if (!resp.ok) throw new Error('refresh failed');
        const data = await resp.json();
        if (data.access_token) {
            const updated = { ...session, access_token: data.access_token };
            localStorage.setItem('auth_session', JSON.stringify(updated));
            return updated;
        }
    } catch (e) {
        console.warn('Session refresh failed:', e);
        localStorage.removeItem('auth_user');
        localStorage.removeItem('auth_session');
    }
    return null;
}

// ---------------------------------------------------------------------------
// Backward-compatibility aliases (other modules may import these names)
// ---------------------------------------------------------------------------
export { signOut as firebaseSignOut };
export { loginWithProfile as signInWithEmailAndPassword };
export { registerWithProfile as createUserWithEmailAndPassword };

export async function getSession() {
    return getStoredSession();
}

export async function getUser() {
    return getStoredUser();
}

export function getCurrentUser() {
    return getStoredUser();
}

export function onAuthStateChange(callback) {
    // No WebSocket / realtime channel — call once with the current state.
    const user = getStoredUser();
    callback(user ? 'SIGNED_IN' : 'SIGNED_OUT', user);
    return { data: { subscription: { unsubscribe: () => {} } } };
}
