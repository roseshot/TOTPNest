import { describe, expect, it } from 'vitest'
import { parseShareId, parseShareInput, routeForPath, sharePathForId } from '../src/client/routes'

const shortId = 'aB7kP2mQ9xR4tY6vN8zW3c'
const migratedId = '0123456789abcdef0123456789abcdef'

describe('public and admin route isolation', () => {
  it('serves the Share ID entry page at the site root', () => {
    expect(routeForPath('/')).toEqual({ kind: 'home' })
  })

  it('only serves the admin area on its explicit route', () => {
    expect(routeForPath('/admin')).toEqual({ kind: 'admin' })
    expect(routeForPath('/admin/')).toEqual({ kind: 'admin' })
    for (const path of ['/dashboard', '/admin/login', '/admin123', '/login', '/unknown']) {
      expect(routeForPath(path)).toEqual({ kind: 'not-found' })
    }
  })

  it('opens public share URLs without exposing the administrator route', () => {
    expect(routeForPath('/s/' + shortId)).toEqual({ kind: 'share', id: shortId })
    expect(routeForPath('/s/' + migratedId + '/')).toEqual({ kind: 'share', id: migratedId })
    for (const path of ['/s/x', '/s/AAAA-AAAAAAAAAAAAAAAAA', '/s/admin', '/s/' + shortId + '/other']) {
      expect(routeForPath(path).kind).not.toBe('admin')
    }
    expect(routeForPath('/s/x')).toEqual({ kind: 'invalid-share' })
  })

  it('validates a pasted ID locally and preserves case', () => {
    expect(parseShareId('  ' + shortId + ' \n')).toBe(shortId)
    expect(sharePathForId(' ' + shortId + ' ')).toBe('/s/' + shortId)
    expect(sharePathForId(migratedId)).toBe('/s/' + migratedId)
    expect(sharePathForId(shortId.toLowerCase())).toBe('/s/' + shortId.toLowerCase())
    for (const invalid of ['', 'admin', '/admin', shortId + '/',
      '../admin', '0'.repeat(33), 'x'.repeat(21)]) {
      expect(sharePathForId(invalid)).toBeNull()
    }
  })

  it('extracts Share IDs from canonical share URLs and paths', () => {
    expect(parseShareInput('https://totpnest.example/s/' + shortId)).toBe(shortId)
    expect(parseShareInput('http://localhost:8787/s/' + migratedId + '/?source=copy#token=old'))
      .toBe(migratedId)
    expect(parseShareInput('totpnest.example/s/' + shortId)).toBe(shortId)
    expect(parseShareInput('/s/' + shortId)).toBe(shortId)
    expect(sharePathForId('https://totpnest.example/s/' + shortId)).toBe('/s/' + shortId)
    expect(parseShareInput('https://example.com/admin/' + shortId)).toBeNull()
    expect(parseShareInput('https://example.com/?share=' + shortId)).toBeNull()
    expect(parseShareInput('javascript:alert(1)//s/' + shortId)).toBeNull()
    expect(parseShareInput('https://example.com/s/' + shortId + '/extra')).toBeNull()
  })
})

