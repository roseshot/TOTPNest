import type { Ctx, Entry, Share } from './types'
import { ApiError, NEXT_THRESHOLD_MS } from './types'
import { SHARE_ID_FAILURE_POLICY, PASSWORD_FAILURE_POLICY, recordFailure } from './abuse'
import { decrypt, verifyUnlock } from './crypto'
import { isShareId } from './share-id'
import { totpAt, windowAt } from './totp'
import { jsonBody } from './core'
import { assertNotLocked, blocked, visitorIp } from './auth-service'

export async function getShare(c: Ctx): Promise<Share> {
  const failuresKey = 'share-id-miss:' + await visitorIp(c)
  await assertNotLocked(c, failuresKey, SHARE_ID_FAILURE_POLICY)
  const id = c.req.param('id') || ''
  const row = isShareId(id)
    ? await c.var.db.prepare('SELECT * FROM shares WHERE public_id = ?').bind(id).first<Share>()
    : null
  const now = Date.now()
  if (!row || row.revoked_at !== null || row.expires_at !== null && row.expires_at <= now) {
    const until = await recordFailure(c.var.db, failuresKey, SHARE_ID_FAILURE_POLICY, now)
    if (until !== null) throw blocked(until)
    throw new ApiError(404, 'Share link is unavailable', 'SHARE_UNAVAILABLE')
  }
  return row
}

export async function requireUnlocked(c: Ctx, share: Share) {
  if (!share.password_hash) return
  await assertNotLocked(c, 'share-password-fail:' + share.id + ':' + await visitorIp(c), PASSWORD_FAILURE_POLICY)
  const ticket = c.req.header('X-Share-Unlock') || ''
  if (!await verifyUnlock(c.env.DATA_ENCRYPTION_KEY, share.id, ticket, Date.now())) {
    throw new ApiError(401, 'Share password required', 'PASSWORD_REQUIRED')
  }
}

export async function codeFor(c: Ctx, entry: Entry, next = false, publicLabel = '') {
  const now = Date.now()
  const w = windowAt(entry.period, now)
  let requestedWindow = w
  let kind: 'current' | 'next' = 'current'
  if (next) {
    const remaining = w.expiresAt - now
    const payload = await jsonBody(c)
    const expectedExpiry = payload.expectedExpiry
    if (typeof expectedExpiry !== 'number' || !Number.isInteger(expectedExpiry)) {
      throw new ApiError(400, 'Current code expiration time is required')
    }
    if (expectedExpiry <= now && expectedExpiry >= w.validFrom - entry.period * 1000) {
      requestedWindow = w // Request arrived just after rollover; return current, never arbitrary future.
    } else if (expectedExpiry === w.expiresAt && remaining <= NEXT_THRESHOLD_MS) {
      requestedWindow = { counter: w.counter + 1, validFrom: w.expiresAt, expiresAt: w.expiresAt + entry.period * 1000 }
      kind = 'next'
    } else {
      throw new ApiError(425, 'Next code is not available yet', 'TOO_EARLY')
    }
  }
  const secret = await decrypt(entry.secret_nonce, entry.secret_ciphertext, c.env.DATA_ENCRYPTION_KEY, 'entry:' + entry.id + ':v1')
  const code = await totpAt(secret, entry, requestedWindow.validFrom)
  // No issuer, account, secret, entryId or sharing metadata in visitor responses.
  return c.json({ code, serverNow: Date.now(), validFrom: requestedWindow.validFrom,
    expiresAt: requestedWindow.expiresAt, ...(next ? { kind } : {}), ...(publicLabel ? { label: publicLabel } : {}) })
}
