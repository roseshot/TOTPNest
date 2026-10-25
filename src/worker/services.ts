import { getCookie } from 'hono/cookie'
import type { Ctx, Entry, EntryInput, EntrySummary, Share } from './types'
import { ApiError, MIN_PASSWORD_LENGTH, NEXT_THRESHOLD_MS } from './types'
import { JsonBodyError, readJsonObject } from './json'
import { lockedUntil, PASSWORD_FAILURE_POLICY, SHARE_ID_FAILURE_POLICY, recordFailure, type FailurePolicy } from './abuse'
import { isShareId } from './share-id'
import { constantTimeEqual, decrypt, unbase64url, verifyUnlock, keyedHash } from './crypto'
import { normalizeSecret, totpAt, windowAt } from './totp'

export function requireConfig(c: Ctx) {
  let validKey = false
  try { validKey = unbase64url(c.env.DATA_ENCRYPTION_KEY || '').length === 32 }
  catch { /* Invalid encryption key. */ }
  if (!c.env.ADMIN_PASSWORD || c.env.ADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH || !validKey) {
    throw new ApiError(503, 'The service is missing required encryption secrets')
  }
}
export function cookieName(c: Ctx) {
  return new URL(c.req.url).protocol === 'https:' ? '__Host-totpnest' : 'totpnest_local'
}
export async function jsonBody(c: Ctx): Promise<Record<string, unknown>> {
  try { return await readJsonObject(c.req.raw) }
  catch (error) {
    if (error instanceof JsonBodyError) throw new ApiError(error.status, error.message)
    throw error
  }
}
export function limitedString(value: unknown, max: number, field: string) {
  if (typeof value !== 'string' || value.trim().length > max) throw new ApiError(400, field + ' is invalid')
  return value.trim()
}
export function validateEntry(value: Record<string, unknown>, requiresSecret: boolean): EntryInput {
  const issuer = limitedString(value.issuer, 120, 'Issuer')
  const account = limitedString(value.account, 240, 'Account')
  if (!issuer && !account) throw new ApiError(400, 'Issuer or account is required')
  const algorithm = value.algorithm
  const digits = value.digits
  const period = value.period
  if (algorithm !== 'SHA1' && algorithm !== 'SHA256' && algorithm !== 'SHA512') {
    throw new ApiError(400, 'Unsupported hash algorithm')
  }
  if (digits !== 6 && digits !== 8) throw new ApiError(400, 'Code length must be 6 or 8 digits')
  if (typeof period !== 'number' || !Number.isInteger(period) || period < 15 || period > 120) {
    throw new ApiError(400, 'TOTP period must be between 15 and 120 seconds')
  }
  let secret: string | undefined
  if (requiresSecret || value.secret !== undefined && value.secret !== '') {
    if (typeof value.secret !== 'string') throw new ApiError(400, 'TOTP secret is required')
    try { secret = normalizeSecret(value.secret) }
    catch (err) { throw new ApiError(400, err instanceof Error ? err.message : 'Invalid TOTP secret') }
  }
  return { issuer, account, algorithm, digits, period, secret }
}
export function sanitized(row: EntrySummary) {
  return { id: row.id, issuer: row.issuer, account: row.account, algorithm: row.algorithm,
    digits: row.digits, period: row.period, groupId: row.group_id,
    createdAt: row.created_at, updatedAt: row.updated_at }
}

export async function validGroupId(c: Ctx, requested: unknown): Promise<string | null> {
  if (requested === null || requested === undefined) return null
  if (typeof requested !== 'string' || requested.length > 64 || requested.length === 0) {
    throw new ApiError(400, 'Choose an existing group', 'GROUP_INVALID')
  }
  const group = await c.var.db.prepare('SELECT id FROM groups WHERE id = ?')
    .bind(requested).first()
  if (!group) throw new ApiError(400, 'Choose an existing group', 'GROUP_INVALID')
  return requested
}

export function groupName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 50) {
    throw new ApiError(400, 'Group name must be 1 to 50 characters', 'GROUP_NAME')
  }
  return value.trim()
}

export async function assertUniqueGroupName(c: Ctx, name: string, exclude?: string) {
  const existing = await c.var.db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE')
    .bind(name).first<{ id: string }>()
  if (existing && existing.id !== exclude) {
    throw new ApiError(409, 'A group with this name already exists', 'GROUP_EXISTS')
  }
}
export async function getEntry(c: Ctx, id: string): Promise<Entry> {
  const row = await c.var.db.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first<Entry>()
  if (!row) throw new ApiError(404, 'TOTP entry not found')
  return row
}
export async function sessionHash(token: string, adminPassword: string): Promise<string> {
  // Password rotation invalidates all existing sessions automatically.
  return sha256('totpnest-session-v1\0' + adminPassword + '\0' + token)
}
export async function getAdminSession(c: Ctx): Promise<boolean> {
  if (!c.env.ADMIN_PASSWORD) return false
  const token = getCookie(c, cookieName(c))
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false
  const hash = await sessionHash(token, c.env.ADMIN_PASSWORD)
  // Always consult primary for session authorization and immediate sign-out.
  const fresh = c.env.DB.withSession('first-primary')
  const row = await fresh.prepare(
    'SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?'
  ).bind(hash, Date.now()).first()
  return Boolean(row)
}
export async function visitorIp(c: Ctx): Promise<string> {
  return keyedHash(c.env.DATA_ENCRYPTION_KEY, 'visitor-ip-v1',
    c.req.header('CF-Connecting-IP') || 'unknown')
}
export function blocked(until: number): ApiError {
  const wait = Math.max(1, Math.ceil((until - Date.now()) / 1000))
  return new ApiError(429, 'Too many failed attempts. Access is temporarily locked', 'LOCKED', wait)
}
export async function assertNotLocked(c: Ctx, key: string, policy: FailurePolicy) {
  const until = await lockedUntil(c.var.db, key, policy)
  if (until !== null) throw blocked(until)
}
export async function requireVisitorRateLimit(c: Ctx, scope: 'admin' | 'share') {
  // Never use an account-wide hard cap that attackers could exhaust for all users.
  // Scope to the visitor rather than the requested share ID to prevent ID rotation.
  const { success } = await c.env.PUBLIC_CODE_RATE_LIMITER.limit({
    key: scope + '-visitor:' + await visitorIp(c)
  })
  if (!success) throw new ApiError(429, 'Too many requests. Please try again later', 'RATE_LIMIT', 60)
}
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
