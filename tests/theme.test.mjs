import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, currentTheme, preferredTheme, resolveTheme, THEME_STORAGE_KEY } from '../src/client/theme'

const boot = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8')
afterEach(() => vi.unstubAllGlobals())

function bootTheme(saved, systemLight) {
  const attrs = {}
  const dataset = {}
  const doc = {
    documentElement: { dataset },
    querySelector: () => ({ setAttribute: (name, value) => { attrs[name] = value } })
  }
  const win = {
    localStorage: { getItem: () => saved },
    matchMedia: () => ({ matches: systemLight })
  }
  runInNewContext(boot, { window: win, document: doc })
  return { theme: dataset.theme, color: attrs.content }
}

describe('theme preferences', () => {
  it('uses the system setting for the first visit', () => {
    expect(resolveTheme(null, true)).toBe('light')
    expect(resolveTheme(null, false)).toBe('dark')
    expect(bootTheme(null, true)).toEqual({ theme: 'light', color: '#f4f7fc' })
    expect(bootTheme(null, false)).toEqual({ theme: 'dark', color: '#0d1422' })
  })
  it('uses a saved setting on future visits', () => {
    expect(bootTheme('light', false).theme).toBe('light')
    expect(bootTheme('dark', true).theme).toBe('dark')
    expect(resolveTheme('unknown', true)).toBe('light')
  })
  it('still works when storage is blocked', () => {
    const dataset = {}
    vi.stubGlobal('window', {
      get localStorage() { throw new Error('storage is blocked') },
      matchMedia: () => ({ matches: true })
    })
    expect(preferredTheme()).toBe('light')
    vi.stubGlobal('document', { documentElement: { dataset }, querySelector: () => null })
    expect(() => applyTheme('dark', true)).not.toThrow()
    expect(currentTheme()).toBe('dark')
  })
  it('saves the visitor choice without a network request', () => {
    const values = new Map()
    const dataset = {}
    const attributes = {}
    vi.stubGlobal('window', {
      localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, val) => values.set(key, val) },
      matchMedia: () => ({ matches: false })
    })
    vi.stubGlobal('document', {
      documentElement: { dataset },
      querySelector: () => ({ setAttribute: (key, val) => { attributes[key] = val } })
    })
    applyTheme('light', true)
    expect(values.get(THEME_STORAGE_KEY)).toBe('light')
    expect(preferredTheme()).toBe('light')
    expect(attributes.content).toBe('#f4f7fc')
  })
  it('loads the early theme script from the same site to honor the CSP', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
    expect(html).toContain('<script src="/theme-init.js"></script>')
    expect(headers).toContain("script-src 'self'")
    expect(html).not.toMatch(/<script(?![^>]*src=)[^>]*>/)
  })
})
