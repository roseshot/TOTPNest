import type { Ctx, Entry, EntryInput, EntrySummary } from './types'
import { ApiError } from './types'
import { normalizeSecret } from './totp'

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
