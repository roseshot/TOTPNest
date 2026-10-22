import { describe, expect, it, vi } from 'vitest'
import { openSession, sessionConstraint } from '../src/worker/db'

describe('D1 read replication policies', () => {
  it('permits replica reads for ordinary admin lists', () => {
    expect(sessionConstraint('/api/admin/entries', 'GET', null)).toBe('first-unconstrained')
    expect(sessionConstraint('/api/admin/groups', 'GET', 'bookmark-from-a-write')).toBe('bookmark-from-a-write')
    // View counts should be fresh rather than served from a possibly stale replica.
    expect(sessionConstraint('/api/admin/shares', 'GET', null)).toBe('first-primary')
  })

  it('requires a primary-first session for access checks and writes', () => {
    const sensitive = [
      ['/api/admin/session', 'GET'],
      ['/api/admin/entries/123/code', 'POST'],
      ['/api/admin/entries', 'POST'],
      ['/api/admin/shares', 'POST'],
      ['/api/admin/groups', 'POST'],
      ['/api/admin/entries/123/group', 'PUT'],
      ['/api/admin/shares', 'GET'],
      ['/api/admin/shares/123', 'DELETE'],
      ['/api/share/123/code', 'POST'],
      ['/api/share/123/next', 'POST'],
      ['/api/share/123/unlock', 'POST']
    ] as const
    for (const [path, method] of sensitive) {
      expect(sessionConstraint(path, method, 'possibly-stale')).toBe('first-primary')
    }
  })

  it('rejects oversized or malformed bookmarks', () => {
    expect(sessionConstraint('/api/admin/entries', 'GET', 'x'.repeat(1025))).toBe('first-unconstrained')
    expect(sessionConstraint('/api/admin/entries', 'GET', 'bad\nvalue')).toBe('first-unconstrained')
  })

  it('uses a real D1 session binding instead of direct database queries', () => {
    const session = { getBookmark: () => 'after-write' }
    const withSession = vi.fn(() => session)
    const database = { withSession } as unknown as D1Database
    expect(openSession(database, '/api/admin/entries', 'GET', 'earlier')).toBe(session)
    expect(withSession).toHaveBeenCalledExactlyOnceWith('earlier')
  })
})
