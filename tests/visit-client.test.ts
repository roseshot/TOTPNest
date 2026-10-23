import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from '../src/client/api'

afterEach(() => vi.unstubAllGlobals())

describe('public share visit headers', () => {
  it('sends the random page-view ID only when provided by the public code panel', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ code: '123456' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }))
    vi.stubGlobal('fetch', fetcher)
    const visitId = '11111111-1111-4111-8111-111111111111'
    const visitorId = '22222222-2222-4222-8222-222222222222'
    await request('/api/share/example/code', { method: 'POST', visitId, visitorId })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const initialHeaders = fetcher.mock.calls[0][1]?.headers as Record<string, string>
    expect(initialHeaders['X-Share-Visit']).toBe(visitId)
    expect(initialHeaders['X-Share-Visitor']).toBe(visitorId)
    await request('/api/share/example/next', { method: 'POST', body: { expectedExpiry: 30_000 } })
    const nextHeaders = fetcher.mock.calls[1][1]?.headers as Record<string, string>
    expect(nextHeaders['X-Share-Visit']).toBeUndefined()
    expect(nextHeaders['X-Share-Visitor']).toBeUndefined()
    await request('/api/admin/entries/example/code', { method: 'POST' })
    const adminHeaders = fetcher.mock.calls[2][1]?.headers as Record<string, string>
    expect(adminHeaders['X-Share-Visitor']).toBeUndefined()
    expect(adminHeaders['X-Share-Visit']).toBeUndefined()
  })
})
