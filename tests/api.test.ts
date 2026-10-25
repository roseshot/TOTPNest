import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailure, request } from '../src/client/api'

afterEach(() => vi.unstubAllGlobals())

describe('API retry guidance', () => {
  it('parses numeric Retry-After headers into ApiFailure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Too many attempts', code: 'LOCKED' }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '75' } }
    )))
    await expect(request('/api/share/example/unlock', {
      method: 'POST', body: { password: 'wrong' }
    })).rejects.toMatchObject({ status: 429, code: 'LOCKED', retryAfterSeconds: 75 })
  })

  it('parses HTTP-date Retry-After values', async () => {
    const future = new Date(Date.now() + 30_000).toUTCString()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Too many attempts', code: 'LOCKED' }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': future } }
    )))
    try {
      await request('/api/share/example/unlock', { method: 'POST', body: {} })
      throw new Error('Expected request to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiFailure)
      expect((error as ApiFailure).retryAfterSeconds).toBeGreaterThan(0)
    }
  })
})
