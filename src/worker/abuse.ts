import type { DbSession } from './db'

/**
 * Failure counters are stored in D1 and checked on primary-first sessions.
 * Keys must scope to a visitor, not to the entire administrator account.
 */
export type FailurePolicy = { threshold: number; windowMs: number; lockMs: number }
export const PASSWORD_FAILURE_POLICY: FailurePolicy = {
  threshold: 5, windowMs: 30 * 60_000, lockMs: 30 * 60_000
}
export const SHARE_ID_FAILURE_POLICY: FailurePolicy = {
  threshold: 10, windowMs: 24 * 60 * 60_000, lockMs: 24 * 60 * 60_000
}

type FailureRow = { count: number; reset_at: number }

/** Return the lock expiry, or null if this visitor may proceed. */
export async function lockedUntil(
  db: DbSession, key: string, policy: FailurePolicy, now = Date.now()
): Promise<number | null> {
  const row = await db.prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?')
    .bind(key).first<FailureRow>()
  return row && row.count >= policy.threshold && row.reset_at > now ? row.reset_at : null
}

/**
 * Atomically record a failed attempt. The final allowed failure starts the
 * full lock duration; an existing lock cannot be extended by new attempts.
 */
export async function recordFailure(
  db: DbSession, key: string, policy: FailurePolicy, now = Date.now()
): Promise<number | null> {
  const windowEnd = now + policy.windowMs
  const lockEnd = now + policy.lockMs
  const row = await db.prepare(`INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE
        WHEN rate_limits.reset_at <= ? THEN ?
        WHEN rate_limits.count = ? THEN ?
        ELSE rate_limits.reset_at
      END
    RETURNING count, reset_at`)
    .bind(key, windowEnd, now, now, windowEnd, policy.threshold - 1, lockEnd)
    .first<FailureRow>()
  return row && row.count >= policy.threshold ? row.reset_at : null
}

export async function clearFailures(db: DbSession, key: string): Promise<void> {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run()
}

