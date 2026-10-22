import { describe, expect, it } from 'vitest'
import { shouldAdvanceBookmark } from '../src/client/api'

describe('D1 bookmark progression', () => {
  it('preserves a newer bookmark over an overlapping stale read', () => {
    expect(shouldAdvanceBookmark('GET', 'older', 'newer')).toBe(false)
    expect(shouldAdvanceBookmark('GET', 'older', 'older')).toBe(true)
  })
  it('accepts the bookmark of a completed mutation', () => {
    expect(shouldAdvanceBookmark('POST', 'older', 'newer')).toBe(true)
    expect(shouldAdvanceBookmark('DELETE', null, 'newer')).toBe(true)
  })
})
