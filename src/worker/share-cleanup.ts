/**
 * Physically remove inactive shares only at the scheduled UTC midnight cutoff.
 *
 * The scheduled event supplies its intended UTC time, not the actual invocation
 * time, so a delayed Cron Trigger cannot purge records that became inactive
 * after midnight. Request authorization independently checks revocation and
 * expiration immediately, even while the row is retained.
 */
export async function cleanupExpiredShares(db: D1Database, cutoff: number): Promise<void> {
  const session = db.withSession('first-primary')
  await session.prepare(`DELETE FROM shares
    WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
       OR (expires_at IS NOT NULL AND expires_at <= ?)`)
    .bind(cutoff, cutoff).run()
}

