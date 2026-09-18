import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '@/services/supabase/client';
import { toAppError } from '@/lib/errors';
import { useAuth } from '../hooks/useAuth';

/**
 * Minimal auth-foundation login screen — only enough to exercise
 * session bootstrap end to end. Not a port of the legacy invite/
 * login UX (checkInviteToken, setInvitePassword, etc.); that is a
 * separate, later migration decision, not part of Phase 2 foundation.
 */
export function LoginPage() {
  const { status } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'signed_in') return <Navigate to="/" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (signInError) {
      setError(toAppError(signInError).userMessage);
    }
    // On success, AuthProvider's onAuthStateChange listener updates
    // state and RequireAuth/Navigate above takes over — no manual
    // redirect needed here.
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} style={{ maxWidth: 320, margin: '2rem auto' }}>
      <h1>Sign in</h1>
      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </label>
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
      <button type="submit" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
