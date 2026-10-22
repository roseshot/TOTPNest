import { describe, expect, it } from 'vitest'
import { base64url, constantTimeEqual, decrypt, encrypt, issueUnlock, sharePasswordHash, verifyUnlock } from '../src/worker/crypto'

describe('encrypted secrets and sharing', () => {
  const master = base64url(new Uint8Array(32).fill(7))
  it('encrypts and authenticates the associated record ID', async () => {
    const box = await encrypt('JBSWY3DPEHPK3PXP', master, 'entry:one:v1')
    expect(await decrypt(box.nonce, box.ciphertext, master, 'entry:one:v1')).toBe('JBSWY3DPEHPK3PXP')
    await expect(decrypt(box.nonce, box.ciphertext, master, 'entry:other:v1')).rejects.toThrow()
  })
  it('signs short-lived tickets bound to a specific link', async () => {
    const now = 1_780_000_000_000
    const token = await issueUnlock(master, 'share-one', now)
    expect(await verifyUnlock(master, 'share-one', token, now)).toBe(true)
    expect(await verifyUnlock(master, 'share-two', token, now)).toBe(false)
    expect(await verifyUnlock(master, 'share-one', token, now + 900_001)).toBe(false)
  })
  it('stores distinct keyed password digests per share', async () => {
    expect(await sharePasswordHash(master, 'one', 'password')).not.toBe(
      await sharePasswordHash(master, 'two', 'password')
    )
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
  })
})
