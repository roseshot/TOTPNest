import type { Hono } from 'hono'
import { archiveShare } from './share-cleanup'
import {
  PASSWORD_FAILURE_POLICY, recordFailure
} from './abuse'
import {
  constantTimeEqual, issueUnlock, sha256, sharePasswordHash
} from './crypto'
import { newShareId } from './share-id'
import type { Environment, Share } from './types'
import { ApiError, UUID_V4_PATTERN } from './types'
import {
  assertNotLocked, blocked, codeFor, getEntry, getShare, jsonBody, limitedString, requireConfig,
  requireUnlocked, requireVisitorRateLimit, visitorIp
} from './services'

export function registerShareRoutes(app: Hono<Environment>): void {
app.get('/api/admin/shares', async (c) => {
  const now = Date.now()
  const rows = await c.var.db.prepare(`WITH active_shares AS (
      SELECT id, entry_id, public_label, note, expires_at, revoked_at, created_at,
        (password_hash IS NOT NULL) AS protected
      FROM shares
      WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    ), uv_stats AS (
      SELECT share_id, COUNT(*) AS unique_visitors FROM share_unique_visitors
      WHERE last_seen_at >= ? GROUP BY share_id
    )
    SELECT shares.id, shares.entry_id, shares.public_label, shares.note, shares.expires_at,
      shares.revoked_at, shares.created_at, shares.protected,
      COALESCE(stats.view_count, 0) AS view_count,
      COALESCE(uv_stats.unique_visitors, 0) AS unique_visitors,
      entries.issuer, entries.account
    FROM active_shares AS shares
    JOIN entries ON entries.id = shares.entry_id
    LEFT JOIN share_stats AS stats ON stats.share_id = shares.id
    LEFT JOIN uv_stats ON uv_stats.share_id = shares.id
    ORDER BY shares.created_at DESC`).bind(now, now - 90 * 24 * 60 * 60_000).all()
  return c.json({ shares: rows.results.map((row) => ({
    id: row.id, entryId: row.entry_id, note: row.note, publicLabel: row.public_label, expiresAt: row.expires_at,
    revokedAt: row.revoked_at, createdAt: row.created_at,
    viewCount: Number(row.view_count), uniqueVisitors: Number(row.unique_visitors),
    protected: Boolean(row.protected), issuer: row.issuer, account: row.account
  })) })
})
app.get('/api/admin/share-history', async (c) => {
  const rows = await c.var.db.prepare(`SELECT id, issuer, account, public_label, note,
      expires_at, created_at, ended_at, reason, view_count, unique_visitors
    FROM share_history ORDER BY ended_at DESC LIMIT 100`).all()
  return c.json({ history: rows.results.map((row) => ({
    id: row.id, issuer: row.issuer, account: row.account, publicLabel: row.public_label,
    note: row.note, expiresAt: row.expires_at, createdAt: row.created_at,
    endedAt: row.ended_at, reason: row.reason, viewCount: Number(row.view_count),
    uniqueVisitors: Number(row.unique_visitors)
  })) })
})
app.post('/api/admin/shares', async (c) => {
  requireConfig(c)
  const body = await jsonBody(c)
  if (typeof body.entryId !== 'string') throw new ApiError(400, 'Select a TOTP entry')
  await getEntry(c, body.entryId)
  const note = limitedString(body.note ?? '', 120, 'Note')
  const publicLabel = limitedString(body.publicLabel ?? '', 80, 'Public label')
  const hours = body.expiresInHours
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 0 || hours > 720) {
    throw new ApiError(400, 'Expiration must be permanent or within 30 days')
  }
  const rawPassword = body.password
  if (rawPassword !== undefined && (typeof rawPassword !== 'string' ||
    rawPassword.length < 8 || rawPassword.length > 128)) {
    throw new ApiError(400, 'Share password must be 8-128 characters long')
  }
  const id = newShareId(), now = Date.now()
  const passwordHash = typeof rawPassword === 'string'
    ? await sharePasswordHash(c.env.DATA_ENCRYPTION_KEY, id, rawPassword) : null
  const expiresAt = hours === 0 ? null : now + hours * 3_600_000
  // Legacy columns remain until a later cleanup migration, but new links have no token.
  const unusedTokenHash = await sha256('id-only-share-v2\0' + id)
  await c.var.db.prepare(`INSERT INTO shares
    (id,public_id,public_label,entry_id,token_hash,token_nonce,token_ciphertext,password_hash,note,expires_at,revoked_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)`)
    .bind(id, id, publicLabel, body.entryId, unusedTokenHash, '', '',
      passwordHash, note, expiresAt, now).run()
  return c.json({ id, url: new URL('/s/' + id, c.req.url).toString() }, 201)
})
app.get('/api/admin/shares/:id/link', async (c) => {
  const row = await c.var.db.prepare('SELECT public_id,revoked_at,expires_at FROM shares WHERE id=?')
    .bind(c.req.param('id')).first<Pick<Share, 'public_id' | 'revoked_at' | 'expires_at'>>()
  if (!row || !row.public_id || row.revoked_at !== null ||
      row.expires_at !== null && row.expires_at <= Date.now()) {
    throw new ApiError(404, 'Share not found, expired, or revoked')
  }
  return c.json({ url: new URL('/s/' + row.public_id, c.req.url).toString() })
})
app.delete('/api/admin/shares/:id', async (c) => {
  // Revoke immediately, but retain the row for the next UTC midnight purge.
  // Do not move the original revocation time on repeated requests.
  const id = c.req.param('id')
  const now = Date.now()
  await c.var.db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(now, id).run()
  await archiveShare(c.var.db, id, now)
  return c.json({ ok: true })
})

app.post('/api/share/:id/unlock', async (c) => {
  requireConfig(c)
  await requireVisitorRateLimit(c, 'share')
  const share = await getShare(c)
  if (!share.password_hash) return c.json({ unlocked: true })
  const failuresKey = 'share-password-fail:' + share.id + ':' + await visitorIp(c)
  await assertNotLocked(c, failuresKey, PASSWORD_FAILURE_POLICY)
  const body = await jsonBody(c)
  if (typeof body.password !== 'string' || body.password.length > 128 ||
    !constantTimeEqual(await sharePasswordHash(c.env.DATA_ENCRYPTION_KEY, share.id,
      body.password), share.password_hash)) {
    const until = await recordFailure(c.var.db, failuresKey, PASSWORD_FAILURE_POLICY)
    if (until !== null) throw blocked(until)
    throw new ApiError(401, 'Incorrect share password', 'BAD_SHARE_PASSWORD')
  }
  // Successful unlocks do not reset the failure budget for this visitor/share pair.
  const ticket = await issueUnlock(c.env.DATA_ENCRYPTION_KEY, share.id, Date.now())
  return c.json({ unlockToken: ticket })
})
app.post('/api/share/:id/code', async (c) => {
  requireConfig(c)
  await requireVisitorRateLimit(c, 'share')
  const share = await getShare(c)
  await requireUnlocked(c, share)
  const response = await codeFor(c, await getEntry(c, share.entry_id), false, share.public_label)
  // Each visit counts once; an anonymous browser ID estimates unique visitors.
  // Only successful authorized code views are counted. Never store IPs or user agents.
  const visitId = c.req.header('X-Share-Visit')
  if (visitId && UUID_V4_PATTERN.test(visitId)) {
    const visitorId = c.req.header('X-Share-Visitor')
    // Scope the hash to each share so the database cannot correlate other links.
    // Keep this analytics-only write off the response's critical path.
    const recordVisit = (async () => {
      try {
        const visitorHash = visitorId && UUID_V4_PATTERN.test(visitorId)
          ? await sha256('share-visitor-v1:' + share.id + ':' + visitorId.toLowerCase())
          : null
        await c.var.db.prepare(
          'INSERT OR IGNORE INTO share_visits (share_id, visit_id, visitor_hash, viewed_at) VALUES (?, ?, ?, ?)'
        ).bind(share.id, visitId.toLowerCase(), visitorHash, Date.now()).run()
      } catch {
        // Analytics must never prevent a valid verification code from being displayed.
      }
    })()
    // Worker requests use waitUntil; the app's lightweight test harness may not.
    try { c.executionCtx.waitUntil(recordVisit) }
    catch { await recordVisit }
  }
  return response
})
app.post('/api/share/:id/next', async (c) => {
  requireConfig(c)
  await requireVisitorRateLimit(c, 'share')
  const share = await getShare(c)
  await requireUnlocked(c, share)
  return codeFor(c, await getEntry(c, share.entry_id), true, share.public_label)
})
}
