/** Public routes never fall back to an administration screen. */
const SHARE_ID_PATTERN = /^(?:[A-Za-z0-9]{22}|[0-9a-f]{32})$/

export type AppRoute =
  | { kind: 'home' }
  | { kind: 'admin' }
  | { kind: 'share'; id: string }
  | { kind: 'invalid-share' }
  | { kind: 'not-found' }

/** Share IDs are case-sensitive. Never normalize their letter casing. */
export function parseShareId(input: string): string | null {
  const id = input.trim()
  return SHARE_ID_PATTERN.test(id) ? id : null
}

/** Accept a bare Share ID or extract one from a canonical share URL. */
export function parseShareInput(input: string): string | null {
  const value = input.trim()
  const directId = parseShareId(value)
  if (directId) return directId

  let url: URL
  try {
    const candidate = value.startsWith('/')
      ? value
      : /^[a-z][a-z\d+.-]*:/i.test(value) ? value : 'https://' + value
    url = new URL(candidate, 'https://totpnest.invalid')
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  const match = new RegExp('^/s/([^/]+)/?
export function routeForPath(pathname: string): AppRoute {
  if (pathname === '/') return { kind: 'home' }
  if (pathname === '/admin' || pathname === '/admin/') return { kind: 'admin' }
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname)
  if (match) {
    const id = parseShareId(match[1])
    return id ? { kind: 'share', id } : { kind: 'invalid-share' }
  }
  return { kind: 'not-found' }
}

).exec(url.pathname)
  if (!match) return null
  try {
    return parseShareId(decodeURIComponent(match[1]))
  } catch {
    return null
  }
}

export function sharePathForId(input: string): string | null {
  const id = parseShareInput(input)
  return id === null ? null : '/s/' + id
}

export function routeForPath(pathname: string): AppRoute {
  if (pathname === '/') return { kind: 'home' }
  if (pathname === '/admin' || pathname === '/admin/') return { kind: 'admin' }
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname)
  if (match) {
    const id = parseShareId(match[1])
    return id ? { kind: 'share', id } : { kind: 'invalid-share' }
  }
  return { kind: 'not-found' }
}

