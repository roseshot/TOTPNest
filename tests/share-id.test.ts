import { describe, expect, it } from 'vitest'
import { isShareId, newShareId, SHARE_ID_LENGTH } from '../src/worker/share-id'

describe('share link IDs', () => {
  it('uses 22 case-sensitive alphanumeric symbols', () => {
    const ids = Array.from({ length: 300 }, () => newShareId())
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toHaveLength(SHARE_ID_LENGTH)
      expect(id).toMatch(/^[A-Za-z0-9]+$/)
      expect(isShareId(id)).toBe(true)
    }
  })

  it('accepts rotated legacy IDs but refuses predictable or malformed IDs', () => {
    expect(isShareId('0123456789abcdef0123456789abcdef')).toBe(true)
    expect(isShareId('01234567-89ab-cdef-0123-456789abcdef')).toBe(false)
    expect(isShareId('short123')).toBe(false)
    expect(isShareId('A'.repeat(23))).toBe(false)
    expect(isShareId('A'.repeat(21) + '-')).toBe(false)
  })
})

