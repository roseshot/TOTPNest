import { Hono } from 'hono'
import { cleanupExpiredShares } from './share-cleanup'
import { BOOKMARK_HEADER, openSession, type DbSession } from './db'
import { JsonBodyError, readJsonObject } from './json'
import { clearFailures, lockedUntil, recordFailure, PASSWORD_FAILURE_POLICY, SHARE_ID_FAILURE_POLICY, type FailurePolicy } from './abuse'
import { isShareId, newShareId } from './share-id'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { constantTimeEqual, decrypt, encrypt, issueUnlock, randomToken, sha256, sharePasswordHash, unbase64url, verifyUnlock } from './crypto'
import { normalizeSecret, totpAt, windowAt, type TotpAlgorithm } from './totp'

type Bindings = { DB: D1Database; ADMIN_PASSWORD: string; DATA_ENCRYPTION_KEY: string; PUBLIC_CODE_RATE_LIMITER: RateLimit }
type Environment = { Bindings: Bindings; Variables: { db: DbSession } }
type Ctx = Context<Environment>
type Entry = {
  id: string; issuer: string; account: string; algorithm: TotpAlgorithm; digits: 6 | 8; period: number;
  secret_nonce: string; secret_ciphertext: string; created_at: number; updated_at: number
}
type Share = {
  id: string; public_id: string; entry_id: string;
  password_hash: string | null; note: string; expires_at: number | null;
  revoked_at: number | null; created_at: number
}
type EntrySummary = Pick<Entry, 'id' | 'issuer' | 'account' | 'algorithm' | 'digits' | 'period' | 'created_at' | 'updated_at'>
type EntryInput = { issuer: string; account: string; algorithm: TotpAlgorithm; digits: 6 | 8; period: number; secret?: string }

class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'ERROR',
    public retryAfterSeconds?: number) { super(message) }
}
const app = new Hono<Environment>()
const MIN_PASSWORD_LENGTH = 16
const SESSION_MS = 7 * 24 * 60 * 60_000
const NEXT_THRESHOLD_MS = 5_000

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
    digits: row.digits, period: row.period, createdAt: row.created_at, updatedAt: row.updated_at }
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
  return sha256(c.req.header('CF-Connecting-IP') || 'unknown')
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
  await assertNotLocked(c, 'share-password-fail:' + await visitorIp(c), PASSWORD_FAILURE_POLICY)
  const ticket = c.req.header('X-Share-Unlock') || ''
  if (!await verifyUnlock(c.env.DATA_ENCRYPTION_KEY, share.id, ticket, Date.now())) {
    throw new ApiError(401, 'Share password required', 'PASSWORD_REQUIRED')
  }
}
async function codeFor(c: Ctx, entry: Entry, next = false) {
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
    expiresAt: requestedWindow.expiresAt, ...(next ? { kind } : {}) })
}

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store, private')
  c.header('Pragma', 'no-cache')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Robots-Tag', 'noindex, nofollow')
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
  const rows = await c.var.db.prepare(`SELECT id, issuer, account, algorithm, digits, period, created_at, updated_at
    FROM entries ORDER BY issuer COLLATE NOCASE, account COLLATE NOCASE`)
    .all<EntrySummary>()
  return c.json({ entries: rows.results.map(sanitized) })
})
app.post('/api/admin/entries', async (c) => {
  requireConfig(c)
  const data = validateEntry(await jsonBody(c), true)
  const id = crypto.randomUUID(), now = Date.now()
  const box = await encrypt(data.secret!, c.env.DATA_ENCRYPTION_KEY, 'entry:' + id + ':v1')
  await c.var.db.prepare(`INSERT INTO entries
    (id,issuer,account,algorithm,digits,period,secret_nonce,secret_ciphertext,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, data.issuer, data.account, data.algorithm, data.digits, data.period,
      box.nonce, box.ciphertext, now, now).run()
  return c.json({ id }, 201)
})
app.put('/api/admin/entries/:id', async (c) => {
  requireConfig(c)
  const id = c.req.param('id'), previous = await getEntry(c, id)
  const data = validateEntry(await jsonBody(c), false)
  const box = data.secret ? await encrypt(data.secret, c.env.DATA_ENCRYPTION_KEY, 'entry:' + id + ':v1')
    : { nonce: previous.secret_nonce, ciphertext: previous.secret_ciphertext }
  await c.var.db.prepare(`UPDATE entries SET issuer=?, account=?, algorithm=?, digits=?, period=?,
    secret_nonce=?, secret_ciphertext=?, updated_at=? WHERE id=?`)
    .bind(data.issuer, data.account, data.algorithm, data.digits, data.period,
      box.nonce, box.ciphertext, Date.now(), id).run()
  return c.json({ ok: true })
})
app.delete('/api/admin/entries/:id', async (c) => {
  await c.var.db.prepare('DELETE FROM entries WHERE id=?').bind(c.req.param('id')).run()
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
  const rows = await c.var.db.prepare(`SELECT shares.id, shares.entry_id, shares.note,
    shares.expires_at, shares.revoked_at, shares.created_at,
    (shares.password_hash IS NOT NULL) AS protected,
    entries.issuer, entries.account
    FROM shares JOIN entries ON entries.id = shares.entry_id
    WHERE shares.revoked_at IS NULL AND (shares.expires_at IS NULL OR shares.expires_at > ?)
    ORDER BY shares.created_at DESC`).bind(Date.now()).all()
  return c.json({ shares: rows.results.map((row) => ({
    id: row.id, entryId: row.entry_id, note: row.note, expiresAt: row.expires_at,
    revokedAt: row.revoked_at, createdAt: row.created_at,
    protected: Boolean(row.protected), issuer: row.issuer, account: row.account
  })) })
})
app.post('/api/admin/shares', async (c) => {
  requireConfig(c)
  const body = await jsonBody(c)
  if (typeof body.entryId !== 'string') throw new ApiError(400, 'Select a TOTP entry')
  await getEntry(c, body.entryId)
  const note = limitedString(body.note ?? '', 120, 'Note')
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
    (id,public_id,entry_id,token_hash,token_nonce,token_ciphertext,password_hash,note,expires_at,revoked_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`)
    .bind(id, id, body.entryId, unusedTokenHash, '', '',
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
  // Removing the row immediately revokes the capability on primary-first reads.
  await c.var.db.prepare('DELETE FROM shares WHERE id = ?')
    .bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

app.post('/api/share/:id/unlock', async (c) => {
  requireConfig(c)
  await requireVisitorRateLimit(c, 'share')
  const share = await getShare(c)
  if (!share.password_hash) return c.json({ unlocked: true })
  const failuresKey = 'share-password-fail:' + await visitorIp(c)
  await assertNotLocked(c, failuresKey, PASSWORD_FAILURE_POLICY)
  const body = await jsonBody(c)
  if (typeof body.password !== 'string' || body.password.length > 128 ||
    !constantTimeEqual(await sharePasswordHash(c.env.DATA_ENCRYPTION_KEY, share.id,
      body.password), share.password_hash)) {
    const until = await recordFailure(c.var.db, failuresKey, PASSWORD_FAILURE_POLICY)
    if (until !== null) throw blocked(until)
    throw new ApiError(401, 'Incorrect share password', 'BAD_SHARE_PASSWORD')
  }
  // Success does not clear IP-wide share-password failures: otherwise a known
  // password for one share could reset the guessing budget for other shares.
  const ticket = await issueUnlock(c.env.DATA_ENCRYPTION_KEY, share.id, Date.now())
  return c.json({ unlockToken: ticket })
})
app.post('/api/share/:id/code', async (c) => {
  requireConfig(c)
  await requireVisitorRateLimit(c, 'share')
  const share = await getShare(c)
  await requireUnlocked(c, share)
  return codeFor(c, await getEntry(c, share.entry_id))
})
app.post('/api/share/:id/next', async (c) => {
  requireConfig(c)
  await requireVisitorRateLimit(c, 'share')
  const share = await getShare(c)
  await requireUnlocked(c, share)
  return codeFor(c, await getEntry(c, share.entry_id), true)
})

app.onError((error, c) => {
  const status = error instanceof ApiError ? error.status : 500
  const message = error instanceof ApiError ? error.message : 'Service temporarily unavailable'
  const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR'
  return new Response(JSON.stringify({ error: message, code }), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private', 'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
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
  async scheduled(_event: ScheduledController, env: Bindings) {
    await cleanupExpiredShares(env.DB, Date.now())
  }
} satisfies ExportedHandler<Bindings>
