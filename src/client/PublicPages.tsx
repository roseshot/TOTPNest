import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiFailure, request } from './api'
import { CodePanel } from './CodePanel'
import { Brand } from './Brand'
import { readableError } from './messages'
import { sharePathForId } from './routes'

/** Public screens are intentionally separate from the administrator navigation. */
function PublicFrame({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <main className={'share-shell ' + className}>
    <div className="public-container">
      <header className="public-topbar">
        <Brand />
        <span className="public-topbar-caption">View shared codes</span>
      </header>
      <div className="public-stage">{children}</div>
      <footer className="public-footer">
        <span>TOTPNest makes it easy to share a code</span>
        <span>Shared codes update automatically</span>
      </footer>
    </div>
  </main>
}

export function ShareIdHome() {
  const [shareId, setShareId] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { document.title = 'TOTPNest | View a shared code' }, [])

  const openShare = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const path = sharePathForId(shareId)
    if (!path) {
      setError("That Share ID doesn't look right. Check it and try again.")
      return
    }
    window.location.assign(path)
  }

  return <PublicFrame className="public-home">
    <section className="card public-card" aria-labelledby="share-entry-title">
      <span className="public-emblem" aria-hidden="true"><img src="/totpnest-logo.svg" alt="" /></span>
      <span className="eyebrow">VIEW A CODE</span>
      <h1 id="share-entry-title">View a shared sign-in code.</h1>
      <p className="muted public-lead">Enter the Share ID you received from the sender. If they sent a link, open it instead.</p>
      <form className="public-form" onSubmit={openShare}>
        <label htmlFor="share-id-input">Share ID</label>
        <input id="share-id-input" name="shareId" type="text" autoComplete="off"
          autoCapitalize="none" spellCheck={false} maxLength={32} value={shareId}
          placeholder="Enter your Share ID"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'share-id-help share-id-error' : 'share-id-help'}
          onChange={(event) => { setShareId(event.target.value); setError('') }} />
        <p className="muted small" id="share-id-help">Copy the ID exactly as it appears, including capital letters.</p>
        {error && <p className="message error" role="alert" id="share-id-error">{error}</p>}
        <button className="primary" type="submit" disabled={!shareId.trim()}>
          View shared code <span aria-hidden="true">→</span>
        </button>
      </form>
    </section>
  </PublicFrame>
}



export function PublicUnavailable({ invalidShare = false }: { invalidShare?: boolean }) {
  useEffect(() => { document.title = invalidShare ? "TOTPNest | Can't open this link" : 'TOTPNest | Page not found' }, [invalidShare])
  return <PublicFrame>
    <section className="card public-not-found center">
      <span className="public-state-icon" aria-hidden="true">⌁</span>
      <h1>{invalidShare ? "Can't open this link" : 'Page not found'}</h1>
      <p className="muted">{invalidShare ? 'Check the Share ID, or ask the sender for a new link.' : "Check the address and try again."}</p>
      <a className="public-back-link" href="/">Enter another Share ID →</a>
    </section>
  </PublicFrame>
}


export function SharePage({ id }: { id: string }) {
  useEffect(() => {
    document.title = 'TOTPNest | Shared code'
    // Older links may contain a token fragment; never retain it in the address bar.
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])
  const storageKey = 'totpnest-unlock:' + id
  const [unlock, setUnlock] = useState(() => {
    try { return sessionStorage.getItem(storageKey) || '' }
    catch { return '' } // Shared codes remain usable with browser storage disabled.
  })
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [lockRemaining, setLockRemaining] = useState(0)
  const [unavailable, setUnavailable] = useState(false)
  const isLocked = lockRemaining > 0
  useEffect(() => {
    if (!isLocked) return
    const timer = window.setInterval(() => setLockRemaining((remaining) => Math.max(0, remaining - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [isLocked])

  const onFeedError = useCallback((failure: ApiFailure) => {
    if (failure.code === 'PASSWORD_REQUIRED') {
      try { sessionStorage.removeItem(storageKey) } catch { /* Storage may be blocked. */ }
      setUnlock('')
      setPasswordRequired(true)
      setError('')
    } else if (failure.code === 'SHARE_UNAVAILABLE' || failure.status === 404) {
      setUnavailable(true)
    }
  }, [storageKey])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const result = await request<{ unlockToken: string }>('/api/share/' + id + '/unlock', {
        method: 'POST', body: { password }
      })
      try { sessionStorage.setItem(storageKey, result.unlockToken) } catch { /* In-memory ticket still works. */ }
      setUnlock(result.unlockToken)
      setPasswordRequired(false)
      setPassword('')
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.code === 'LOCKED') setLockRemaining(cause.retryAfterSeconds ?? 60)
      setError(readableError(cause))
    } finally { setBusy(false) }
  }


  if (unavailable) {
    return <PublicFrame><section className="card public-not-found center">
      <span className="public-state-icon" aria-hidden="true">⌁</span>
      <h1>Can't open this link</h1>
      <p className="muted">The link may have expired or been turned off. Ask the sender for a new one.</p>
      <a className="public-back-link" href="/">Try another Share ID →</a>
    </section></PublicFrame>
  }
  return <PublicFrame className="shared-page">
    <div className="shared-code-layout">
      <div className="shared-heading">
        <span className="eyebrow">SHARED CODE</span>
        <h1>{passwordRequired ? 'Enter the password to view your code' : 'Your shared sign-in code'}</h1>
        <p className="muted">The code updates automatically. Copy the current one when you need it.</p>
      </div>
      {passwordRequired ? <form className="card unlock-card" onSubmit={(event) => void submit(event)}>
        <span className="unlock-symbol" aria-hidden="true">⌑</span>
        <h2>This link needs a password</h2>
        <p className="muted">Ask the sender for the password if you don't have it.</p>
        <label htmlFor="share-password-input">Link password</label>
        <input id="share-password-input" autoFocus type="password" autoComplete="off" value={password}
          onChange={(event) => { setPassword(event.target.value); setError('') }}
          required placeholder="Enter the password" />
        <button type="submit" className="primary" disabled={busy || isLocked || !password}>
          {busy ? 'Checking...' : isLocked ? `Try again in ${lockRemaining}s` : 'View code'}
        </button>
        {error && <p className="message error" role="alert">{error}</p>}
      </form> : <CodePanel endpoint={'/api/share/' + id} unlock={unlock || undefined}
        onAuthError={onFeedError} />}
    </div>
  </PublicFrame>
}
