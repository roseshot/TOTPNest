/** RFC 4226 / RFC 6238 TOTP; secret and code calculation stay on the Worker. */
export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'
export type TotpConfig = { algorithm: TotpAlgorithm; digits: 6 | 8; period: number }

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function decodeBase32(value: string): Uint8Array<ArrayBuffer> {
  const clean = value.trim().toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  if (!clean || !/^[A-Z2-7]+$/.test(clean) || clean.length % 8 === 1) {
    throw new Error('TOTP secret must use valid Base32 encoding')
  }
  const result: number[] = []
  let bits = 0
  let buffer = 0
  for (const char of clean) {
    buffer = (buffer << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      result.push((buffer >> bits) & 0xff)
      buffer &= (1 << bits) - 1
    }
  }
  if (bits !== 0 && buffer !== 0) throw new Error('Invalid Base32 padding bits')
  if (result.length < 10 || result.length > 128) throw new Error('Secret must be between 10 and 128 bytes')
  return new Uint8Array(result)
}

export function normalizeSecret(value: string): string {
  const normalized = value.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  decodeBase32(normalized)
  return normalized
}

export function windowAt(period: number, atMs: number) {
  const span = period * 1000
  const counter = Math.floor(atMs / span)
  return { counter, validFrom: counter * span, expiresAt: (counter + 1) * span }
}

export async function totpAt(secret: string, config: TotpConfig, atMs = Date.now()): Promise<string> {
  const bytes = decodeBase32(secret)
  const hash = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }[config.algorithm]
  if (!hash || ![6, 8].includes(config.digits) || !Number.isInteger(config.period) ||
      config.period < 15 || config.period > 120) throw new Error('Invalid TOTP configuration')
  const counter = BigInt(windowAt(config.period, atMs).counter)
  const data = new ArrayBuffer(8)
  new DataView(data).setBigUint64(0, counter)
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
  const offset = mac[mac.length - 1] & 15
  const number = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) | mac[offset + 3]
  return (number % (10 ** config.digits)).toString().padStart(config.digits, '0')
}
