import { describe, expect, it } from 'vitest'
import { decodeBase32, totpAt, windowAt } from '../src/worker/totp'

const b32 = (text: string) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bytes = new TextEncoder().encode(text)
  let bits = 0, buffer = 0, output = ''
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += chars[(buffer >> bits) & 31]
      buffer &= (1 << bits) - 1
    }
  }
  if (bits) output += chars[(buffer << (5 - bits)) & 31]
  return output
}

describe('RFC 6238', () => {
  for (const [algorithm, secret, expected] of [
    ['SHA1', '12345678901234567890', '94287082'],
    ['SHA256', '12345678901234567890123456789012', '46119246'],
    ['SHA512', '1234567890123456789012345678901234567890123456789012345678901234', '90693936']
  ] as const) {
    it(algorithm, async () => {
      expect(await totpAt(b32(secret), { algorithm, digits: 8, period: 30 }, 59_000)).toBe(expected)
    })
  }
  it('produces six-digit codes and correct boundaries', async () => {
    const secret = b32('12345678901234567890')
    expect(await totpAt(secret, { algorithm: 'SHA1', digits: 6, period: 30 }, 59_000)).toBe('287082')
    expect(windowAt(30, 59_000)).toEqual({ counter: 1, validFrom: 30_000, expiresAt: 60_000 })
  })
  it('rejects invalid or short secrets', () => {
    expect(() => decodeBase32('INVALID0')).toThrow()
    expect(() => decodeBase32('JBSWY')).toThrow()
  })
})
