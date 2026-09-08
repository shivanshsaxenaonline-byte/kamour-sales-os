'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

/**
 * Accounts were created without email verification (D-031), so the usernames
 * are `<name>@kamour.local`. The field accepts a bare username and appends the
 * domain, because nobody should have to type "@kamour.local" every morning.
 */
const DOMAIN = 'kamour.local';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const email = username.includes('@') ? username.trim() : `${username.trim()}@${DOMAIN}`;
    const { error } = await createClient().auth.signInWithPassword({ email, password });

    if (error) {
      setError(
        error.message === 'Invalid login credentials'
          ? 'Wrong username or password'
          : error.message,
      );
      setBusy(false);
      return;
    }
    router.replace('/');
    router.refresh();
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: 320,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: 24,
        }}
      >
        <h1 style={{ fontSize: 15, marginBottom: 2 }}>Kamour Sales OS</h1>
        <p style={{ color: 'var(--text-dim)', marginTop: 0, marginBottom: 20 }}>
          Sign in to continue
        </p>

        <label style={labelStyle} htmlFor="username">Username</label>
        <input
          id="username"
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="shreyansh"
          style={inputStyle}
        />

        <label style={{ ...labelStyle, marginTop: 12 }} htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={inputStyle}
        />

        {error && (
          <p
            role="alert"
            style={{
              color: 'var(--text)',
              background: 'var(--surface)',
              border: '1px solid var(--border-str)',
              borderRadius: 4,
              padding: '6px 10px',
              margin: '12px 0 0',
            }}
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          style={{
            marginTop: 16,
            width: '100%',
            height: 32,
            border: 0,
            borderRadius: 4,
            background: 'var(--accent)',
            color: 'var(--on-accent)',
            fontSize: 13,
            fontWeight: 500,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy || !username || !password ? 0.55 : 1,
          }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontWeight: 500,
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 8px',
  fontSize: 13,
  color: 'var(--text)',
  background: 'var(--bg)',
  border: '1px solid var(--border-str)',
  borderRadius: 4,
  fontVariantNumeric: 'tabular-nums',
};
