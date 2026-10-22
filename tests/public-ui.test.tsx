import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { App } from '../src/client/App'

function renderPath(pathname: string): string {
  vi.stubGlobal('window', { location: { pathname } })
  vi.stubGlobal('sessionStorage', { getItem: () => null })
  return renderToStaticMarkup(<App />)
}

afterEach(() => vi.unstubAllGlobals())

describe('public UI', () => {
  it('shows the Share ID form instead of the admin login at the homepage', () => {
    const html = renderPath('/')
    expect(html).toContain('id="share-id-input"')
    expect(html).toContain('Copy the ID exactly as it appears, including capital letters.')
    expect(html).toContain('View a shared sign-in code.')
    expect(html).toContain('View shared code')
    expect(html).not.toContain('encrypted storage')
    expect(html).not.toContain('TOTP management')
    expect(html).toContain('/totpnest-logo.svg')
    expect(html).toContain('Switch to light mode')
    expect(html).not.toContain('Admin sign in')
    expect(html).not.toContain('href="/admin"')
  })

  it('never renders administrator controls for unknown paths', () => {
    for (const path of ['/unknown', '/s/invalid']) {
      const html = renderPath(path)
      expect(html).toContain('href="/"')
      expect(html).not.toContain('Admin sign in')
      expect(html).not.toContain('Sign out')
      expect(html).not.toContain('href="/admin"')
    }
  })

  it('renders the share code view without an admin entry', () => {
    const html = renderPath('/s/aB7kP2mQ9xR4tY6vN8zW3c')
    expect(html).toContain('Verification code')
    expect(html).toContain('Switch to light mode')
    expect(html).toContain("Only the code is shared here. The sender's account details stay hidden.")
    expect(html).not.toContain('Admin sign in')
    expect(html).not.toContain('href="/admin"')
  })

  it('still opens the shared code page when session storage is blocked', () => {
    vi.stubGlobal('window', { location: { pathname: '/s/aB7kP2mQ9xR4tY6vN8zW3c' } })
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('Storage denied') } })
    expect(renderToStaticMarkup(<App />)).toContain('Verification code')
  })
})

