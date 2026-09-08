'use client';

import { useActionState } from 'react';
import { selectAccount } from './actions';
import { LOGIN_IDS } from './accounts';

export default function AccountPicker() {
  const [error, action, pending] = useActionState(selectAccount, '');
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <form action={action} aria-busy={pending} style={{ width: '100%', maxWidth: 320, padding: 24, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }}>
        <h1 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 6px' }}>Kamour Sales OS</h1>
        <p style={{ color: 'var(--text-dim)', margin: '0 0 18px' }}>Choose your ID to continue</p>
        <div style={{ display: 'grid', gap: 8 }}>
          {LOGIN_IDS.map(id => (
            <button key={id} name="account" value={id} type="submit" disabled={pending}
              style={{ width: '100%', minHeight: 40, textAlign: 'left', padding: '8px 12px', border: '1px solid var(--border-str)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)', fontSize: 13, fontWeight: 500, cursor: pending ? 'wait' : 'pointer', opacity: pending ? 0.6 : 1 }}>
              {id}
            </button>
          ))}
        </div>
        <p role="status" style={{ margin: pending ? '12px 0 0' : 0 }}>{pending ? 'Signing in…' : ''}</p>
        {error && <p role="alert" style={{ margin: '12px 0 0' }}>{error}</p>}
      </form>
    </main>
  );
}
