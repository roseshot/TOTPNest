import type { Ctx } from './types'
import { ApiError, MIN_PASSWORD_LENGTH } from './types'
import { JsonBodyError, readJsonObject } from './json'
import { unbase64url } from './crypto'

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
