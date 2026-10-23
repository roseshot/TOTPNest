import { afterEach, describe, expect, it, vi } from 'vitest'
import { visitorIdForShare } from '../src/client/visitor'

afterEach(() => vi.unstubAllGlobals())

function browserStorage() {
  const records = new Map<string, string>()
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value) }
  }
  vi.stubGlobal('window', { localStorage: storage })
  return records
}

describe('share-specific anonymous browser IDs', () => {
  it('reuses one browser ID across reloads of the same share', async () => {
    const data = browserStorage()
    const url = '/api/share/aB7kP2mQ9xR4tY6vN8zW3c'
    const first = await visitorIdForShare(url)
    const reloaded = await visitorIdForShare(url)
    expect(reloaded).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(data.size).toBe(1)
    expect([...data.keys()][0]).toMatch(/^totpnest:visitor:[a-f0-9]{64}$/)
    expect([...data.keys()][0]).not.toContain('aB7kP2mQ9xR4tY6vN8zW3c')
  })

  it('uses a different identifier for another share link', async () => {
    const data = browserStorage()
    const first = await visitorIdForShare('/api/share/aaaaaaaaaaaaaaaaaaaaaa')
    const second = await visitorIdForShare('/api/share/bbbbbbbbbbbbbbbbbbbbbb')
    expect(first).not.toBe(second)
    expect(data.size).toBe(2)
  })

  it('regenerates a malformed saved identifier without exposing a share ID', async () => {
    const data = browserStorage()
    const path = '/api/share/cccccccccccccccccccccc'
    const first = await visitorIdForShare(path)
    const key = [...data.keys()][0]
    data.set(key, 'not-a-visitor-id')
    const again = await visitorIdForShare(path)
    expect(again).not.toBe(first)
    expect(data.get(key)).toBe(again)
  })

  it('still creates a temporary ID if storage is blocked', async () => {
    vi.stubGlobal('window', {
      get localStorage() { throw new Error('Storage disabled') }
    })
    const id = await visitorIdForShare('/api/share/dddddddddddddddddddddd')
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
  })
})
