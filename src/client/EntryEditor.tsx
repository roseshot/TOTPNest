import { useState, type ChangeEvent, type FormEvent } from 'react'
import { request } from './api'
import { readableError } from './messages'
import { parseOtpUri, type EntryDraft } from './otp-uri'
import type { Group } from './groups'

type EditableEntry = {
  id: string
  issuer: string
  account: string
  algorithm: EntryDraft['algorithm']
  digits: EntryDraft['digits']
  period: number
  groupId: string | null
}

const emptyDraft: EntryDraft = {
  issuer: '', account: '', secret: '', algorithm: 'SHA1', digits: 6, period: 30
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
    const { default: jsQR } = await import('jsqr')
    const result = jsQR(pixels.data, pixels.width, pixels.height)
    if (!result) throw new Error('No QR code detected. Try a clearer image')
    return parseOtpUri(result.data)
  } finally {
    bitmap.close()
  }
}

export function EntryEditor({ entry, groups, suggestedGroupId, onSaved, onCancel }: {
  entry?: EditableEntry; groups: Group[]; suggestedGroupId: string | null;
  onSaved: (savedId?: string) => void; onCancel: () => void
}) {
  const [draft, setDraft] = useState<EntryDraft>(() => entry ? {
    issuer: entry.issuer, account: entry.account, algorithm: entry.algorithm,
    digits: entry.digits, period: entry.period, secret: ''
  } : { ...emptyDraft })
  const [groupId, setGroupId] = useState<string>(entry?.groupId ?? suggestedGroupId ?? '')
  const [uri, setUri] = useState('')
  const [error, setError] = useState('')
  const [importNotice, setImportNotice] = useState('')
  const [importing, setImporting] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [busy, setBusy] = useState(false)
  const setField = <K extends keyof EntryDraft>(key: K, value: EntryDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }))
  const useUri = () => {
    try {
      setDraft(parseOtpUri(uri))
      setUri('') // Do not leave a link containing a secret in the visible import field.
      setError('')
      setImportNotice('Setup link added. Check the details below, then save.')
    } catch (cause) { setImportNotice(''); setError(readableError(cause)) }
  }
  const useFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || importing || busy) return
    setImporting(true)
    setError('')
    setImportNotice('')
    try {
      setDraft(await importQr(file))
      setUri('')
      setImportNotice('QR code added. Check the details below, then save.')
    } catch (cause) { setError(readableError(cause)) }
    finally {
      event.target.value = ''
      setImporting(false)
    }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const result = await request<{ id?: string }>(entry ? '/api/admin/entries/' + entry.id : '/api/admin/entries', {
        method: entry ? 'PUT' : 'POST',
        body: { ...draft, groupId: groupId || null,
          ...(entry && !draft.secret ? { secret: undefined } : {}) }
      })
      onSaved(result.id || entry?.id)
    } catch (cause) { setError(readableError(cause)) }
    finally { setBusy(false) }
  }

  return <form className="card editor entry-editor" onSubmit={(event) => void save(event)}>
    <header className="editor-header">
      <div><span className="eyebrow">VERIFICATION CODES</span>
        <h2>{entry ? 'Edit verification code' : 'Add a verification code'}</h2>
        <p className="muted small">Add a code using a QR image, a setup link, or the details below.</p>
      </div>
      <button type="button" className="quiet" onClick={onCancel}>Cancel</button>
    </header>
    <div className="form-divider"><span>01</span><strong>Quick ways to add a code</strong><small>Optional</small></div>
    <div className="import-options">
      <div className="import-option">
        <span className="import-icon" aria-hidden="true">⌗</span>
        <strong>QR code image</strong>
        <p className="muted small">Choose a picture of the QR code you received when setting up your account.</p>
        <label className={'upload-label ' + (importing ? 'upload-busy' : '')} htmlFor="qr-upload">
          {importing ? 'Reading image...' : 'Choose an image ↗'}
        </label>
        <input id="qr-upload" className="visually-hidden" type="file" accept="image/*"
          disabled={importing || busy} onChange={(event) => void useFile(event)} />
      </div>
      <div className="import-option">
        <span className="import-icon" aria-hidden="true">⌁</span>
        <strong>Setup link</strong>
        <p className="muted small">Paste the setup link provided by your service.</p>
        <label htmlFor="setup-link" className="visually-hidden">Setup link</label>
        <div className="field-row">
          <input id="setup-link" type="password" value={uri} autoComplete="off"
            autoCapitalize="none" spellCheck={false} placeholder="Paste setup link"
            onChange={(e) => { setUri(e.target.value); setImportNotice('') }} />
          <button type="button" onClick={useUri} disabled={!uri}>Import</button>
        </div>
      </div>
    </div>
    {importing && <p className="muted small" role="status">Looking for the QR code in your image...</p>}
    {importNotice && <p className="message success-message" role="status">{importNotice}</p>}
    <div className="form-divider"><span>02</span><strong>Check the details</strong><small>Check before saving</small></div>
    <div className="field-grid">
      <div><label htmlFor="issuer">Website or app</label>
        <input id="issuer" value={draft.issuer} maxLength={120}
          onChange={(e) => setField('issuer', e.target.value)} placeholder="e.g. GitHub" /></div>
      <div><label htmlFor="account">Account</label>
        <input id="account" value={draft.account} maxLength={240}
          onChange={(e) => setField('account', e.target.value)} placeholder="e.g. name@example.com" /></div>
    </div>
    <div className="group-editor-field">
      <label htmlFor="entry-group">Group</label>
      <select id="entry-group" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
        <option value="">Ungrouped</option>
        {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select>
      <p className="muted small">Choose where this code should appear in your list.</p>
    </div>
    <label htmlFor="secret">Setup key {entry ? '(leave blank to keep your current key)' : ''}</label>
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
    <p className="muted small setup-key-help">You'll find this key in your website or app's two-step verification settings.</p>
    <details className="advanced-settings">
      <summary>More code options</summary>
      <p className="advanced-hint">You can leave these as they are unless your website or app tells you to use different settings.</p>
      <div className="field-grid three">
        <div><label htmlFor="code-format">Code method</label>
          <select id="code-format" value={draft.algorithm}
            onChange={(e) => setField('algorithm', e.target.value as EntryDraft['algorithm'])}>
            <option value="SHA1">Standard (SHA-1)</option><option value="SHA256">SHA-256</option>
            <option value="SHA512">SHA-512</option>
          </select></div>
        <div><label htmlFor="code-digits">Code length</label>
          <select id="code-digits" value={draft.digits}
            onChange={(e) => setField('digits', Number(e.target.value) as 6 | 8)}>
            <option value={6}>6 digits</option><option value={8}>8 digits</option>
          </select></div>
        <div><label htmlFor="code-period">Changes every (seconds)</label>
          <input id="code-period" type="number" min={15} max={120} value={draft.period}
            onChange={(e) => setField('period', Number(e.target.value))} /></div>
      </div>
    </details>
    {error && <p className="message error" role="alert">{error}</p>}
    <div className="editor-actions"><button type="button" onClick={onCancel}>Cancel</button>
      <button type="submit" className="primary" disabled={busy || importing}>
        {busy ? 'Saving...' : entry ? 'Save changes' : 'Save verification code'} <span aria-hidden="true">→</span>
      </button>
    </div>
  </form>
}
