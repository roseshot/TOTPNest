import { useState, type FormEvent } from 'react'
import { request } from './api'
import { Brand } from './Brand'
import { readableError } from './messages'

export function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      await request('/api/admin/login', { method: 'POST', body: { password } })
      setPassword('')
      onLogin()
    } catch (cause) { setError(readableError(cause)) }
    finally { setBusy(false) }
  }

  return <main className="login-shell">
    <div className="login-layout">
      <aside className="login-story">
        <Brand className="brand-on-dark" />
        <div className="login-story-main">
          <span className="eyebrow">YOUR CODES, YOUR WAY</span>
          <h2>Your sign-in codes in one place.</h2>
          <p>Find the code you need, add new accounts, and share a code when someone needs it.</p>
          <div className="login-story-points">
            <span><strong>01</strong> Keep your codes together</span>
            <span><strong>02</strong> Choose when a link expires</span>
            <span><strong>03</strong> Stop sharing whenever you want</span>
          </div>
        </div>
        <p className="login-story-foot">TOTPNest · Sign-in codes made simple</p>
      </aside>
      <form className="card login-card" onSubmit={(event) => void submit(event)}>
        <span className="login-emblem" aria-hidden="true"><img src="/totpnest-logo.svg" alt="" /></span>
        <span className="eyebrow">SIGN IN</span>
        <h1>Welcome back</h1>
        <p className="muted">Enter your TOTPNest password to see and manage your saved codes.</p>
        <label htmlFor="admin-password">Password</label>
        <input id="admin-password" autoFocus type="password" autoComplete="current-password"
          placeholder="Enter your password" value={password}
          onChange={(e) => { setPassword(e.target.value); setError('') }}
          required minLength={1} />
        <button className="primary" disabled={busy || !password} type="submit">
          {busy ? 'Signing in...' : 'Sign in'} <span aria-hidden="true">→</span>
        </button>
        {error && <p className="message error" role="alert">{error}</p>}
        <p className="login-fineprint">Your shared links can be managed after signing in.</p>
      </form>
    </div>
  </main>
}
