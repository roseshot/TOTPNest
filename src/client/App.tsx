import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { request } from './api'
import { PublicUnavailable, ShareIdHome, SharePage } from './PublicPages'
import { readableError } from './messages'
import { routeForPath } from './routes'
import { Login } from './Login'
import { Dashboard } from './Dashboard'
import { ThemeToggle } from './ThemeToggle'
import { applyTheme, currentTheme, preferredTheme, savedTheme, THEME_STORAGE_KEY, type Theme } from './theme'

function AdminApp({ theme, onThemeToggle }: { theme: Theme; onThemeToggle: () => void }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [sessionError, setSessionError] = useState('')
  const [checking, setChecking] = useState(true)
  const checkSession = useCallback(async () => {
    setChecking(true)
    setSessionError('')
    try {
      const result = await request<{ authenticated: boolean }>('/api/admin/session')
      setAuthenticated(result.authenticated)
    } catch (cause) {
      setAuthenticated(null)
      setSessionError(readableError(cause))
    } finally { setChecking(false) }
  }, [])
  useEffect(() => { void checkSession() }, [checkSession])
  useEffect(() => {
    document.title = authenticated ? 'TOTPNest | Your codes' : 'TOTPNest | Sign in'
  }, [authenticated])
  if (authenticated) return <Dashboard onLogout={() => setAuthenticated(false)}
    theme={theme} onThemeToggle={onThemeToggle} />
  return <>
    <div className="theme-corner"><ThemeToggle theme={theme} onToggle={onThemeToggle} /></div>
    {checking ? <main className="login-shell"><p className="muted" role="status">Checking your sign-in...</p></main>
      : sessionError ? <main className="login-shell"><section className="card sign-in-error">
          <h1>Couldn't open your codes</h1>
          <p className="muted">{sessionError}</p>
          <button type="button" className="primary" onClick={() => void checkSession()}>Try again</button>
        </section></main>
      : <Login onLogin={() => setAuthenticated(true)} />}
  </>
}

export function App() {
  const [theme, setTheme] = useState<Theme>(currentTheme)
  useEffect(() => { applyTheme(theme) }, [theme])
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: light)')
    const sync = () => { setTheme(preferredTheme()) }
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) sync()
    }
    const onSystemChange = () => { if (savedTheme() !== 'light' && savedTheme() !== 'dark') sync() }
    window.addEventListener('storage', onStorage)
    media?.addEventListener?.('change', onSystemChange)
    return () => {
      window.removeEventListener('storage', onStorage)
      media?.removeEventListener?.('change', onSystemChange)
    }
  }, [])
  const onThemeToggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    applyTheme(next, true)
    setTheme(next)
  }
  const route = routeForPath(window.location.pathname)
  if (route.kind === 'admin') return <AdminApp theme={theme} onThemeToggle={onThemeToggle} />
  let page: ReactNode
  switch (route.kind) {
    case 'home': page = <ShareIdHome />; break
    case 'share': page = <SharePage id={route.id} />; break
    case 'invalid-share': page = <PublicUnavailable invalidShare />; break
    default: page = <PublicUnavailable />
  }
  return <>
    <div className="theme-corner"><ThemeToggle theme={theme} onToggle={onThemeToggle} /></div>
    {page}
  </>
}
