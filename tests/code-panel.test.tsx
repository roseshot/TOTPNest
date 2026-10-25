import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { CodePanel, countdownAnimationDelay, countdownAnimationDuration, currentCodeText, upcomingCodeText } from '../src/client/CodePanel'

describe('code display UX', () => {
  it('keeps progress animation duration fixed to the complete code-refresh period', () => {
    expect(countdownAnimationDuration({ validFrom: 0, expiresAt: 30_000 })).toBe(30_000)
    expect(countdownAnimationDuration({ validFrom: 10_000, expiresAt: 40_000 })).toBe(30_000)
    expect(countdownAnimationDuration({ validFrom: 10_000, expiresAt: 10_000 })).toBe(0)
    expect(countdownAnimationDuration(null)).toBe(0)
  })

  it('offsets the fixed-period animation by elapsed time without changing its duration', () => {
    expect(countdownAnimationDelay({ serverNow: 12_500, validFrom: 10_000 })).toBe(-2_500)
    expect(countdownAnimationDelay({ serverNow: 10_000, validFrom: 10_000 })).toBe(0)
    expect(countdownAnimationDelay(null)).toBe(0)
  })

  it('displays only the current valid code and masks expired or missing codes', () => {
    expect(currentCodeText({ code: '123456', expiresAt: 30_000 }, 24_000)).toBe('123 456')
    expect(currentCodeText({ code: '123456', expiresAt: 30_000 }, 30_000)).toBe('••• •••')
    expect(currentCodeText(null, 0)).toBe('••• •••')
  })

  it('previews the next code only during the last five seconds of the current code', () => {
    const current = { code: '123456', expiresAt: 30_000 }
    const next = { code: '987654', validFrom: 30_000, expiresAt: 60_000, kind: 'next' as const }
    expect(upcomingCodeText(current, next, 24_999)).toBeNull()
    expect(upcomingCodeText(current, next, 25_000)).toBe('987 654')
    expect(upcomingCodeText(current, next, 29_999)).toBe('987 654')
    expect(currentCodeText(current, 29_999)).toBe('123 456')
    expect(upcomingCodeText(current, next, 30_000)).toBeNull()
    expect(currentCodeText(current, 30_000)).toBe('••• •••')
  })

  it('never previews a stale, invalid or mismatched upcoming code', () => {
    const current = { expiresAt: 30_000 }
    const next = { code: '987654', validFrom: 30_000, expiresAt: 60_000, kind: 'next' as const }
    expect(upcomingCodeText(null, next, 27_000)).toBeNull()
    expect(upcomingCodeText(current, null, 27_000)).toBeNull()
    expect(upcomingCodeText(current, { ...next, kind: 'current' }, 27_000)).toBeNull()
    expect(upcomingCodeText(current, { ...next, validFrom: 29_000 }, 27_000)).toBeNull()
    expect(upcomingCodeText(current, { ...next, expiresAt: 30_000 }, 27_000)).toBeNull()
    expect(upcomingCodeText(current, next, 31_000)).toBeNull()
  })

  it('labels loading state accurately and offers an accessible copy action', () => {
    const html = renderToStaticMarkup(createElement(CodePanel, { endpoint: '/api/share/example' }))
    expect(html).toContain('Current code')
    expect(html).toContain('SIGN-IN CODE')
    expect(html).toContain('Copy code')
    expect(html).not.toContain('Next code')
    expect(html).toContain('Loading')
    expect(html).toContain('aria-label="Copy current code"')
    expect(html).toContain('aria-label="Time remaining for current code"')
    expect(html.match(/role="progressbar"/g)).toHaveLength(1)
    expect(html).not.toContain('class="timer-ring"')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('Ready to use')
  })
})
