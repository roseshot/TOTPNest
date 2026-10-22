/** Unpredictable, URL-safe share identifiers with uniform Base62 characters. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const SHARE_ID_LENGTH = 22

export function newShareId(): string {
  let id = ''
  while (id.length < SHARE_ID_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    for (const byte of bytes) {
      // Reject 248..255 to eliminate modulo bias in a 62-character alphabet.
      if (byte >= 248) continue
      id += ALPHABET[byte % ALPHABET.length]
      if (id.length === SHARE_ID_LENGTH) break
    }
  }
  return id
}

export function isShareId(value: string): boolean {
  // Existing shares receive a new, 128-bit hex identifier during migration.
  return /^[A-Za-z0-9]{22}$/.test(value) || /^[0-9a-f]{32}$/.test(value)
}

