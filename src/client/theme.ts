/** User-selected appearance, with system preference as the first-visit default. */
export type Theme = 'dark' | 'light'
export const THEME_STORAGE_KEY = 'totpnest:theme'

export function resolveTheme(saved: string | null, prefersLight: boolean): Theme {
  return saved === 'dark' || saved === 'light' ? saved : prefersLight ? 'light' : 'dark'
}

export function savedTheme(): string | null {
  try { return window.localStorage.getItem(THEME_STORAGE_KEY) }
  catch { return null }
}

export function systemPrefersLight(): boolean {
  try { return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false }
  catch { return false }
}

export function preferredTheme(): Theme {
  return resolveTheme(savedTheme(), systemPrefersLight())
}

export function currentTheme(): Theme {
  if (typeof document !== 'undefined') {
    const current = document.documentElement.dataset.theme
    if (current === 'light' || current === 'dark') return current
  }
  return preferredTheme()
}

export function applyTheme(theme: Theme, persist = false): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'light' ? '#f4f7fc' : '#0d1422')
  }
  if (persist) {
    try { window.localStorage.setItem(THEME_STORAGE_KEY, theme) }
    catch { /* Changing the theme also works with storage disabled. */ }
  }
}
