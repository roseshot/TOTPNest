import { useState, type FormEvent } from 'react'
import { copyText, request } from './api'
import { readableError } from './messages'

type ShareEntry = { id: string; issuer: string; account: string }

export function ShareCreator({ entry, onCreated, onCancel }: {
  entry: ShareEntry; onCreated: () => void; onCancel: () => void
}) {
  const [protectedMode, setProtectedMode] = useState(false)
  const [password, setPassword] = useState('')
  const [hours, setHours] = useState(24)
  const [note, setNote] = useState('')
  const [publicLabel, setPublicLabel] = useState('')
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
          entryId: entry.id, note, publicLabel, expiresInHours: hours,
          ...(protectedMode ? { password } : {})
        }
      })
      setUrl(result.url)
      setPassword('')
      onCreated()
    } catch (cause) { setError(readableError(cause)) }
    finally { setBusy(false) }
  }

  return <form className="card editor share-editor" onSubmit={(event) => void submit(event)}>
    <header className="editor-header">
      <div><span className="eyebrow">SHARE A CODE</span><h2>Create a share link</h2>
        <p className="muted small">For {entry.issuer || 'Unnamed'}{entry.account ? ' · ' + entry.account : ''}</p>
      </div>
      <button type="button" className="quiet" onClick={onCancel}>Close</button>
    </header>
    {url ? <div className="created-link">
      <span className="created-link-icon" aria-hidden="true">✓</span>
      <h3>Your link is ready</h3>
      <p className="muted">Only share this link with people you trust.</p>
      <label htmlFor="new-share-url">Your share link</label>
      <textarea id="new-share-url" readOnly value={url} rows={3}
        onFocus={(event) => event.currentTarget.select()} aria-describedby="share-link-help" />
      <button type="button" className="primary" onClick={() => void copyCreatedLink()}>
        {copied ? 'Copied to clipboard' : 'Copy share link'}
      </button>
      <p className="muted small" id="share-link-help">Only the code is shared, not the account details. You can select and copy this link yourself.</p>
    </div> : <>
      <div className="share-explainer">
        <span aria-hidden="true">✦</span><p>Anyone with the link can see the current code until the link expires or you stop sharing it. Add a password for more privacy.</p>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={protectedMode} onChange={(e) => {
          setProtectedMode(e.target.checked)
          if (!e.target.checked) setPassword('')
        }} />
        <span><strong>Ask for a password</strong>
          <small>Without a password, anyone who gets the link can see the code.</small></span>
      </label>
      {protectedMode && <>
        <label htmlFor="share-password">Choose a password (at least 8 characters)</label>
        <input id="share-password" type="password" autoComplete="new-password"
          minLength={8} maxLength={128} required value={password}
          onChange={(e) => setPassword(e.target.value)} placeholder="Enter a password" />
      </>}
      <label htmlFor="share-expiry">Link expires after</label>
      <select id="share-expiry" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
        <option value={1}>1 hour</option><option value={24}>24 hours</option>
        <option value={168}>7 days</option><option value={720}>30 days</option>
        <option value={0}>Until I stop sharing</option>
      </select>
      {hours === 0 && <p className="muted small">This link won't expire on its own. You can stop sharing it at any time.</p>}
      <label htmlFor="share-public-label">Label shown to the recipient (optional)</label>
      <input id="share-public-label" value={publicLabel} maxLength={80}
        onChange={(e) => setPublicLabel(e.target.value)} placeholder="e.g. Cloudflare deployment account" />
      <p className="muted small">This label is visible on the shared-code page. Avoid personal or sensitive details.</p>
      <label htmlFor="share-note">Private note (only you can see it)</label>
      <input id="share-note" value={note} maxLength={120} onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Shared with a teammate" />
      <div className="editor-actions"><button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" type="submit" disabled={busy || protectedMode && password.length < 8}>
          {busy ? 'Creating...' : 'Create share link'} <span aria-hidden="true">→</span>
        </button>
      </div>
    </>}
    {error && <p className="message error" role="alert">{error}</p>}
  </form>
}
