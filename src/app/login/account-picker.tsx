'use client';

import { useActionState, useState, type CSSProperties } from 'react';
import { selectAccount } from './actions';
import { LOGIN_IDS, LOGIN_PROFILES, PASSWORD_REQUIRED_IDS, type LoginId } from './accounts';

function Avatar({ id, large = false }: { id: LoginId; large?: boolean }) {
  const profile = LOGIN_PROFILES[id];
  return <span className={`login-avatar tone-${profile.tone}${large ? ' login-avatar-large' : ''}`} aria-hidden="true">{profile.name[0]}</span>;
}

function SignInForm({ id, onBusy }: { id: LoginId; onBusy: (busy: boolean) => void }) {
  const [error, action, pending] = useActionState(async (previous: string, form: FormData) => {
    onBusy(true);
    try { return await selectAccount(previous, form); }
    finally { onBusy(false); }
  }, '');
  const [visible, setVisible] = useState(false);
  const profile = LOGIN_PROFILES[id];
  const needsPassword = PASSWORD_REQUIRED_IDS.includes(id);
  return (
    <form action={action} className="login-signin" aria-busy={pending}>
      <Avatar id={id} large />
      <div className="login-identity"><h2>Hello, {profile.name}.</h2><p>{profile.designation}</p></div>
      <input type="hidden" name="account" value={id} />
      <input className="sr-only" name="username" autoComplete="username" value={`${id}@kamour.local`} readOnly tabIndex={-1} />
      {needsPassword ? <div className="login-password-group">
        <label htmlFor="account-password">Your password</label>
        <div className="login-password-wrap">
          <input key={id} id="account-password" name="password" type={visible ? 'text' : 'password'}
            autoFocus required autoComplete="current-password" placeholder="Enter your password"
            aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} disabled={pending} />
          <button type="button" className="login-reveal" onClick={() => setVisible(v => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible}>{visible ? 'Hide' : 'Show'}</button>
        </div>
      </div> : <p className="login-continue-note">Continue to your team dashboard.</p>}
      {error ? <p id="login-error" role="alert" className="login-error">{error}</p> : null}
      <button type="submit" className="login-submit" disabled={pending} autoFocus={!needsPassword}>
        {pending ? <><span className="login-spinner" aria-hidden="true" /> Opening dashboard</> : <>Continue <span aria-hidden="true">→</span></>}
      </button>
      <p className="login-form-note" role="status">{pending ? 'Signing you in. Your workspace is on its way.' : 'Your workspace, ready when you are.'}</p>
    </form>
  );
}

export default function AccountPicker() {
  const [selected, setSelected] = useState<LoginId | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <header className="login-header"><a href="/login" className="login-brand"><span className="login-brand-mark">k</span>kamour<span className="login-brand-divider" /> <small>Sales workspace</small></a><span className="login-internal">TEAM ACCESS</span></header>
      <section className="login-workspace" aria-labelledby="login-title">
        <div className="login-people">
          <div className="login-eyebrow">YOUR TEAM. YOUR WORKSPACE.</div>
          <h1 id="login-title">Good work starts here<span>.</span></h1>
          <p className="login-intro">Choose your profile to pick up where you left off.</p>
          <div className="login-profile-grid" aria-label="Team profiles">
            {LOGIN_IDS.map((id, index) => {
              const profile = LOGIN_PROFILES[id];
              return <button key={id} type="button" className={`login-profile${selected === id ? ' is-selected' : ''}`}
                style={{ '--card-index': index } as CSSProperties} disabled={busy}
                aria-pressed={selected === id} aria-controls="login-access" onClick={() => setSelected(id)}>
                <Avatar id={id} /><span className="login-profile-name">{profile.name}</span>
                <span className="login-profile-role">{profile.designation}</span>
                {selected === id ? <span className="login-selected-mark" aria-hidden="true">✓</span> : null}
              </button>;
            })}
          </div>
        </div>
        <aside id="login-access" className="login-access" aria-label="Sign in">
          <div className="login-access-heading"><span className="login-step">02</span> ENTER YOUR WORKSPACE</div>
          {selected ? <SignInForm key={selected} id={selected} onBusy={setBusy} /> : <div className="login-welcome">
            <span className="login-welcome-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></svg></span>
            <h2>A space for your <br />next great day.</h2><p>Select your name. <br />We’ll take it from here.</p>
            <span className="login-welcome-hint" aria-hidden="true">← &nbsp; Choose a profile</span>
          </div>}
          <div className="login-access-footer"><span aria-hidden="true">◇</span> Kamour Sales OS</div>
        </aside>
      </section>
      <footer className="login-footer"><span>Built for the way your team works.</span><span>Kamour · Team dashboard</span></footer>
    </main>
  );
}
