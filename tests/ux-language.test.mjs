import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/client/App.tsx', import.meta.url), 'utf8')
const dashboard = readFileSync(new URL('../src/client/Dashboard.tsx', import.meta.url), 'utf8')
const login = readFileSync(new URL('../src/client/App.tsx', import.meta.url), 'utf8')
const entryEditor = readFileSync(new URL('../src/client/EntryEditor.tsx', import.meta.url), 'utf8')
const sharePanel = readFileSync(new URL('../src/client/ShareLinksPanel.tsx', import.meta.url), 'utf8')
const code = readFileSync(new URL('../src/client/CodePanel.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')

describe('task-focused interface language and flows', () => {
  it('keeps implementation details out of the on-screen descriptions', () => {
    expect(app).not.toMatch(/Encrypted storage|Security-focused TOTP management|One private admin/)
    expect(app).not.toContain('otpauth:// link')
    expect(app).not.toContain('Your keys are encrypted before')
    expect(dashboard).toContain('Find your sign-in code, fast.')
    expect(entryEditor).toContain('Paste the setup link provided by your service.')
  })

  it('asks which account to share instead of silently picking the selected one', () => {
    expect(dashboard).toContain("if (tab === 'shares' && entries.length > 0)")
    expect(dashboard).toContain('setChoosingShare(true)')
    expect(dashboard).toContain('setSharing(choosingShare)')
    expect(dashboard).toContain('Which code would you like to share?')
    expect(dashboard + sharePanel).not.toContain('Stop sharingd')
  })

  it('provides a retry when sign-in status cannot be checked', () => {
    expect(login).toContain('setSessionError(readableError(cause))')
    expect(login).toContain('Couldn\'t open your codes')
    expect(login).toContain('Try again')
  })

  it('labels visits and estimated unique browsers distinctly in the share list', () => {
    expect(sharePanel).toContain('Views: {share.viewCount}')
    expect(sharePanel).toContain('UV (90d)</abbr>: {share.uniqueVisitors}')
    expect(sharePanel).toContain('Unique browsers in the last 90 days')
  })

  it('prioritizes the usable code and the primary task on small screens', () => {
    expect(code).toContain('This code is about to change.')
    expect(code).toContain('return display(next.code)')
    expect(code).toContain('Not active yet')
    expect(code).toContain('Copy code manually')
    expect(code).toContain("send('next'")
    expect(css).toContain('.next-code-preview')
    expect(css).not.toContain('.timer-ring')
    expect(css).toContain('.hero-banner, .metric-grid { display: none; }')
  })
})
