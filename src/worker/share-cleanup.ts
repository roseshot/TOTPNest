import type { DbSession } from './db'

const DAY_MS = 24 * 60 * 60_000
const VISIT_RECEIPT_RETENTION_MS = 30 * DAY_MS
const UNIQUE_VISITOR_RETENTION_MS = 90 * DAY_MS

const ARCHIVE_SELECT = `
  INSERT OR IGNORE INTO share_history (
    id, issuer, account, public_label, note, expires_at,
    created_at, ended_at, reason, view_count, unique_visitors
  )
  SELECT shares.id, entries.issuer, entries.account, shares.public_label, shares.note,
    shares.expires_at, shares.created_at, ?, __REASON__,
    COALESCE(stats.view_count, 0),
    (SELECT COUNT(*) FROM share_unique_visitors visitors
      WHERE visitors.share_id = shares.id AND visitors.last_seen_at >= ?)
  FROM shares
  INNER JOIN entries ON entries.id = shares.entry_id
  LEFT JOIN share_stats stats ON stats.share_id = shares.id
  WHERE __WHERE__
`

async function archive(
  db: DbSession, where: string, bindings: Array<string | number>,
  reason: string, endedAt: number
): Promise<void> {
  const sql = ARCHIVE_SELECT.replace('__REASON__', reason).replace('__WHERE__', where)
  await db.prepare(sql).bind(endedAt, endedAt - UNIQUE_VISITOR_RETENTION_MS, ...bindings).run()
}

export async function archiveShare(db: DbSession, shareId: string, endedAt: number): Promise<void> {
  await archive(db, 'shares.id = ? AND shares.revoked_at IS NOT NULL', [shareId], "'revoked'", endedAt)
}

export async function archiveSharesForEntry(db: DbSession, entryId: string, endedAt: number): Promise<void> {
  await archive(db, 'shares.entry_id = ?', [entryId], "'entry_deleted'", endedAt)
}

/**
 * Archive inactive links before physically deleting their bearer IDs and password
 * verifiers. Views remain lifetime totals; UV is rolling 90 days. The scheduled
 * timestamp, not invocation time, defines every retention cutoff.
 */
export async function cleanupExpiredShares(db: D1Database, cutoff: number): Promise<void> {
  const session = db.withSession('first-primary')
  const archiveInactive = session.prepare(ARCHIVE_SELECT
    .replace('__REASON__', "CASE WHEN shares.revoked_at IS NOT NULL THEN 'revoked' ELSE 'expired' END")
    .replace('__WHERE__', '((shares.revoked_at IS NOT NULL AND shares.revoked_at < ?) OR (shares.expires_at IS NOT NULL AND shares.expires_at <= ?))'))
    .bind(cutoff, cutoff - UNIQUE_VISITOR_RETENTION_MS, cutoff, cutoff)
  await session.batch([
    archiveInactive,
    session.prepare(`DELETE FROM shares
      WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
         OR (expires_at IS NOT NULL AND expires_at <= ?)`).bind(cutoff, cutoff),
    session.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(cutoff),
    session.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(cutoff),
    session.prepare('DELETE FROM share_visits WHERE viewed_at < ?')
      .bind(cutoff - VISIT_RECEIPT_RETENTION_MS),
    session.prepare('DELETE FROM share_unique_visitors WHERE last_seen_at < ?')
      .bind(cutoff - UNIQUE_VISITOR_RETENTION_MS)
  ])
}
