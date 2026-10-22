const BOOKMARK_KEY = 'totpnest:d1-bookmark'
const BOOKMARK_HEADER = 'X-D1-Bookmark'

// Keep the most recent successful admin write visible on subsequent replica reads.
// Public visitors do not persist or send the administrator's database bookmark.
function storedBookmark(): string | null {
  try { return window.sessionStorage.getItem(BOOKMARK_KEY) }
  catch { return null }
}
function saveBookmark(bookmark: string) {
  try { window.sessionStorage.setItem(BOOKMARK_KEY, bookmark) } catch { /* Storage blocked. */ }
}
export function clearBookmark() {
  try { window.sessionStorage.removeItem(BOOKMARK_KEY) } catch { /* Storage blocked. */ }
}

// Parallel list responses must not overwrite a bookmark obtained by a newer write.
export function shouldAdvanceBookmark(method: string, sent: string | null, stored: string | null) {
  return method !== 'GET' || sent === stored
}

export class ApiFailure extends Error {
  constructor(message: string, public status: number, public code = '') { super(message) }
}

export async function request<T>(
  path: string, options: { method?: string; body?: unknown; token?: string; unlock?: string } = {}
): Promise<T> {
  const headers: Record<string, string> = {}
  const method = options.method || 'GET'
  const admin = path.startsWith('/api/admin/')
  const sentBookmark = admin ? storedBookmark() : null
  if (sentBookmark) headers[BOOKMARK_HEADER] = sentBookmark
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.token) headers.Authorization = 'Bearer ' + options.token
  if (options.unlock) headers['X-Share-Unlock'] = options.unlock
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    })
  } catch {
    throw new ApiFailure('Network connection failed', 0, 'NETWORK')
  }
  // The bookmark is opaque. A write always supersedes earlier parallel reads.
  if (response.ok && admin) {
    if (path === '/api/admin/logout') clearBookmark()
    else {
      if (path === '/api/admin/login') clearBookmark()
      const bookmark = response.headers.get(BOOKMARK_HEADER)
      if (bookmark && shouldAdvanceBookmark(method, sentBookmark, storedBookmark())) {
        saveBookmark(bookmark)
      }
    }
  }
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    throw new ApiFailure(
      typeof error.error === 'string' ? error.error : 'Request failed',
      response.status, typeof error.code === 'string' ? error.code : ''
    )
  }
  return payload as T
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true }
  catch { return false }
}
