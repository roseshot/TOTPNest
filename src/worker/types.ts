import type { Context } from 'hono'
import type { DbSession } from './db'
import type { TotpAlgorithm } from './totp'

export type Bindings = {
  DB: D1Database
  ADMIN_PASSWORD: string
  DATA_ENCRYPTION_KEY: string
  PUBLIC_CODE_RATE_LIMITER: RateLimit
}
export type Environment = { Bindings: Bindings; Variables: { db: DbSession } }
export type Ctx = Context<Environment>

export type Entry = {
  id: string
  issuer: string
  account: string
  algorithm: TotpAlgorithm
  digits: 6 | 8
  period: number
  secret_nonce: string
  secret_ciphertext: string
  group_id: string | null
  created_at: number
  updated_at: number
}
export type Share = {
  id: string
  public_id: string
  public_label: string
  entry_id: string
  password_hash: string | null
  note: string
  expires_at: number | null
  revoked_at: number | null
  created_at: number
}
export type EntrySummary = Pick<Entry,
  'id' | 'issuer' | 'account' | 'algorithm' | 'digits' | 'period' | 'group_id' | 'created_at' | 'updated_at'>
export type EntryInput = {
  issuer: string
  account: string
  algorithm: TotpAlgorithm
  digits: 6 | 8
  period: number
  secret?: string
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'ERROR',
    public retryAfterSeconds?: number) {
    super(message)
  }
}

export const MIN_PASSWORD_LENGTH = 16
export const SESSION_MS = 7 * 24 * 60 * 60_000
export const NEXT_THRESHOLD_MS = 5_000
export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
