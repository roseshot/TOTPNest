import { getCookie } from 'hono/cookie'
import type { Ctx } from './types'
import { ApiError } from './types'
import { cookieName } from './core'
import { lockedUntil, type FailurePolicy } from './abuse'
import { keyedHash, sha256 } from './crypto'

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
