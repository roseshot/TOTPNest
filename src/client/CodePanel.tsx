import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiFailure, copyText, request } from './api'
import { readableError } from './messages'
import { visitorIdForShare } from './visitor'

type CodeWindow = {
  code: string
  serverNow: number
  validFrom: number
  expiresAt: number
  kind?: 'current' | 'next'
  label?: string
}
type CodeFrame = CodeWindow & { receivedAt: number }
type Props = { endpoint: string; unlock?: string; onAuthError?: (err: ApiFailure) => void }

function display(code: string): string {
  const midpoint = Math.ceil(code.length / 2)
  return code.slice(0, midpoint) + ' ' + code.slice(midpoint)
}

const NEXT_PREVIEW_WINDOW_MS = 5_000

/** Duration for a CSS-driven countdown, anchored to the server clock at receipt. */
export function countdownAnimationDuration(
  frame: Pick<CodeWindow, 'serverNow' | 'expiresAt'> | null
): number {
  return frame ? Math.max(0, frame.expiresAt - frame.serverNow) : 0
}

/** Always keep the currently valid code in the main position. */
export function currentCodeText(frame: Pick<CodeWindow, 'code' | 'expiresAt'> | null, now: number): string {
  return frame && now < frame.expiresAt ? display(frame.code) : '••• •••'
}

/** Show the upcoming code separately, only during the last five seconds of the current code. */
export function upcomingCodeText(
  current: Pick<CodeWindow, 'expiresAt'> | null,
  next: Pick<CodeWindow, 'code' | 'validFrom' | 'expiresAt' | 'kind'> | null,
  now: number
): string | null {
  if (!current || !next || next.kind !== 'next' ||
      next.validFrom !== current.expiresAt || next.expiresAt <= next.validFrom ||
      now >= current.expiresAt || current.expiresAt - now > NEXT_PREVIEW_WINDOW_MS) return null
  return display(next.code)
}

export function CodePanel({ endpoint, unlock, onAuthError }: Props) {
  const [current, setCurrent] = useState<CodeFrame | null>(null)
  const [next, setNext] = useState<CodeWindow | null>(null)
  const [tick, setTick] = useState(() => performance.now())
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [manualCopy, setManualCopy] = useState(false)
  const flight = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const requestedFor = useRef<number | null>(null)
  // New ID for each public page view. Reused across code changes and network retries.
  const visitId = useRef<string | null>(null)
  const visitorId = useRef<Promise<string> | null>(null)
  const retryAt = useRef(0)
  const active = useRef(true)
  const authError = useRef(onAuthError)
  const copyTimeout = useRef<number | null>(null)
  useEffect(() => { authError.current = onAuthError }, [onAuthError])
  useEffect(() => () => {
    if (copyTimeout.current !== null) window.clearTimeout(copyTimeout.current)
  }, [])

  const applyCurrent = useCallback((value: CodeWindow) => {
    if (!active.current) return
    setCurrent({ ...value, receivedAt: performance.now() })
    if (copyTimeout.current !== null) window.clearTimeout(copyTimeout.current)
    copyTimeout.current = null
    setCopied(false)
    setManualCopy(false)
    setNext(null)
    setError('')
    requestedFor.current = null
    retryAt.current = 0
  }, [])

  const send = useCallback(async (
    suffix: 'code' | 'next', expectedExpiry?: number, signal?: AbortSignal
  ): Promise<CodeWindow> => {
    const publicCode = suffix === 'code' && endpoint.startsWith('/api/share/')
    if (publicCode && !visitId.current) visitId.current = crypto.randomUUID()
    if (publicCode && !visitorId.current) visitorId.current = visitorIdForShare(endpoint)
    // Keep the same IDs across automatic refreshes and retries for this page.
    const browserId = publicCode && visitorId.current ? await visitorId.current : undefined
    return request<CodeWindow>(endpoint + '/' + suffix, {
      method: 'POST', unlock, signal,
      ...(publicCode ? { visitId: visitId.current || undefined, visitorId: browserId } : {}),
      ...(suffix === 'next' ? { body: { expectedExpiry } } : {})
    })
  }, [endpoint, unlock])

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
        setError(readableError(err))
        authError.current?.(err)
        retryAt.current = performance.now() + (err.code === 'LOCKED' ? (err.retryAfterSeconds ?? 60) * 1000 : 3_000)
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
      else if (frame.kind === 'next' && frame.validFrom === expiry &&
               frame.expiresAt > frame.validFrom) {
        setNext(adjusted)
        setError('')
      } else throw new Error('The upcoming code is not available. Please try again.')
    } catch (failure) {
      if (version === generation.current && active.current) {
        const err = failure as ApiFailure
        setError(err.code === 'TOO_EARLY' ? '' : readableError(err))
        authError.current?.(err)
        requestedFor.current = null
        retryAt.current = performance.now() + (err.code === 'LOCKED' ? (err.retryAfterSeconds ?? 60) * 1000 : 1_500)
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
    setManualCopy(false)
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

  const now = current ? current.serverNow + (tick - current.receivedAt) : 0
  const remaining = current ? Math.max(0, current.expiresAt - now) : 0
  const lifetime = current ? current.expiresAt - current.validFrom : 30_000
  const percentage = Math.min(100, Math.max(0, remaining / lifetime * 100))
  const expiringSoon = current !== null && remaining > 0 && remaining <= NEXT_PREVIEW_WINDOW_MS
  const previewCode = upcomingCodeText(current, next, now)
  const expired = current !== null && now >= current.expiresAt

  useEffect(() => {
    let interval: number | undefined
    const syncTimer = () => {
      if (interval !== undefined) window.clearInterval(interval)
      setTick(performance.now())
      if (document.visibilityState === 'visible') {
        interval = window.setInterval(() => setTick(performance.now()),
          expiringSoon ? 250 : 1_000)
      }
    }
    syncTimer()
    document.addEventListener('visibilitychange', syncTimer)
    return () => {
      if (interval !== undefined) window.clearInterval(interval)
      document.removeEventListener('visibilitychange', syncTimer)
    }
  }, [expiringSoon])

  useEffect(() => {
    if (!current) {
      if (retryAt.current > 0 && performance.now() >= retryAt.current) void fetchCurrent()
      return
    }
    if (expired) {
      if (next && next.validFrom === current.expiresAt && now < next.expiresAt) {
        // Use the prefetched code right at rollover, without an extra network request.
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
    if (remaining <= NEXT_PREVIEW_WINDOW_MS && remaining > 0 && !next && !flight.current &&
        requestedFor.current !== current.expiresAt && performance.now() >= retryAt.current) {
      void fetchNext(current.expiresAt)
    }
  }, [tick, current, next, remaining, expired, now, fetchCurrent, fetchNext, applyCurrent])

  const doCopy = async () => {
    if (!current || expired) return
    // Copy the currently valid code even when the next code is being previewed.
    if (await copyText(current.code)) {
      setManualCopy(false)
      setCopied(true)
      if (copyTimeout.current !== null) window.clearTimeout(copyTimeout.current)
      copyTimeout.current = window.setTimeout(() => {
        copyTimeout.current = null
        setCopied(false)
      }, 1400)
    } else {
      setCopied(false)
      setManualCopy(true)
    }
  }


  return <section className="code-panel" aria-label="Verification code">
    {current?.label && <p className="share-public-label">{current.label}</p>}
    <div className="code-head">
      <span className="code-kicker">SIGN-IN CODE</span>
      <span role="status" className={'status ' + (!current || expired || expiringSoon ? 'warning' : 'success')}>
        {!current ? error ? "Couldn't load" : 'Loading' : expired ? 'Updating' : expiringSoon ? 'Changes soon' : 'Ready to use'}
      </span>
    </div>
    <div className="code-visual">
      <div className="code-main">
        <span className="code-label">Current code</span>
        <div className="code-digits" aria-live="off">{currentCodeText(current, now)}</div>
      </div>
    </div>
    <button type="button" className="code-copy" disabled={!current || expired}
      onClick={() => void doCopy()} aria-label="Copy current code">
      <span aria-hidden="true">▣</span> {copied ? 'Copied' : 'Copy code'}
    </button>
    <div className="progress" role="progressbar" aria-label="Time remaining for current code"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percentage)}
      aria-valuetext={current && !expired ? Math.ceil(remaining / 1000) + ' seconds left' : 'Waiting for a code'}>
      <div key={current ? current.validFrom : 'loading'}
        className={'progress-fill ' + (current ? '' : 'loading ') + (expiringSoon ? 'amber' : '')}
        style={{
          transform: 'scaleX(' + percentage / 100 + ')',
          animationDuration: countdownAnimationDuration(current) + 'ms'
        }} />
    </div>
    <div className="code-foot">
      <span role="status" aria-live="polite">{copied ? 'Copied to clipboard' : 'Updates automatically'}</span>
      <span>{current && !expired ? Math.ceil(remaining / 1000) + ' seconds left' : error ? "Couldn't load the code" : 'Loading your code...'}</span>
    </div>
    <div className="code-server-time" aria-label="Server time">
      <span>Server time</span>
      <time dateTime={current ? new Date(now).toISOString() : undefined}>
        {current ? new Date(now).toLocaleString() : 'Synchronizing...'}
      </time>
    </div>
    {previewCode ? <div className="next-code-preview" aria-label="Upcoming code">
      <div className="next-code-details">
        <span className="next-code-label">Next code</span>
        <small>Not active yet · Available in {Math.ceil(remaining / 1000)} seconds</small>
      </div>
      <strong className="next-code-digits" aria-live="off">{previewCode}</strong>
    </div> : expiringSoon && <p className="code-expiry-note" role="status">
      This code is about to change. The next code will appear when it's ready.
    </p>}
    {manualCopy && current && !expired && <div className="manual-code" role="group" aria-label="Copy code manually">
      <label htmlFor="manual-code-value">Couldn't copy automatically. Select the code below to copy it.</label>
      <input id="manual-code-value" type="text" readOnly autoFocus value={current.code}
        onFocus={(event) => event.currentTarget.select()} autoComplete="off" />
    </div>}
    {error && <div className="message error" role="alert">{error}
      {Number.isFinite(retryAt.current) && performance.now() >= retryAt.current && <button className="link-button"
        onClick={() => { retryAt.current = 0; void fetchCurrent() }}>Retry</button>}</div>}
  </section>
}
