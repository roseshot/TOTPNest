import type { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { clearFailures, recordFailure, PASSWORD_FAILURE_POLICY } from './abuse'
import { constantTimeEqual, randomToken, sha256 } from './crypto'
import type { Environment } from './types'
import { ApiError, SESSION_MS } from './types'
import {
  assertNotLocked, blocked, cookieName, getAdminSession, jsonBody, requireConfig,
  requireVisitorRateLimit, sessionHash, visitorIp
} from './services'

export function registerAuthRoutes(app: Hono<Environment>): void {
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
}
