import { useCallback, useEffect, useState } from 'react';

export type DashboardAuthState = 'checking' | 'in' | 'out';

interface AuthResult {
  state: DashboardAuthState;
  error: string | null;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => Promise<void>;
}

/** Session gate for the dashboard. Data/control stays locked until /auth/me passes; the static bundle is public. */
export function useDashboardAuth(): AuthResult {
  const bypass = import.meta.env.DEV && import.meta.env.VITE_AUTH_DISABLED === 'true';
  const [state, setState] = useState<DashboardAuthState>(bypass ? 'in' : 'checking');
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (bypass) { setState('in'); return; }
    try {
      const res = await fetch('/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (res.ok) { setState('in'); setError(null); return; }
      setState('out');
      setError(res.status === 401 ? null : 'Auth service returned ' + res.status);
    } catch {
      setState('out');
      setError('Auth service unavailable. Check the tunnel and the auth service.');
    }
  }, [bypass]);

  useEffect(() => { void check(); }, [check]);

  const login = useCallback(async (password: string) => {
    const res = await fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      let msg = 'Login failed';
      try { const body = await res.json(); if (body?.error) msg = body.error; } catch { /* ignore */ }
      throw new Error(res.status === 429 ? 'Too many attempts. Try again in a few minutes.' : msg);
    }
    setState('in');
    setError(null);
  }, []);

  const logout = useCallback(async () => {
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* clear locally anyway */ }
    setState('out');
  }, []);

  return { state, error, login, logout, retry: check };
}
