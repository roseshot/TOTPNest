/**
 * Delete expired and legacy-revoked share records from D1.
 *
 * Authorization checks compare expires_at to Date.now() on every code request,
 * so a delayed Cron Trigger never extends a share's effective lifetime.
 */
export async function cleanupExpiredShares(db: D1Database, now: number): Promise<void> {
  const session = db.withSession('first-primary')
  await session.prepare(`DELETE FROM shares
    WHERE revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?)`)
    .bind(now).run()
}

