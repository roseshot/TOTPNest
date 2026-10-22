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

export function sharePathForId(input: string): string | null {
  const id = parseShareId(input)
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

