import { useCallback, useEffect, useState, type FormEvent, type ChangeEvent, type ReactNode } from 'react'
import jsQR from 'jsqr'
import { ApiFailure, copyText, request } from './api'
import { CodePanel } from './CodePanel'
import { ThemeToggle } from './ThemeToggle'
import { applyTheme, currentTheme, preferredTheme, savedTheme, THEME_STORAGE_KEY, type Theme } from './theme'
import { readableError } from './messages'
import { routeForPath, sharePathForId } from './routes'
import { parseOtpUri, type EntryDraft } from './otp-uri'

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

  return <main className="share-shell public-home">
    <section className="card public-card" aria-labelledby="share-entry-title">
      <div className="public-wordmark"><span className="public-symbol" aria-hidden="true">◇</span>TOTPNest</div>
      <p className="public-kicker">SHARED ACCESS</p>
      <h1 id="share-entry-title">View a shared code</h1>
      <p className="muted public-lead">Enter the Share ID you received to view your shared code.</p>
      <form className="public-form" onSubmit={openShare}>
        <label htmlFor="share-id-input">Share ID</label>
        <input id="share-id-input" name="shareId" type="text" autoFocus autoComplete="off"
          autoCapitalize="none" spellCheck={false} maxLength={32} value={shareId}
          placeholder="Enter your Share ID"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'share-id-help share-id-error' : 'share-id-help'}
          onChange={(event) => { setShareId(event.target.value); setError('') }} />
        <p className="muted small" id="share-id-help">Use the exact uppercase and lowercase letters shown in your ID.</p>
        {error && <p className="message error" role="alert" id="share-id-error">{error}</p>}
        <button className="primary" type="submit" disabled={!shareId.trim()}>
          View code <span aria-hidden="true">→</span>
        </button>
      </form>
      <p className="muted small public-caution">If your code has a password, we'll ask for it next.</p>
    </section>
  </main>
}

function PublicUnavailable({ invalidShare = false }: { invalidShare?: boolean }) {
  useEffect(() => { document.title = invalidShare ? 'TOTPNest | Link unavailable' : 'TOTPNest | Page not found' }, [invalidShare])
  return <main className="share-shell"><section className="card public-not-found center">
    <h1>{invalidShare ? 'Link unavailable' : 'Page not found'}</h1>
    <p className="muted">{invalidShare ? 'Check your Share ID and try again.' : 'We couldn't find that page.'}</p>
    <a className="public-back-link" href="/">Back to the start</a>
  </section></main>
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
  const [unlock, setUnlock] = useState(() => sessionStorage.getItem(storageKey) || '')
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [locked, setLocked] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  const onFeedError = useCallback((failure: ApiFailure) => {
    if (failure.code === 'PASSWORD_REQUIRED') {
      sessionStorage.removeItem(storageKey)
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
      sessionStorage.setItem(storageKey, result.unlockToken)
      setUnlock(result.unlockToken)
      setPasswordRequired(false)
      setPassword('')
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.code === 'LOCKED') setLocked(true)
      setError(message(cause))
    } finally { setBusy(false) }
  }

  if (unavailable) {
    return <main className="share-shell"><div className="card center">
      <h2>Link unavailable</h2><p className="muted">This code may have expired or been removed. Ask the person who shared it for a new link.</p>
      <a className="public-back-link" href="/">Try another Share ID</a>
    </div></main>
  }
  return <main className="share-shell">
    {passwordRequired ? <form className="card unlock-card" onSubmit={(event) => void submit(event)}>
      <h2>Enter the shared password</h2>
      <p className="muted">Use the password that was sent with this link.</p>
      <input autoFocus type="password" aria-label="Share password" autoComplete="off" value={password}
        onChange={(event) => setPassword(event.target.value)} required placeholder="Enter the password" />
      <button type="submit" className="primary" disabled={busy || locked || !password}>{busy ? 'Checking...' : locked ? 'Try again later' : 'View code'}</button>
      {error && <p className="message error" role="alert">{error}</p>}
    </form> : <CodePanel endpoint={'/api/share/' + id} unlock={unlock || undefined}
      onAuthError={onFeedError} />}
  </main>
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
    <form className="card login-card" onSubmit={(event) => void submit(event)}>
      <div className="brand-icon">◇</div>
      <h1>TOTPNest</h1>
      <p className="muted">Sign in to manage your codes</p>
      <label htmlFor="admin-password">Password</label>
      <input id="admin-password" autoFocus type="password" autoComplete="current-password"
        placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)}
        required minLength={1} />
      <button className="primary" disabled={busy || !password} type="submit">{busy ? 'Signing in...' : 'Sign in'}</button>
      {error && <p className="message error" role="alert">{error}</p>}
    </form>
  </main>
}

function EntryEditor({ entry, onSaved, onCancel }: {
  entry?: Entry; onSaved: () => void; onCancel: () => void
}) {
  const [draft, setDraft] = useState<EntryDraft>(() => entry ? {
    issuer: entry.issuer, account: entry.account, algorithm: entry.algorithm,
    digits: entry.digits, period: entry.period, secret: ''
  } : { ...emptyDraft })
  const [uri, setUri] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const setField = <K extends keyof EntryDraft>(key: K, value: EntryDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }))
  const useUri = () => {
    try { setDraft(parseOtpUri(uri)); setError('') }
    catch (cause) { setError(message(cause)) }
  }
  const useFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try { setDraft(await importQr(file)); setError('') }
    catch (cause) { setError(message(cause)) }
    event.target.value = ''
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      await request(entry ? '/api/admin/entries/' + entry.id : '/api/admin/entries', {
        method: entry ? 'PUT' : 'POST',
        body: { ...draft, ...(entry && !draft.secret ? { secret: undefined } : {}) }
      })
      onSaved()
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  return <form className="card editor" onSubmit={(event) => void save(event)}>
    <div className="section-head"><h2>{entry ? 'Edit code' : 'Add a code'}</h2>
      <button type="button" className="quiet" onClick={onCancel}>Cancel</button></div>
    <label htmlFor="setup-link">Paste a setup link (optional)</label>
    <div className="field-row">
      <input id="setup-link" value={uri} placeholder="Paste the link provided by your service"
        onChange={(e) => setUri(e.target.value)} />
      <button type="button" onClick={useUri} disabled={!uri}>Use link</button>
    </div>
    <label className="upload-label">Or choose a QR code image
      <input type="file" accept="image/*" capture="environment" onChange={(event) => void useFile(event)} />
    </label>
    <div className="field-grid">
      <div><label htmlFor="issuer">Service name</label>
        <input id="issuer" value={draft.issuer} maxLength={120}
          onChange={(e) => setField('issuer', e.target.value)} placeholder="GitHub" /></div>
      <div><label htmlFor="account">Account</label>
        <input id="account" value={draft.account} maxLength={240}
          onChange={(e) => setField('account', e.target.value)} placeholder="example@email.com" /></div>
    </div>
    <label htmlFor="secret">Setup key {entry ? '(leave blank to keep existing)' : ''}</label>
    <input id="secret" type="password" autoComplete="off" spellCheck={false} value={draft.secret}
      onChange={(e) => setField('secret', e.target.value)} required={!entry} placeholder="Paste your setup key" />
    <details className="advanced-settings">
      <summary>Other code settings</summary>
      <p className="advanced-hint">Most services use the standard settings. Only change these if your service asks you to.</p>
      <div className="field-grid three">
        <div><label htmlFor="code-format">Code format</label><select id="code-format" value={draft.algorithm}
          onChange={(e) => setField('algorithm', e.target.value as EntryDraft['algorithm'])}>
          <option value="SHA1">Standard (recommended)</option>
          <option value="SHA256">SHA-256</option><option value="SHA512">SHA-512</option>
        </select></div>
        <div><label htmlFor="code-digits">Code length</label><select id="code-digits" value={draft.digits}
          onChange={(e) => setField('digits', Number(e.target.value) as 6 | 8)}>
          <option value={6}>6 digits</option><option value={8}>8 digits</option>
        </select></div>
        <div><label htmlFor="code-period">Changes every (seconds)</label>
          <input id="code-period" type="number" min={15} max={120} value={draft.period}
            onChange={(e) => setField('period', Number(e.target.value))} /></div>
      </div>
    </details>
    {error && <p className="message error" role="alert">{error}</p>}
    <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving...' : 'Save code'}</button>
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
      onCreated()
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  return <form className="card editor" onSubmit={(event) => void submit(event)}>
    <div className="section-head"><h2>Create share link</h2><button type="button" className="quiet" onClick={onCancel}>Close</button></div>
    <p className="muted">{entry.issuer || 'Unnamed'} · {entry.account}</p>
    {url ? <>
      <p className="message success-message">Your link is ready. Share it only with people you trust.</p>
      <textarea readOnly aria-label="Generated share link" value={url} rows={3} />
      <button type="button" className="primary" onClick={() => void copyText(url).then(setCopied)}>
        {copied ? 'Copied' : 'Copy share link'}
      </button>
      <p className="muted small">People using this link won't see your account details.</p>
    </> : <>
      <label className="check-row">
        <input type="checkbox" checked={protectedMode} onChange={(e) => setProtectedMode(e.target.checked)} />
        Add a password for extra privacy
      </label>
      <p className="muted small">Without a password, anyone with the link can view this code.</p>
      {protectedMode && <>
        <label htmlFor="share-password">Choose a password (8 or more characters)</label>
        <input id="share-password" type="password" autoComplete="new-password"
          minLength={8} maxLength={128} required value={password}
          onChange={(e) => setPassword(e.target.value)} />
      </>}
      <label>Link expires after</label>
      <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
        <option value={1}>1 hour</option><option value={24}>24 hours</option>
        <option value={168}>7 days</option><option value={720}>30 days</option>
        <option value={0}>Only when I remove it</option>
      </select>
      <label>Private note (only you can see this)</label>
      <input value={note} maxLength={120} onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Shared with a colleague" />
      {error && <p className="message error" role="alert">{error}</p>}
      <button className="primary" type="submit" disabled={busy || protectedMode && password.length < 8}>
        {busy ? 'Creating...' : 'Create link'}
      </button>
    </>}
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
  }, [])
  useEffect(() => { void reload() }, [reload])
  const entry = entries.find((item) => item.id === selected)
  const filtered = entries.filter((item) =>
    (item.issuer + ' ' + item.account).toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const removeEntry = async (item: Entry) => {
    if (!window.confirm('Delete this code and all its shared links? This can't be undone.')) return
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
    try {
      const link = await request<{ url: string }>('/api/admin/shares/' + id + '/link')
      if (!await copyText(link.url)) throw new Error('Couldn't copy the link. Try again.')
      setNotice('Link copied')
      window.setTimeout(() => setNotice(''), 1800)
    } catch (cause) { setError(message(cause)) }
  }
  const logout = async () => {
    await request('/api/admin/logout', { method: 'POST' }).catch(() => {})
    onLogout()
  }
  return <div className="dashboard">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">◇</span><strong>TOTPNest</strong><span className="admin-tag">Admin</span></div>
      <div className="topbar-actions">
        <ThemeToggle theme={theme} onToggle={onThemeToggle} />
        <button className="quiet" onClick={() => void logout()}>Sign out</button>
      </div>
    </header>
    <main className="workspace">
      <div className="section-head heading">
        <div><h1>Your verification codes</h1><p className="muted">Keep your codes together and share only when you need to.</p></div>
        <button className="primary" onClick={() => {
          setTab('entries'); setEditor('add'); setSharing(false)
        }}>+ Add a code</button>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'entries'} className={tab === 'entries' ? 'active' : ''}
          onClick={() => setTab('entries')}>Saved codes <span>{entries.length}</span></button>
        <button role="tab" aria-selected={tab === 'shares'} className={tab === 'shares' ? 'active' : ''}
          onClick={() => setTab('shares')}>Share links <span>{shares.length}</span></button>
      </div>
      {error && <p className="message error" role="alert">{error}</p>}
      {notice && <p className="message success-message">{notice}</p>}
      {tab === 'entries' && <div className="workspace-grid">
        <aside className="card entry-list">
          <input className="search" aria-label="Search saved codes" placeholder="Search services or accounts..."
            value={search} onChange={(e) => setSearch(e.target.value)} />
          {filtered.length ? filtered.map((item) => <button key={item.id}
            className={'entry-row ' + (item.id === selected ? 'selected' : '')}
            onClick={() => { setSelected(item.id); setEditor(null); setSharing(false) }}>
            <span className="entry-avatar">{(item.issuer || item.account).slice(0, 1).toUpperCase()}</span>
            <span className="entry-label"><strong>{item.issuer || 'Unnamed'}</strong>
              <small>{item.account || 'No account specified'}</small></span>
            <span className="entry-arrow">›</span>
          </button>) : <p className="muted empty">No matching codes found</p>}
        </aside>
        <section className="detail-column">
          {editor ? <EntryEditor key={editor + (editor === 'edit' ? selected : '')}
            entry={editor === 'edit' ? entry : undefined}
            onCancel={() => setEditor(null)} onSaved={() => { setEditor(null); void reload() }}/>
          : sharing && entry ? <ShareCreator key={entry.id} entry={entry}
            onCreated={() => void reload()} onCancel={() => setSharing(false)} />
          : entry ? <>
            <div className="card account-card">
              <div><h2>{entry.issuer || 'Unnamed'}</h2><p className="muted">{entry.account}</p></div>
              <div className="account-actions">
                <button onClick={() => setEditor('edit')}>Edit</button>
                <button onClick={() => setSharing(true)} className="primary">Share</button>
                <button className="danger-button" onClick={() => void removeEntry(entry)}>Delete</button>
              </div>
            </div>
            <CodePanel key={entry.id} endpoint={'/api/admin/entries/' + entry.id}/>
            <p className="muted small">{entry.digits}-digit code · Changes every {entry.period} seconds</p>
          </> : <div className="card empty">No saved codes yet. Add your first code to get started.</div>}
        </section>
      </div>}
      {tab === 'shares' && <div className="card shares-list">
        {shares.length === 0 && <p className="muted empty">You haven't shared any codes yet.</p>}
        {shares.map((share) => {
          const revoked = share.revokedAt !== null
          const expired = share.expiresAt !== null && share.expiresAt < Date.now()
          return <div className="share-row" key={share.id}>
            <div className="share-info"><strong>{share.issuer || 'Unnamed'} · {share.account}</strong>
              <span className="muted small">{share.protected ? '🔒 Password-protected' : '🔗 Anyone with the link'} ·
                {share.note ? ' ' + share.note + ' ·' : ''} Expires: {formattedDate(share.expiresAt)}</span></div>
            <div className="share-actions">
              <span className={'status ' + (revoked || expired ? 'danger' : 'success')}>
                {revoked ? 'Revoked' : expired ? 'Expired' : 'Active'}</span>
              {!revoked && !expired && <button onClick={() => void copyLink(share.id)}>Copy link</button>}
              {!revoked && <button className="danger-button" onClick={() => void revoke(share.id)}>Revoke</button>}
            </div>
          </div>
        })}
      </div>}
    </main>
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
