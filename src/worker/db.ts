/**
 * D1 read replication routing.
 * Public code paths and mutations start from the primary, so revocation and
 * authentication decisions are never made from a potentially stale replica.
 * Read-only admin lists can start at a nearby replica. The client forwards
 * bookmarks to maintain read-your-writes across separate HTTP requests.
 */
export const BOOKMARK_HEADER = 'X-D1-Bookmark'
export type DbSession = D1DatabaseSession

export function sessionConstraint(
  path: string, method: string, bookmark: string | null
): string {
  const replicaSafe = method === 'GET' &&
    (path === '/api/admin/entries' || path === '/api/admin/groups')

  if (!replicaSafe) return 'first-primary'
  if (bookmark && bookmark.length <= 1024 && !/[\r\n\x00-\x1f\x7f]/.test(bookmark)) {
    return bookmark
  }
  return 'first-unconstrained'
}

export function openSession(
  database: D1Database, path: string, method: string, bookmark: string | null
): DbSession {
  return database.withSession(sessionConstraint(path, method, bookmark))
}
