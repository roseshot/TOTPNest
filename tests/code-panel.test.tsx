import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { CodePanel, currentCodeText } from '../src/client/CodePanel'

describe('code display UX', () => {
  it('displays only the current valid code and masks expired or missing codes', () => {
    expect(currentCodeText({ code: '123456', expiresAt: 30_000 }, 24_000)).toBe('123 456')
    expect(currentCodeText({ code: '123456', expiresAt: 30_000 }, 30_000)).toBe('••• •••')
    expect(currentCodeText(null, 0)).toBe('••• •••')
  })

  it('labels loading state accurately and offers an accessible copy action', () => {
    const html = renderToStaticMarkup(createElement(CodePanel, { endpoint: '/api/share/example' }))
    expect(html).toContain('Current code')
    expect(html).toContain('Loading')
    expect(html).toContain('aria-label="Copy current code"')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('Ready to use')
  })
})
