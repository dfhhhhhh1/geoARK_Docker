import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';

/**
 * Access gate.
 *
 * The instance decides whether this appears: GET /api/session reports
 * `auth_required`, which is false when no ACCESS_CODE is configured, so local
 * development and the eval harness are unaffected and there is no build-time
 * flag to get wrong.
 *
 * The code is exchanged for an HttpOnly cookie and never held in JS or storage
 * -- so it cannot be read back out by injected script, and the streaming
 * endpoint (which cannot send an Authorization header) is covered by the same
 * credential.
 */
interface Props {
  children: React.ReactNode;
}

type State =
  | { status: 'checking' }
  | { status: 'open' }                      // no code required, or signed in
  | { status: 'locked'; error: string | null };

const LoginGate: React.FC<Props> = ({ children }) => {
  const [state, setState] = useState<State>({ status: 'checking' });
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/session', { credentials: 'same-origin' });
      const s = await res.json();
      setState(s.signed_in ? { status: 'open' } : { status: 'locked', error: null });
    } catch {
      // If the API is unreachable the app cannot work anyway; showing the gate
      // is more honest than rendering a UI whose every action will fail.
      setState({ status: 'locked', error: 'Could not reach the server.' });
    }
  }, []);

  useEffect(() => { check(); }, [check]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code: code.trim() }),
      });
      if (res.ok) {
        setCode('');
        setState({ status: 'open' });
        return;
      }
      const body = await res.json().catch(() => ({}));
      setState({
        status: 'locked',
        error: res.status === 429
          ? 'Too many attempts. Wait a moment and try again.'
          : body.error || 'That code was not accepted.',
      });
    } catch {
      setState({ status: 'locked', error: 'Could not reach the server.' });
    } finally {
      setSubmitting(false);
    }
  };

  if (state.status === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (state.status === 'open') return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1><img src="/brand/geoark-dark.webp" alt="GeoARK" className="h-9 w-auto" /></h1>
          <p className="text-xs text-slate-500 mt-2">Geospatial analysis from plain-language questions</p>
        </div>

        <form
          onSubmit={submit}
          className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-4"
        >
          <div>
            <label htmlFor="access-code" className="block text-sm font-medium text-slate-700 mb-1">
              Access code
            </label>
            <input
              id="access-code"
              type="password"
              autoComplete="current-password"
              value={code}
              onChange={e => setCode(e.target.value)}
              disabled={submitting}
              autoFocus
              className="w-full px-3 py-2 rounded-lg border border-slate-300
                         focus:outline-none focus:ring-2 focus:ring-brand-500
                         focus:border-transparent disabled:bg-slate-50"
            />
            <p className="text-xs text-slate-500 mt-1.5">
              This instance runs analyses on a local GPU and requires a code.
            </p>
          </div>

          {state.error && (
            <div className="flex gap-2 text-sm bg-red-50 border border-red-200
                            text-red-800 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{state.error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !code.trim()}
            className="w-full py-2.5 rounded-lg bg-brand-600 text-white font-medium
                       hover:bg-brand-700 disabled:bg-slate-300 disabled:cursor-not-allowed
                       transition-colors flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
};

export default LoginGate;
