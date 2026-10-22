import { useCallback, useEffect, useState, type FormEvent, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import jsQR from 'jsqr'
import { ApiFailure, copyText, request } from './api'
import { CodePanel } from './CodePanel'
import { Brand } from './Brand'
import { ThemeToggle } from './ThemeToggle'
import { applyTheme, currentTheme, preferredTheme, savedTheme, THEME_STORAGE_KEY, type Theme } from './theme'
import { readableError } from './messages'
import { routeForPath, sharePathForId } from './routes'
import { parseOtpUri, type EntryDraft } from './otp-uri'
import { activeEntry, visibleEntries } from './selection'

type Entry = {
  id: string; issuer: string; account: string; algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: 6 | 8; period: number; createdAt: number; updatedAt: number
}
type Share = {
  id: string; entryId: string; issuer: string; account: string; protected: boolean;
  note: string; expiresAt: number | null; revokedAt: number | null; createdAt: number
}
const emptyDraft: EntryDraft = { issuer: '', account: '', secret: '', algorithm: 'SHA1', digits: 6, period: 30 }

function message(error: unknown): string {
  return readableError(error)
}
function formattedDate(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toLocaleString('en-US') : 'Never'
}
async function importQr(file: File): Promise<EntryDraft> {
  if (file.size > 10 * 1024 * 1024) throw new Error('QR image must be 10 MB or smaller')
  const bitmap = await createImageBitmap(file)
  try {
    if (bitmap.width * bitmap.height > 20_000_000) throw new Error('QR image is too large')
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Could not read the QR code image')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const result = jsQR(pixels.data, pixels.width, pixels.height)
    if (!result) throw new Error('No QR code detected. Try a clearer image')
    return parseOtpUri(result.data)
  } finally {
    bitmap.close()
  }
}


/** Public screens are intentionally separate from the administrator navigation. */
function PublicFrame({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <main className={'share-shell ' + className}>
    <div className="public-container">
      <header className="public-topbar">
        <Brand />
        <span className="public-topbar-caption">Secure code sharing</span>
      </header>
      <div className="public-stage">{children}</div>
      <footer className="public-footer">
        <span>Protected with TOTPNest</span>
        <span>Private by design</span>
      </footer>
    </div>
  </main>
}

function ShareIdHome() {
  const [shareId, setShareId] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { document.title = 'TOTPNest | View a shared code' }, [])

  const openShare = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const path = sharePathForId(shareId)
    if (!path) {
      setError('Please check the Share ID and try again.')
      return
    }
    window.location.assign(path)
  }

  return <PublicFrame className="public-home">
    <section className="card public-card" aria-labelledby="share-entry-title">
      <span className="public-emblem" aria-hidden="true"><img src="/totpnest-logo.svg" alt="" /></span>
      <span className="eyebrow">SHARED ACCESS</span>
      <h1 id="share-entry-title">A secure home for shared codes.</h1>
      <p className="muted public-lead">Enter the Share ID you received to view a time-sensitive verification code.</p>
      <form className="public-form" onSubmit={openShare}>
        <label htmlFor="share-id-input">Share ID</label>
        <input id="share-id-input" name="shareId" type="text" autoComplete="off"
          autoCapitalize="none" spellCheck={false} maxLength={32} value={shareId}
          placeholder="Enter your Share ID"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'share-id-help share-id-error' : 'share-id-help'}
          onChange={(event) => { setShareId(event.target.value); setError('') }} />
        <p className="muted small" id="share-id-help">Use the exact uppercase and lowercase letters shown in your ID.</p>
        {error && <p className="message error" role="alert" id="share-id-error">{error}</p>}
        <button className="primary" type="submit" disabled={!shareId.trim()}>
          View shared code <span aria-hidden="true">→</span>
        </button>
      </form>
      <p className="public-caution"><span aria-hidden="true">✦</span>
        Password-protected shares will ask for their password next.
      </p>
    </section>
  </PublicFrame>
}



function PublicUnavailable({ invalidShare = false }: { invalidShare?: boolean }) {
  useEffect(() => { document.title = invalidShare ? 'TOTPNest | Link unavailable' : 'TOTPNest | Page not found' }, [invalidShare])
  return <PublicFrame>
    <section className="card public-not-found center">
      <span className="public-state-icon" aria-hidden="true">⌁</span>
      <h1>{invalidShare ? 'Link unavailable' : 'Page not found'}</h1>
      <p className="muted">{invalidShare ? 'Check your Share ID and try again.' : "We couldn't find that page."}</p>
      <a className="public-back-link" href="/">Back to the start →</a>
    </section>
  </PublicFrame>
}


function SharePage({ id }: { id: string }) {
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
  const [locked, setLocked] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

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
      if (cause instanceof ApiFailure && cause.code === 'LOCKED') setLocked(true)
      setError(message(cause))
    } finally { setBusy(false) }
  }


  if (unavailable) {
    return <PublicFrame><section className="card public-not-found center">
      <span className="public-state-icon" aria-hidden="true">⌁</span>
      <h1>Link unavailable</h1>
      <p className="muted">This code may have expired or been removed. Ask the sender for a new link.</p>
      <a className="public-back-link" href="/">Try another Share ID →</a>
    </section></PublicFrame>
  }
  return <PublicFrame className="shared-page">
    <div className="shared-code-layout">
      <div className="shared-heading">
        <span className="eyebrow">PRIVATE SHARING</span>
        <h1>{passwordRequired ? 'Unlock your shared code' : 'Your shared verification code'}</h1>
        <p className="muted">A private, time-sensitive code is ready for this link.</p>
      </div>
      {passwordRequired ? <form className="card unlock-card" onSubmit={(event) => void submit(event)}>
        <span className="unlock-symbol" aria-hidden="true">⌑</span>
        <h2>Password required</h2>
        <p className="muted">Enter the password you received from the person who shared this link.</p>
        <label htmlFor="share-password-input">Share password</label>
        <input id="share-password-input" autoFocus type="password" autoComplete="off" value={password}
          onChange={(event) => { setPassword(event.target.value); setError('') }}
          required placeholder="Enter share password" />
        <button type="submit" className="primary" disabled={busy || locked || !password}>
          {busy ? 'Checking...' : locked ? 'Try again later' : 'Unlock code'}
        </button>
        {error && <p className="message error" role="alert">{error}</p>}
      </form> : <CodePanel endpoint={'/api/share/' + id} unlock={unlock || undefined}
        onAuthError={onFeedError} />}
      <p className="shared-privacy-note"><span aria-hidden="true">✦</span>
        This page never shows service names, accounts, or setup keys.
      </p>
    </div>
  </PublicFrame>
}


function Login({ onLogin }: { onLogin: () => void }) {
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
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }

  return <main className="login-shell">
    <div className="login-layout">
      <aside className="login-story">
        <Brand className="brand-on-dark" />
        <div className="login-story-main">
          <span className="eyebrow">YOUR PRIVATE WORKSPACE</span>
          <h2>Every code has a secure place.</h2>
          <p>Organize your verification codes, then share access only when you choose.</p>
          <div className="login-story-points">
            <span><strong>01</strong> Encrypted storage</span>
            <span><strong>02</strong> Time-limited links</span>
            <span><strong>03</strong> One private admin</span>
          </div>
        </div>
        <p className="login-story-foot">TOTPNest · Security-focused TOTP management</p>
      </aside>
      <form className="card login-card" onSubmit={(event) => void submit(event)}>
        <span className="login-emblem" aria-hidden="true"><img src="/totpnest-logo.svg" alt="" /></span>
        <span className="eyebrow">ADMIN ACCESS</span>
        <h1>Welcome back</h1>
        <p className="muted">Sign in with your administrator password to manage your codes.</p>
        <label htmlFor="admin-password">Administrator password</label>
        <input id="admin-password" autoFocus type="password" autoComplete="current-password"
          placeholder="Enter your password" value={password}
          onChange={(e) => { setPassword(e.target.value); setError('') }}
          required minLength={1} />
        <button className="primary" disabled={busy || !password} type="submit">
          {busy ? 'Signing in...' : 'Sign in'} <span aria-hidden="true">→</span>
        </button>
        {error && <p className="message error" role="alert">{error}</p>}
        <p className="login-fineprint">Administrator access is restricted to this private page.</p>
      </form>
    </div>
  </main>
}


function EntryEditor({ entry, onSaved, onCancel }: {
  entry?: Entry; onSaved: (savedId?: string) => void; onCancel: () => void
}) {
  const [draft, setDraft] = useState<EntryDraft>(() => entry ? {
    issuer: entry.issuer, account: entry.account, algorithm: entry.algorithm,
    digits: entry.digits, period: entry.period, secret: ''
  } : { ...emptyDraft })
  const [uri, setUri] = useState('')
  const [error, setError] = useState('')
  const [importNotice, setImportNotice] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [busy, setBusy] = useState(false)
  const setField = <K extends keyof EntryDraft>(key: K, value: EntryDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }))
  const useUri = () => {
    try {
      setDraft(parseOtpUri(uri))
      setUri('') // Do not leave a link containing a secret in the visible import field.
      setError('')
      setImportNotice('Setup link imported. Review the details before saving.')
    } catch (cause) { setImportNotice(''); setError(message(cause)) }
  }
  const useFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      setDraft(await importQr(file))
      setUri('')
      setError('')
      setImportNotice('QR code imported. Review the details before saving.')
    } catch (cause) { setImportNotice(''); setError(message(cause)) }
    event.target.value = ''
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const result = await request<{ id?: string }>(entry ? '/api/admin/entries/' + entry.id : '/api/admin/entries', {
        method: entry ? 'PUT' : 'POST',
        body: { ...draft, ...(entry && !draft.secret ? { secret: undefined } : {}) }
      })
      onSaved(result.id || entry?.id)
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }

  return <form className="card editor entry-editor" onSubmit={(event) => void save(event)}>
    <header className="editor-header">
      <div><span className="eyebrow">VERIFICATION CODES</span>
        <h2>{entry ? 'Edit verification code' : 'Add a verification code'}</h2>
        <p className="muted small">Import securely or enter the details yourself.</p>
      </div>
      <button type="button" className="quiet" onClick={onCancel}>Cancel</button>
    </header>
    <div className="form-divider"><span>01</span><strong>Import a setup key</strong><small>Optional</small></div>
    <div className="import-options">
      <div className="import-option">
        <span className="import-icon" aria-hidden="true">⌗</span>
        <strong>QR code image</strong>
        <p className="muted small">Recognized in your browser. The image is never uploaded.</p>
        <label className="upload-label" htmlFor="qr-upload">Choose an image ↗</label>
        <input id="qr-upload" className="visually-hidden" type="file" accept="image/*"
          capture="environment" onChange={(event) => void useFile(event)} />
      </div>
      <div className="import-option">
        <span className="import-icon" aria-hidden="true">⌁</span>
        <strong>Setup link</strong>
        <p className="muted small">Paste an otpauth:// link from your service.</p>
        <label htmlFor="setup-link" className="visually-hidden">Setup link</label>
        <div className="field-row">
          <input id="setup-link" type="password" value={uri} autoComplete="off"
            autoCapitalize="none" spellCheck={false} placeholder="Paste setup link"
            onChange={(e) => { setUri(e.target.value); setImportNotice('') }} />
          <button type="button" onClick={useUri} disabled={!uri}>Import</button>
        </div>
      </div>
    </div>
    {importNotice && <p className="message success-message" role="status">{importNotice}</p>}
    <div className="form-divider"><span>02</span><strong>Code details</strong><small>Review before saving</small></div>
    <div className="field-grid">
      <div><label htmlFor="issuer">Service name</label>
        <input id="issuer" value={draft.issuer} maxLength={120}
          onChange={(e) => setField('issuer', e.target.value)} placeholder="e.g. GitHub" /></div>
      <div><label htmlFor="account">Account</label>
        <input id="account" value={draft.account} maxLength={240}
          onChange={(e) => setField('account', e.target.value)} placeholder="e.g. name@example.com" /></div>
    </div>
    <label htmlFor="secret">Setup key {entry ? '(optional when editing)' : ''}</label>
    <div className="field-row secret-field">
      <input id="secret" type={showSecret ? 'text' : 'password'} autoComplete="off"
        autoCapitalize="none" spellCheck={false} value={draft.secret}
        onChange={(e) => setField('secret', e.target.value)} required={!entry}
        placeholder={entry ? 'Leave blank to keep the existing key' : 'Enter the setup key'} />
      <button type="button" aria-label={showSecret ? 'Hide setup key' : 'Show setup key'}
        aria-pressed={showSecret} onClick={() => setShowSecret((value) => !value)}>
        {showSecret ? 'Hide' : 'Show'}
      </button>
    </div>
    <details className="advanced-settings">
      <summary>Other code settings</summary>
      <p className="advanced-hint">Most services use the defaults. Only change these when your service requires it.</p>
      <div className="field-grid three">
        <div><label htmlFor="code-format">Algorithm</label>
          <select id="code-format" value={draft.algorithm}
            onChange={(e) => setField('algorithm', e.target.value as EntryDraft['algorithm'])}>
            <option value="SHA1">SHA-1 (standard)</option><option value="SHA256">SHA-256</option>
            <option value="SHA512">SHA-512</option>
          </select></div>
        <div><label htmlFor="code-digits">Code length</label>
          <select id="code-digits" value={draft.digits}
            onChange={(e) => setField('digits', Number(e.target.value) as 6 | 8)}>
            <option value={6}>6 digits</option><option value={8}>8 digits</option>
          </select></div>
        <div><label htmlFor="code-period">Refresh period (seconds)</label>
          <input id="code-period" type="number" min={15} max={120} value={draft.period}
            onChange={(e) => setField('period', Number(e.target.value))} /></div>
      </div>
    </details>
    {error && <p className="message error" role="alert">{error}</p>}
    <div className="editor-actions"><button type="button" onClick={onCancel}>Cancel</button>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Saving...' : entry ? 'Save changes' : 'Save verification code'} <span aria-hidden="true">→</span>
      </button>
    </div>
  </form>
}

function ShareCreator({ entry, onCreated, onCancel }: {
  entry: Entry; onCreated: () => void; onCancel: () => void
}) {
  const [protectedMode, setProtectedMode] = useState(false)
  const [password, setPassword] = useState('')
  const [hours, setHours] = useState(24)
  const [note, setNote] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyCreatedLink = async () => {
    setError('')
    const success = await copyText(url)
    setCopied(success)
    if (!success) setError("Couldn't copy the link. Select the link above and copy it manually.")
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const result = await request<{ id: string; url: string }>('/api/admin/shares', {
        method: 'POST', body: {
          entryId: entry.id, note, expiresInHours: hours,
          ...(protectedMode ? { password } : {})
        }
      })
      setUrl(result.url)
      setPassword('')
      onCreated()
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }

  return <form className="card editor share-editor" onSubmit={(event) => void submit(event)}>
    <header className="editor-header">
      <div><span className="eyebrow">CONTROL ACCESS</span><h2>Create a share link</h2>
        <p className="muted small">For {entry.issuer || 'Unnamed'} · {entry.account}</p>
      </div>
      <button type="button" className="quiet" onClick={onCancel}>Close</button>
    </header>
    {url ? <div className="created-link">
      <span className="created-link-icon" aria-hidden="true">✓</span>
      <h3>Your link is ready</h3>
      <p className="muted">Only share this link with people you trust.</p>
      <label htmlFor="new-share-url">Share URL</label>
      <textarea id="new-share-url" readOnly value={url} rows={3}
        onFocus={(event) => event.currentTarget.select()} aria-describedby="share-link-help" />
      <button type="button" className="primary" onClick={() => void copyCreatedLink()}>
        {copied ? 'Copied to clipboard' : 'Copy share link'}
      </button>
      <p className="muted small" id="share-link-help">Recipients cannot see the service name or account details. You may also select and copy the link manually.</p>
    </div> : <>
      <div className="share-explainer">
        <span aria-hidden="true">✦</span><p>People with this link can view a live code until it expires or you revoke access. Protect sensitive shares with a password.</p>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={protectedMode} onChange={(e) => {
          setProtectedMode(e.target.checked)
          if (!e.target.checked) setPassword('')
        }} />
        <span><strong>Require an access password</strong>
          <small>Anyone with an unprotected link can view the code.</small></span>
      </label>
      {protectedMode && <>
        <label htmlFor="share-password">Share password (at least 8 characters)</label>
        <input id="share-password" type="password" autoComplete="new-password"
          minLength={8} maxLength={128} required value={password}
          onChange={(e) => setPassword(e.target.value)} placeholder="Set a strong password" />
      </>}
      <label htmlFor="share-expiry">Link expires after</label>
      <select id="share-expiry" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
        <option value={1}>1 hour</option><option value={24}>24 hours</option>
        <option value={168}>7 days</option><option value={720}>30 days</option>
        <option value={0}>Only when I revoke it</option>
      </select>
      {hours === 0 && <p className="muted small">This link will remain active until you revoke it.</p>}
      <label htmlFor="share-note">Private note (admin only)</label>
      <input id="share-note" value={note} maxLength={120} onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Shared with a teammate" />
      <div className="editor-actions"><button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" type="submit" disabled={busy || protectedMode && password.length < 8}>
          {busy ? 'Creating...' : 'Create secure link'} <span aria-hidden="true">→</span>
        </button>
      </div>
    </>}
    {error && <p className="message error" role="alert">{error}</p>}
  </form>
}

function Dashboard({ onLogout, theme, onThemeToggle }: {
  onLogout: () => void; theme: Theme; onThemeToggle: () => void
}) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [shares, setShares] = useState<Share[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [editor, setEditor] = useState<'add' | 'edit' | null>(null)
  const [sharing, setSharing] = useState(false)
  const [tab, setTab] = useState<'entries' | 'shares'>('entries')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [manualLink, setManualLink] = useState('')
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      const [e, s] = await Promise.all([
        request<{ entries: Entry[] }>('/api/admin/entries'),
        request<{ shares: Share[] }>('/api/admin/shares')
      ])
      setEntries(e.entries); setShares(s.shares)
      setSelected((old) => e.entries.some((item) => item.id === old) ? old : e.entries[0]?.id || null)
      setError('')
    } catch (cause) { setError(message(cause)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void reload() }, [reload])
  const filtered = visibleEntries(entries, search)
  // The details must always correspond to an item visible in the filtered list.
  const entry = activeEntry(filtered, selected)
  const changeSearch = (value: string) => {
    setSearch(value)
    setEditor(null)
    setSharing(false)
  }
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'entries' : event.key === 'End' ? 'shares'
      : tab === 'entries' ? 'shares' : 'entries'
    setTab(next)
    document.getElementById('tab-' + next)?.focus()
  }
  const removeEntry = async (item: Entry) => {
    if (!window.confirm(`Delete "${item.issuer || item.account || 'Unnamed code'}" and all its share links? This cannot be undone.`)) return
    try {
      await request('/api/admin/entries/' + item.id, { method: 'DELETE' })
      setEditor(null); setSharing(false)
      await reload()
    } catch (cause) { setError(message(cause)) }
  }
  const revoke = async (id: string) => {
    if (!window.confirm('Remove this link? It will stop working right away.')) return
    try {
      await request('/api/admin/shares/' + id, { method: 'DELETE' })
      await reload()
    } catch (cause) { setError(message(cause)) }
  }
  const copyLink = async (id: string) => {
    setError('')
    setManualLink('')
    try {
      const link = await request<{ url: string }>('/api/admin/shares/' + id + '/link')
      if (!await copyText(link.url)) {
        setNotice('')
        setManualLink(link.url)
        return
      }
      setNotice('Link copied')
      window.setTimeout(() => setNotice(''), 3000)
    } catch (cause) { setError(message(cause)) }
  }
  const logout = async () => {
    await request('/api/admin/logout', { method: 'POST' }).catch(() => {})
    onLogout()
  }

  const activeShares = shares.filter((share) =>
    share.revokedAt === null && (share.expiresAt === null || share.expiresAt > Date.now()))
  const expiringShares = activeShares.filter((share) =>
    share.expiresAt !== null && share.expiresAt - Date.now() <= 3 * 24 * 60 * 60 * 1000)

  const startNew = () => {
    setSearch('')
    if (tab === 'shares' && entries.length) {
      setTab('entries')
      setEditor(null)
      setSharing(true)
    } else {
      setTab('entries')
      setEditor('add')
      setSharing(false)
    }
  }

  return <div className="dashboard">
    <aside className="sidebar" aria-label="Administrator navigation">
      <Brand />
      <div className="sidebar-group">
        <p className="sidebar-label">WORKSPACE</p>
        <nav className="sidebar-nav" aria-label="Manage">
          <button type="button" className={'sidebar-link ' + (tab === 'entries' ? 'active' : '')}
            aria-current={tab === 'entries' ? 'page' : undefined}
            onClick={() => { setTab('entries'); setSharing(false); setEditor(null) }}>
            <span className="sidebar-icon" aria-hidden="true">▦</span> Verification codes
            <span className="sidebar-count">{entries.length}</span>
          </button>
          <button type="button" className={'sidebar-link ' + (tab === 'shares' ? 'active' : '')}
            aria-current={tab === 'shares' ? 'page' : undefined}
            onClick={() => setTab('shares')}>
            <span className="sidebar-icon" aria-hidden="true">↗</span> Share links
            <span className="sidebar-count">{activeShares.length}</span>
          </button>
        </nav>
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-safe-icon" aria-hidden="true">✦</div>
        <strong>Safely in your nest.</strong>
        <p>Your keys are encrypted before they're stored.</p>
      </div>
      <p className="sidebar-version">TOTPNest · Private admin</p>
    </aside>
    <div className="dashboard-content">
      <header className="topbar">
        <div className="breadcrumb"><span>WORKSPACE</span><strong> / {tab === 'entries' ? 'Verification codes' : 'Shared access'}</strong></div>
        <div className="topbar-actions">
          <button type="button" className="quiet refresh-button" onClick={() => void reload()}>↻ <span>Refresh</span></button>
          <ThemeToggle theme={theme} onToggle={onThemeToggle} />
          <button type="button" className="quiet sign-out" onClick={() => void logout()}>Sign out</button>
        </div>
      </header>
      <main className="workspace">
        <section className="hero-banner">
          <div className="hero-copy">
            <span className="eyebrow">YOUR SECURE WORKSPACE</span>
            <h1>A home for every code.</h1>
            <p>Keep your verification codes organized. Share access only when you choose.</p>
          </div>
          <img src="/totpnest-logo.svg" alt="" className="hero-logo" aria-hidden="true" />
        </section>
        <section className="metric-grid" aria-label="Workspace overview">
          <div className="metric-card"><span className="metric-icon" aria-hidden="true">▦</span>
            <span className="metric-label">Saved codes</span><strong>{entries.length}</strong><small>Ready to manage</small></div>
          <div className="metric-card"><span className="metric-icon" aria-hidden="true">↗</span>
            <span className="metric-label">Active links</span><strong>{activeShares.length}</strong><small>Currently accessible</small></div>
          <div className="metric-card"><span className="metric-icon" aria-hidden="true">⌑</span>
            <span className="metric-label">Password protected</span>
            <strong>{activeShares.filter((share) => share.protected).length}</strong><small>Extra access control</small></div>
          <div className="metric-card"><span className="metric-icon" aria-hidden="true">◷</span>
            <span className="metric-label">Expiring soon</span><strong>{expiringShares.length}</strong><small>Within three days</small></div>
        </section>
        <div className="section-head heading">
          <div><span className="eyebrow">MANAGE YOUR CODES</span>
            <h2>{tab === 'entries' ? 'Verification codes' : 'Share links'}</h2>
            <p className="muted">{tab === 'entries'
              ? 'Select an account to view its current code, or add a new one.'
              : 'Control who can access your codes and for how long.'}</p>
          </div>
          <button type="button" className="primary add-button" onClick={startNew}>
            <span aria-hidden="true">＋</span> {tab === 'entries' ? 'Add a code' : 'Create share link'}
          </button>
        </div>
        <div className="tabs" role="tablist" aria-label="Dashboard sections">
          <button id="tab-entries" role="tab" aria-controls="panel-entries" aria-selected={tab === 'entries'}
            tabIndex={tab === 'entries' ? 0 : -1} onKeyDown={onTabKeyDown}
            className={tab === 'entries' ? 'active' : ''} onClick={() => setTab('entries')}>
            Saved codes <span>{entries.length}</span>
          </button>
          <button id="tab-shares" role="tab" aria-controls="panel-shares" aria-selected={tab === 'shares'}
            tabIndex={tab === 'shares' ? 0 : -1} onKeyDown={onTabKeyDown}
            className={tab === 'shares' ? 'active' : ''} onClick={() => setTab('shares')}>
            Shared access <span>{activeShares.length}</span>
          </button>
        </div>
        {error && <p className="message error workspace-message" role="alert">{error}</p>}
        {notice && <p className="message success-message workspace-message" role="status">{notice}</p>}
        {manualLink && <div className="card manual-link" role="status">
          <p>Clipboard access is unavailable. Select and copy this link manually.</p>
          <textarea readOnly value={manualLink} rows={2} aria-label="Share link for manual copying"
            onFocus={(event) => event.currentTarget.select()} />
          <button type="button" onClick={() => setManualLink('')}>Dismiss</button>
        </div>}
        {tab === 'entries' && <div className="workspace-grid" role="tabpanel" id="panel-entries"
          aria-labelledby="tab-entries" tabIndex={0}>
          <aside className="card entry-list" aria-label="Saved code list">
            <div className="list-heading">
              <strong>Your accounts</strong>
              <span>{entries.length} total</span>
            </div>
            <div className="search-field">
              <input className="search" type="search" aria-label="Search saved codes"
                placeholder="Search services or accounts..." value={search}
                onChange={(e) => changeSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') changeSearch('') }} />
              {search && <button type="button" className="search-clear" onClick={() => changeSearch('')}
                aria-label="Clear search">Clear</button>}
            </div>
            {!loading && entries.length > 0 && <p className="muted small search-count" role="status">
              {filtered.length} of {entries.length} saved codes
            </p>}
            <div className="entry-scroll">
              {filtered.length ? filtered.map((item) => <button key={item.id}
                className={'entry-row ' + (item.id === entry?.id ? 'selected' : '')}
                aria-pressed={item.id === entry?.id}
                onClick={() => { setSelected(item.id); setEditor(null); setSharing(false) }}>
                <span className="entry-avatar" aria-hidden="true">
                  {(item.issuer || item.account || '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="entry-label"><strong>{item.issuer || 'Unnamed'}</strong>
                  <small>{item.account || 'No account specified'}</small></span>
                <span className="entry-arrow" aria-hidden="true">›</span>
              </button>) : <p className="muted empty">
                {loading ? 'Loading saved codes...' : entries.length ? 'No matching codes found.' : 'No codes saved yet.'}
              </p>}
            </div>
          </aside>
          <section className="detail-column" aria-label="Code details">
            {editor ? <EntryEditor key={editor + (editor === 'edit' ? entry?.id : '')}
              entry={editor === 'edit' ? entry : undefined}
              onCancel={() => setEditor(null)}
              onSaved={(savedId) => {
                setEditor(null)
                setSearch('')
                if (savedId) setSelected(savedId)
                setNotice('Code saved')
                void reload()
              }}/>
            : sharing && entry ? <ShareCreator key={entry.id} entry={entry}
              onCreated={() => void reload()} onCancel={() => setSharing(false)} />
            : entry ? <>
              <div className="card account-card">
                <div className="account-ident">
                  <span className="account-ident-icon" aria-hidden="true">
                    {(entry.issuer || entry.account || '?').slice(0, 1).toUpperCase()}
                  </span>
                  <div><span className="eyebrow">SELECTED ACCOUNT</span>
                    <h2>{entry.issuer || 'Unnamed'}</h2><p className="muted">{entry.account}</p></div>
                </div>
                <div className="account-actions">
                  <button type="button" onClick={() => setEditor('edit')}>Edit</button>
                  <button type="button" onClick={() => setSharing(true)} className="primary">Share code</button>
                  <button type="button" className="danger-button" onClick={() => void removeEntry(entry)}>Delete</button>
                </div>
              </div>
              <CodePanel key={entry.id} endpoint={'/api/admin/entries/' + entry.id}/>
              <p className="muted small code-meta">{entry.digits}-digit code · Changes every {entry.period} seconds</p>
            </> : loading ? <div className="card empty" role="status">Loading your codes...</div>
            : entries.length ? <div className="card empty-state">
              <span className="empty-symbol" aria-hidden="true">⌕</span>
              <h2>No matching codes</h2>
              <p className="muted">Try a different service or account name.</p>
              <button type="button" onClick={() => changeSearch('')}>Clear search</button>
            </div> : <div className="card empty-state">
              <span className="empty-symbol" aria-hidden="true">＋</span>
              <h2>Add your first code</h2>
              <p className="muted">Import a setup link, upload a QR image, or enter a setup key.</p>
              <button type="button" className="primary" onClick={() => setEditor('add')}>Add a code</button>
            </div>}
          </section>
        </div>}
        {tab === 'shares' && <div className="card shares-list" role="tabpanel"
          id="panel-shares" aria-labelledby="tab-shares" tabIndex={0}>
          {shares.length === 0 && <div className="empty-state">
            <span className="empty-symbol" aria-hidden="true">↗</span>
            <h2>{loading ? 'Loading share links...' : 'No share links yet'}</h2>
            {!loading && <>
              <p className="muted">Choose a saved code to create a private share link.</p>
              <button type="button" className="primary" onClick={startNew}>
                {entries.length ? 'Create a share link' : 'Add a code'}
              </button>
            </>}
          </div>}
          {shares.map((share) => {
            const revoked = share.revokedAt !== null
            const expired = share.expiresAt !== null && share.expiresAt < Date.now()
            return <div className="share-row" key={share.id}>
              <div className="share-info">
                <span className="share-icon" aria-hidden="true">↗</span>
                <div><strong>{share.issuer || 'Unnamed'}</strong><span className="muted small share-account">{share.account}</span>
                  <span className="muted small">{share.protected ? 'Password protected' : 'Link access'}
                    {share.note ? ' · ' + share.note : ''} · Expires: {formattedDate(share.expiresAt)}</span></div>
              </div>
              <div className="share-actions">
                <span className={'status ' + (revoked || expired ? 'danger' : 'success')}>
                  {revoked ? 'Revoked' : expired ? 'Expired' : 'Active'}</span>
                {!revoked && !expired && <button type="button" onClick={() => void copyLink(share.id)}>Copy link</button>}
                {!revoked && <button type="button" className="danger-button" onClick={() => void revoke(share.id)}>Revoke</button>}
              </div>
            </div>
          })}
        </div>}
      </main>
    </div>
  </div>
}

function AdminApp({ theme, onThemeToggle }: { theme: Theme; onThemeToggle: () => void }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  useEffect(() => {
    document.title = 'TOTPNest | Admin'
    request<{ authenticated: boolean }>('/api/admin/session')
      .then((data) => setAuthenticated(data.authenticated)).catch(() => setAuthenticated(false))
  }, [])
  if (authenticated) return <Dashboard onLogout={() => setAuthenticated(false)}
    theme={theme} onThemeToggle={onThemeToggle} />
  return <>
    <div className="theme-corner"><ThemeToggle theme={theme} onToggle={onThemeToggle} /></div>
    {authenticated === null ? <main className="login-shell"><p className="muted">Getting things ready...</p></main>
      : <Login onLogin={() => setAuthenticated(true)} />}
  </>
}

export function App() {
  const [theme, setTheme] = useState<Theme>(currentTheme)
  useEffect(() => { applyTheme(theme) }, [theme])
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: light)')
    const sync = () => { setTheme(preferredTheme()) }
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) sync()
    }
    const onSystemChange = () => { if (savedTheme() !== 'light' && savedTheme() !== 'dark') sync() }
    window.addEventListener('storage', onStorage)
    media?.addEventListener?.('change', onSystemChange)
    return () => {
      window.removeEventListener('storage', onStorage)
      media?.removeEventListener?.('change', onSystemChange)
    }
  }, [])
  const onThemeToggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    applyTheme(next, true)
    setTheme(next)
  }
  const route = routeForPath(window.location.pathname)
  if (route.kind === 'admin') return <AdminApp theme={theme} onThemeToggle={onThemeToggle} />
  let page: ReactNode
  switch (route.kind) {
    case 'home': page = <ShareIdHome />; break
    case 'share': page = <SharePage id={route.id} />; break
    case 'invalid-share': page = <PublicUnavailable invalidShare />; break
    default: page = <PublicUnavailable />
  }
  return <>
    <div className="theme-corner"><ThemeToggle theme={theme} onToggle={onThemeToggle} /></div>
    {page}
  </>
}
