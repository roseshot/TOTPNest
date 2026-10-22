import type { Theme } from './theme'

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const next = theme === 'dark' ? 'light' : 'dark'
  return <button type="button" className="theme-toggle" onClick={onToggle}
    aria-label={'Switch to ' + next + ' mode'} title={'Switch to ' + next + ' mode'}>
    <span className="theme-toggle-icon" aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
    <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
  </button>
}
