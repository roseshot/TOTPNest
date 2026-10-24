/** AES-256-GCM for secrets and opaque share tokens; keys never enter D1 or assets. */
const encoder = new TextEncoder()
const utf8 = (value: string) => encoder.encode(value)

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding')
  const string = atob(value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4))
  return Uint8Array.from(string, c => c.charCodeAt(0))
}

export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function sha256(input: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(input))))
}

export function constantTimeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length)
  let difference = a.length ^ b.length
  for (let index = 0; index < max; index++) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0)
  }
  return difference === 0
}

const aesKeyCache = new Map<string, Promise<CryptoKey>>()
const signingKeyCache = new Map<string, Promise<CryptoKey>>()
const MAX_CACHED_KEYS = 8

function cachedKey(
  cache: Map<string, Promise<CryptoKey>>, cacheKey: string,
  create: () => Promise<CryptoKey>
): Promise<CryptoKey> {
  const existing = cache.get(cacheKey)
  if (existing) {
    cache.delete(cacheKey)
    cache.set(cacheKey, existing)
    return existing
  }
  const pending = create()
  cache.set(cacheKey, pending)
  if (cache.size > MAX_CACHED_KEYS) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  void pending.catch(() => {
    if (cache.get(cacheKey) === pending) cache.delete(cacheKey)
  })
  return pending
}

async function aesKey(encodedKey: string): Promise<CryptoKey> {
  return cachedKey(aesKeyCache, encodedKey, async () => {
    const raw = unbase64url(encodedKey)
    if (raw.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be a 32-byte base64url value')
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  })
}

async function signKey(encodedKey: string, purpose: string): Promise<CryptoKey> {
  return cachedKey(signingKeyCache, purpose + ':' + encodedKey, async () => {
    const raw = unbase64url(encodedKey)
    if (raw.length !== 32) throw new Error('Invalid encryption key')
    const hkdfKey = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: utf8('totpnest-v1'), info: utf8(purpose) },
      hkdfKey, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']
    )
  })
}

export async function encrypt(value: string, key: string, context: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce, additionalData: utf8(context), tagLength: 128
  }, await aesKey(key), utf8(value))
  return { nonce: base64url(nonce), ciphertext: base64url(new Uint8Array(ciphertext)) }
}

export async function decrypt(nonce: string, ciphertext: string, key: string, context: string): Promise<string> {
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: unbase64url(nonce),
    additionalData: utf8(context), tagLength: 128
  }, await aesKey(key), unbase64url(ciphertext))
  return new TextDecoder().decode(plaintext)
}

/** Keyed password verifier: share ID is a unique salt, KDF key lives outside D1. */
export async function sharePasswordHash(master: string, shareId: string, password: string): Promise<string> {
  const key = await signKey(master, 'share-password-v1')
  return base64url(new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, utf8(shareId + '\0' + password)
  )))
}

/** A 15-minute signed unlock ticket scoped to one secret Share ID. */
export async function issueUnlock(master: string, shareId: string, now: number): Promise<string> {
  const exp = now + 15 * 60_000
  const key = await signKey(master, 'share-unlock-v2')
  const signature = await crypto.subtle.sign('HMAC', key, utf8(shareId + '|' + exp))
  return exp + '.' + base64url(new Uint8Array(signature))
}

export async function verifyUnlock(
  master: string, shareId: string, ticket: string, now: number
): Promise<boolean> {
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(ticket)
  if (!match) return false
  const exp = Number(match[1])
  if (exp <= now || exp > now + 15 * 60_000) return false
  const key = await signKey(master, 'share-unlock-v2')
  return crypto.subtle.verify(
    'HMAC', key, unbase64url(match[2]), utf8(shareId + '|' + exp)
  )

}
