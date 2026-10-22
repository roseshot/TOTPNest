import { describe, expect, it } from 'vitest'
import { JsonBodyError, readJsonObject } from '../src/worker/json'

const post = (body: string, headers: HeadersInit = {}) =>
  new Request('https://example.com/api/test', { method: 'POST', body, headers })

describe('bounded JSON request parsing', () => {
  it('accepts a JSON object', async () => {
    expect(await readJsonObject(post('{"name":"example"}'))).toEqual({ name: 'example' })
  })

  it('enforces byte limits for multibyte text', async () => {
    await expect(readJsonObject(post('{"value":"😀"}'), 10))
      .rejects.toMatchObject({ status: 413 })
  })

  it('rejects an oversized Content-Length before reading the body', async () => {
    await expect(readJsonObject(post('{}', { 'Content-Length': '9000' })))
      .rejects.toBeInstanceOf(JsonBodyError)
    await expect(readJsonObject(post('{}', { 'Content-Length': '9000' })))
      .rejects.toMatchObject({ status: 413 })
  })

  it('rejects invalid JSON and non-object payloads', async () => {
    await expect(readJsonObject(post('{'))).rejects.toMatchObject({ status: 400 })
    await expect(readJsonObject(post('[]'))).rejects.toMatchObject({ status: 400 })
    await expect(readJsonObject(post('null'))).rejects.toMatchObject({ status: 400 })
  })
})

