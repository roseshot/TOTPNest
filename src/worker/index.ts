import { Hono } from 'hono'
import { archiveShare, archiveSharesForEntry, cleanupExpiredShares } from './share-cleanup'
import { BOOKMARK_HEADER, openSession, type DbSession } from './db'
import { JsonBodyError, readJsonObject } from './json'
import { clearFailures, lockedUntil, recordFailure, PASSWORD_FAILURE_POLICY, SHARE_ID_FAILURE_POLICY, type FailurePolicy } from './abuse'
import { isShareId, newShareId } from './share-id'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { constantTimeEqual, decrypt, encrypt, issueUnlock, keyedHash, randomToken, sha256, sharePasswordHash, unbase64url, verifyUnlock } from './crypto'
import { normalizeSecret, totpAt, windowAt, type TotpAlgorithm } from './totp'

type Bindings = { DB: D1Database; ADMIN_PASSWORD: string; DATA_ENCRYPTION_KEY: string; PUBLIC_CODE_RATE_LIMITER: RateLimit }
type Environment = { Bindings: Bindings; Variables: { db: DbSession } }
type Ctx = Context<Environment>
type Entry = {
  id: string; issuer: string; account: string; algorithm: TotpAlgorithm; digits: 6 | 8; period: number;
  secret_nonce: string; secret_ciphertext: string; group_id: string | null;
  created_at: number; updated_at: number
}
type Share = {
  id: string; public_id: string; public_label: string; entry_id: string;
  password_hash: string | null; note: string; expires_at: number | null;
  revoked_at: number | null; created_at: number
}
type EntrySummary = Pick<Entry, 'id' | 'issuer' | 'account' | 'algorithm' | 'digits' | 'period' | 'group_id' | 'created_at' | 'updated_at'>
type EntryInput = { issuer: string; account: string; algorithm: TotpAlgorithm; digits: 6 | 8; period: number; secret?: string }

class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'ERROR',
    public retryAfterSeconds?: number) { super(message) }
}
const app = new Hono<Environment>()
const MIN_PASSWORD_LENGTH = 16
const SESSION_MS = 7 * 24 * 60 * 60_000
const NEXT_THRESHOLD_MS = 5_000
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requireConfig(c: Ctx) {
  let validKey = false
  try { validKey = unbase64url(c.env.DATA_ENCRYPTION_KEY || '').length === 32 }
  catch { /* Invalid encryption key. */ }
  if (!c.env.ADMIN_PASSWORD || c.env.ADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH || !validKey) {
    throw new ApiError(503, 'The service is missing required encryption secrets')
  }
}
function cookieName(c: Ctx) {
  return new URL(c.req.url).protocol === 'https:' ? '__Host-totpnest' : 'totpnest_local'
}
async function jsonBody(c: Ctx): Promise<Record<string, unknown>> {
  try { return await readJsonObject(c.req.raw) }
  catch (error) {
    if (error instanceof JsonBodyError) throw new ApiError(error.status, error.message)
    throw error
  }
}
function limitedString(value: unknown, max: number, field: string) {
  if (typeof value !== 'string' || value.trim().length > max) throw new ApiError(400, field + ' is invalid')
  return value.trim()
}
function validateEntry(value: Record<string, unknown>, requiresSecret: boolean): EntryInput {
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
function sanitized(row: EntrySummary) {
  return { id: row.id, issuer: row.issuer, account: row.account, algorithm: row.algorithm,
    digits: row.digits, period: row.period, groupId: row.group_id,
    createdAt: row.created_at, updatedAt: row.updated_at }
}

async function validGroupId(c: Ctx, requested: unknown): Promise<string | null> {
  if (requested === null || requested === undefined) return null
  if (typeof requested !== 'string' || requested.length > 64 || requested.length === 0) {
    throw new ApiError(400, 'Choose an existing group', 'GROUP_INVALID')
  }
  const group = await c.var.db.prepare('SELECT id FROM groups WHERE id = ?')
    .bind(requested).first()
  if (!group) throw new ApiError(400, 'Choose an existing group', 'GROUP_INVALID')
  return requested
}

function groupName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 50) {
    throw new ApiError(400, 'Group name must be 1 to 50 characters', 'GROUP_NAME')
  }
  return value.trim()
}

async function assertUniqueGroupName(c: Ctx, name: string, exclude?: string) {
  const existing = await c.var.db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE')
    .bind(name).first<{ id: string }>()
  if (existing && existing.id !== exclude) {
    throw new ApiError(409, 'A group with this name already exists', 'GROUP_EXISTS')
  }
}
async function getEntry(c: Ctx, id: string): Promise<Entry> {
  const row = await c.var.db.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first<Entry>()
  if (!row) throw new ApiError(404, 'TOTP entry not found')
  return row
}
async function sessionHash(token: string, adminPassword: string): Promise<string> {
  // Password rotation invalidates all existing sessions automatically.
  return sha256('totpnest-session-v1\0' + adminPassword + '\0' + token)
}
async function getAdminSession(c: Ctx): Promise<boolean> {
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
async function visitorIp(c: Ctx): Promise<string> {
  return keyedHash(c.env.DATA_ENCRYPTION_KEY, 'visitor-ip-v1',
    c.req.header('CF-Connecting-IP') || 'unknown')
}
function blocked(until: number): ApiError {
  const wait = Math.max(1, Math.ceil((until - Date.now()) / 1000))
  return new ApiError(429, 'Too many failed attempts. Access is temporarily locked', 'LOCKED', wait)
}
async function assertNotLocked(c: Ctx, key: string, policy: FailurePolicy) {
  const until = await lockedUntil(c.var.db, key, policy)
  if (until !== null) throw blocked(until)
}
async function requireVisitorRateLimit(c: Ctx, scope: 'admin' | 'share') {
  // Never use an account-wide hard cap that attackers could exhaust for all users.
  // Scope to the visitor rather than the requested share ID to prevent ID rotation.
  const { success } = await c.env.PUBLIC_CODE_RATE_LIMITER.limit({
    key: scope + '-visitor:' + await visitorIp(c)
  })
  if (!success) throw new ApiError(429, 'Too many requests. Please try again later', 'RATE_LIMIT', 60)
}
async function getShare(c: Ctx): Promise<Share> {
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
async function requireUnlocked(c: Ctx, share: Share) {
  if (!share.password_hash) return
  await assertNotLocked(c, 'share-password-fail:' + share.id + ':' + await visitorIp(c), PASSWORD_FAILURE_POLICY)
  const ticket = c.req.header('X-Share-Unlock') || ''
  if (!await verifyUnlock(c.env.DATA_ENCRYPTION_KEY, share.id, ticket, Date.now())) {
    throw new ApiError(401, 'Share password required', 'PASSWORD_REQUIRED')
  }
}
async function codeFor(c: Ctx, entry: Entry, next = false, publicLabel = '') {
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

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store, private')
  c.header('Pragma', 'no-cache')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex')
  const session = openSession(c.env.DB, new URL(c.req.url).pathname,
    c.req.method, c.req.header(BOOKMARK_HEADER) ?? null)
  c.set('db', session)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (c.req.header('Origin') !== new URL(c.req.url).origin) {
      return c.json({ error: 'Untrusted request origin' }, 403)
    }
  }
  await next()
  const bookmark = session.getBookmark()
  if (bookmark) c.header(BOOKMARK_HEADER, bookmark)
})
app.use('/api/admin/*', async (c, next) => {
  const pathname = new URL(c.req.url).pathname
  if (pathname === '/api/admin/login' || pathname === '/api/admin/session') return next()
  if (!await getAdminSession(c)) return c.json({ error: 'Admin sign in required', code: 'UNAUTHORIZED' }, 401)
  return next()
})

app.get('/api/health', (c) => c.json({ ok: true }))
app.get('/api/health/live', (c) => c.json({ ok: true }))
app.get('/api/health/ready', async (c) => {
  try {
    requireConfig(c)
    await c.env.DB.withSession('first-primary').prepare('SELECT 1 AS ready').first()
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 503)
  }
})

app.get('/api/admin/session', async (c) => c.json({ authenticated: await getAdminSession(c) }))
app.post('/api/admin/login', async (c) => {
  requireConfig(c)
  await requireVisitorRateLimit(c, 'admin')
  const ip = await visitorIp(c)
  const failuresKey = 'admin-password-fail:' + ip
  await assertNotLocked(c, failuresKey, PASSWORD_FAILURE_POLICY)
  const body = await jsonBody(c)
  const password = body.password
  if (typeof password !== 'string' || password.length > 1024 ||
      !constantTimeEqual(await sha256(password), await sha256(c.env.ADMIN_PASSWORD))) {
    const until = await recordFailure(c.var.db, failuresKey, PASSWORD_FAILURE_POLICY)
    if (until !== null) throw blocked(until)
    throw new ApiError(401, 'Incorrect admin password', 'LOGIN_FAILED')
  }
  await clearFailures(c.var.db, failuresKey)
  const now = Date.now()
  const token = randomToken()
  await c.var.db.batch([
    c.var.db.prepare('INSERT INTO sessions (token_hash,expires_at,created_at) VALUES (?,?,?)')
      .bind(await sessionHash(token, c.env.ADMIN_PASSWORD), now + SESSION_MS, now),
    c.var.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now)
  ])
  setCookie(c, cookieName(c), token, {
    httpOnly: true, secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict', path: '/', maxAge: SESSION_MS / 1000
  })
  return c.json({ authenticated: true })
})
app.post('/api/admin/logout', async (c) => {
  const token = getCookie(c, cookieName(c))
  if (token) await c.var.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sessionHash(token, c.env.ADMIN_PASSWORD)).run()
  deleteCookie(c, cookieName(c), { path: '/' })
  return c.json({ ok: true })
})

app.get('/api/admin/entries', async (c) => {
  const rows = await c.var.db.prepare(`SELECT id, issuer, account, algorithm, digits, period, group_id,
    created_at, updated_at FROM entries ORDER BY issuer COLLATE NOCASE, account COLLATE NOCASE`)
    .all<EntrySummary>()
  return c.json({ entries: rows.results.map(sanitized) })
})

app.get('/api/admin/groups', async (c) => {
  const rows = await c.var.db.prepare(
    'SELECT id, name FROM groups ORDER BY name COLLATE NOCASE'
  ).all<{ id: string; name: string }>()
  return c.json({ groups: rows.results })
})
app.post('/api/admin/groups', async (c) => {
  const name = groupName((await jsonBody(c)).name)
  await assertUniqueGroupName(c, name)
  const id = crypto.randomUUID(), now = Date.now()
  await c.var.db.prepare('INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, now, now).run()
  return c.json({ id, name }, 201)
})
app.put('/api/admin/groups/:id', async (c) => {
  const id = c.req.param('id')
  const exists = await c.var.db.prepare('SELECT id FROM groups WHERE id = ?').bind(id).first()
  if (!exists) throw new ApiError(404, 'Group not found', 'GROUP_MISSING')
  const name = groupName((await jsonBody(c)).name)
  await assertUniqueGroupName(c, name, id)
  await c.var.db.prepare('UPDATE groups SET name = ?, updated_at = ? WHERE id = ?')
    .bind(name, Date.now(), id).run()
  return c.json({ ok: true })
})
app.delete('/api/admin/groups/:id', async (c) => {
  const id = c.req.param('id')
  const exists = await c.var.db.prepare('SELECT id FROM groups WHERE id = ?').bind(id).first()
  if (!exists) throw new ApiError(404, 'Group not found', 'GROUP_MISSING')
  // The foreign key sets member entries to Ungrouped without deleting their secrets or links.
  await c.var.db.prepare('DELETE FROM groups WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})
app.post('/api/admin/entries', async (c) => {
  requireConfig(c)
  const body = await jsonBody(c)
  const data = validateEntry(body, true)
  const groupId = await validGroupId(c, body.groupId)
  const id = crypto.randomUUID(), now = Date.now()
  const box = await encrypt(data.secret!, c.env.DATA_ENCRYPTION_KEY, 'entry:' + id + ':v1')
  await c.var.db.prepare(`INSERT INTO entries
    (id,issuer,account,algorithm,digits,period,secret_nonce,secret_ciphertext,group_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, data.issuer, data.account, data.algorithm, data.digits, data.period,
      box.nonce, box.ciphertext, groupId, now, now).run()
  return c.json({ id }, 201)
})
app.put('/api/admin/entries/:id', async (c) => {
  requireConfig(c)
  const id = c.req.param('id'), previous = await getEntry(c, id)
  const body = await jsonBody(c)
  const data = validateEntry(body, false)
  // Older clients may omit groupId. Keep the existing group rather than clearing it.
  const groupId = body.groupId === undefined ? previous.group_id : await validGroupId(c, body.groupId)
  const box = data.secret ? await encrypt(data.secret, c.env.DATA_ENCRYPTION_KEY, 'entry:' + id + ':v1')
    : { nonce: previous.secret_nonce, ciphertext: previous.secret_ciphertext }
  await c.var.db.prepare(`UPDATE entries SET issuer=?, account=?, algorithm=?, digits=?, period=?,
    secret_nonce=?, secret_ciphertext=?, group_id=?, updated_at=? WHERE id=?`)
    .bind(data.issuer, data.account, data.algorithm, data.digits, data.period,
      box.nonce, box.ciphertext, groupId, Date.now(), id).run()
  return c.json({ ok: true })
})
app.put('/api/admin/entries/:id/group', async (c) => {
  const id = c.req.param('id')
  await getEntry(c, id)
  const groupId = await validGroupId(c, (await jsonBody(c)).groupId)
  await c.var.db.prepare('UPDATE entries SET group_id = ?, updated_at = ? WHERE id = ?')
    .bind(groupId, Date.now(), id).run()
  return c.json({ ok: true })
})
app.delete('/api/admin/entries/:id', async (c) => {
  const id = c.req.param('id')
  await archiveSharesForEntry(c.var.db, id, Date.now())
  await c.var.db.prepare('DELETE FROM entries WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})
app.post('/api/admin/entries/:id/code', async (c) => {
  requireConfig(c)
  return codeFor(c, await getEntry(c, c.req.param('id')))
})
app.post('/api/admin/entries/:id/next', async (c) => {
  requireConfig(c)
  return codeFor(c, await getEntry(c, c.req.param('id')), true)
})

app.get('/api/admin/shares', async (c) => {
  const now = Date.now()
  const rows = await c.var.db.prepare(`WITH active_shares AS (
      SELECT id, entry_id, public_label, note, expires_at, revoked_at, created_at,
        (password_hash IS NOT NULL) AS protected
      FROM shares
      WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    ), uv_stats AS (
      SELECT share_id, COUNT(*) AS unique_visitors FROM share_unique_visitors
      WHERE first_seen_at >= ? GROUP BY share_id
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

app.onError((error, c) => {
  const status = error instanceof ApiError ? error.status : 500
  const message = error instanceof ApiError ? error.message : 'Service temporarily unavailable'
  const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR'
  return new Response(JSON.stringify({ error: message, code }), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private', 'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
      ...(error instanceof ApiError && error.retryAfterSeconds
        ? { 'Retry-After': String(error.retryAfterSeconds) } : {}) }
  })
})
app.notFound((c) => c.json({ error: 'Endpoint not found' }, 404))

export { app }

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx)
  },
  async scheduled(event: ScheduledController, env: Bindings) {
    // A delayed midnight run must not remove links revoked or expired
    // after the midnight for which the job was scheduled.
    await cleanupExpiredShares(env.DB, event.scheduledTime)
  }
} satisfies ExportedHandler<Bindings>
