import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiFailure, copyText, request } from './api'

type CodeWindow = {
  code: string
  serverNow: number
  validFrom: number
  expiresAt: number
  kind?: 'current' | 'next'
}
type CodeFrame = CodeWindow & { receivedAt: number }
type Props = { endpoint: string; token?: string; unlock?: string; onAuthError?: (err: ApiFailure) => void }

function display(code: string): string {
  const midpoint = Math.ceil(code.length / 2)
  return code.slice(0, midpoint) + ' ' + code.slice(midpoint)
}

export function CodePanel({ endpoint, token, unlock, onAuthError }: Props) {
  const [current, setCurrent] = useState<CodeFrame | null>(null)
  const [next, setNext] = useState<CodeWindow | null>(null)
  const [tick, setTick] = useState(() => performance.now())
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const flight = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const requestedFor = useRef<number | null>(null)
  const retryAt = useRef(0)
  const active = useRef(true)
  const authError = useRef(onAuthError)
  useEffect(() => { authError.current = onAuthError }, [onAuthError])

  const applyCurrent = useCallback((value: CodeWindow) => {
    if (!active.current) return
    setCurrent({ ...value, receivedAt: performance.now() })
    setNext(null)
    setError('')
    requestedFor.current = null
    retryAt.current = 0
  }, [])

  const send = useCallback((suffix: 'code' | 'next', expectedExpiry?: number, signal?: AbortSignal) =>
    request<CodeWindow>(endpoint + '/' + suffix, {
      method: 'POST', token, unlock, signal,
      ...(suffix === 'next' ? { body: { expectedExpiry } } : {})
    }), [endpoint, token, unlock])

  const fetchCurrent = useCallback(async () => {
    if (flight.current) return
    const version = generation.current
    const abort = new AbortController()
    controller.current = abort
    flight.current = true
    try {
      const startedAt = performance.now()
      const frame = await send('code', undefined, abort.signal)
      if (version !== generation.current || !active.current) return
      // Approximate one-way latency; the countdown is anchored to server time.
      applyCurrent({ ...frame, serverNow: frame.serverNow + (performance.now() - startedAt) / 2 })
    } catch (failure) {
      if (version === generation.current && active.current) {
        const err = failure as ApiFailure
        setError(err.message)
        authError.current?.(err)
        retryAt.current = performance.now() + 3_000
      }
    } finally {
      if (version === generation.current) {
        flight.current = false
        controller.current = null
      }
    }
  }, [applyCurrent, send])

  const fetchNext = useCallback(async (expiry: number) => {
    if (flight.current) return
    const version = generation.current
    const abort = new AbortController()
    controller.current = abort
    flight.current = true
    requestedFor.current = expiry
    try {
      const startedAt = performance.now()
      const frame = await send('next', expiry, abort.signal)
      if (version !== generation.current || !active.current) return
      const adjusted = { ...frame, serverNow: frame.serverNow + (performance.now() - startedAt) / 2 }
      if (frame.kind === 'current') applyCurrent(adjusted)
      else { setNext(frame); setError('') }
    } catch (failure) {
      if (version === generation.current && active.current) {
        const err = failure as ApiFailure
        setError(err.code === 'TOO_EARLY' ? '' : err.message)
        authError.current?.(err)
        requestedFor.current = null
        retryAt.current = performance.now() + 1_500
      }
    } finally {
      if (version === generation.current) {
        flight.current = false
        controller.current = null
      }
    }
  }, [send, applyCurrent])

  useEffect(() => {
    const version = ++generation.current
    active.current = true
    flight.current = false
    requestedFor.current = null
    retryAt.current = 0
    setTick(performance.now())
    setCurrent(null)
    setNext(null)
    setError('')
    void fetchCurrent()
    return () => {
      if (generation.current !== version) return
      generation.current++
      active.current = false
      controller.current?.abort()
      controller.current = null
      flight.current = false
    }
  }, [fetchCurrent])

  useEffect(() => {
    const interval = window.setInterval(() => setTick(performance.now()), 250)
    const visibility = () => { if (document.visibilityState === 'visible') setTick(performance.now()) }
    document.addEventListener('visibilitychange', visibility)
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', visibility) }
  }, [])

  const now = current ? current.serverNow + (tick - current.receivedAt) : 0
  const remaining = current ? Math.max(0, current.expiresAt - now) : 0
  const lifetime = current ? current.expiresAt - current.validFrom : 30_000
  const percentage = Math.min(100, Math.max(0, remaining / lifetime * 100))
  const preview = next && next.validFrom === current?.expiresAt && remaining > 0 && remaining <= 5_000
  const expired = current !== null && now >= current.expiresAt

  useEffect(() => {
    if (!current) {
      if (retryAt.current > 0 && performance.now() >= retryAt.current) void fetchCurrent()
      return
    }
    if (expired) {
      if (next && next.validFrom === current.expiresAt) {
        // Exact local rollover: no additional request until the new code's final five seconds.
        applyCurrent({
          ...next, serverNow: now, validFrom: next.validFrom,
          expiresAt: next.expiresAt
        })
      } else if (!flight.current && performance.now() >= retryAt.current) {
        setCurrent(null)
        void fetchCurrent()
      }
      return
    }
    if (remaining <= 5_000 && remaining > 0 && !next && !flight.current &&
        requestedFor.current !== current.expiresAt && performance.now() >= retryAt.current) {
      void fetchNext(current.expiresAt)
    }
  }, [tick, current, next, remaining, expired, now, fetchCurrent, fetchNext, applyCurrent])

  const doCopy = async () => {
    if (!current || expired) return
    // Copy the currently valid code even when the next code is being previewed.
    if (await copyText(current.code)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } else setError('Copy failed. Please select the code manually.')
  }

  return <section className="code-panel" aria-label="One-time password">
    <div className="code-head">
      <span>{preview ? 'Next code' : 'Current code'}</span>
      <span className={'status ' + (preview ? 'warning' : expired ? 'danger' : 'success')}>
        {preview ? `${Math.ceil(remaining / 1000)} seconds until active` : expired ? 'Expired' : 'Valid now'}
      </span>
    </div>
    <div className="code-main">
      <div className="code-digits" aria-live="off">
        {current && !expired ? display(preview ? next!.code : current.code) : '••• •••'}
      </div>
      <button type="button" className="icon-button copy-button" disabled={!current || expired}
        onClick={() => void doCopy()} aria-label="Copy the currently valid code" title="Copy the currently valid code">
        {copied ? '✓' : '⧉'}
      </button>
    </div>
    <div className="progress" role="progressbar" aria-label="Code validity remaining"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percentage)}>
      <div className={'progress-fill ' + (preview ? 'amber' : '')} style={{ width: percentage + '%' }} />
    </div>
    <div className="code-foot">
      <span>{preview && current ? `Currently valid: ${display(current.code)}` : copied ? 'Copied' : 'Auto-refresh'}</span>
      <span>{current && !expired ? Math.ceil(remaining / 1000) + ' seconds' : 'Connecting...'}</span>
    </div>
    {error && <div className="message error" role="alert">{error} <button className="link-button"
      onClick={() => { retryAt.current = 0; void fetchCurrent() }}>Retry</button></div>}
  </section>
}
