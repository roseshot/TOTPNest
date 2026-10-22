import { describe, expect, it } from 'vitest'
import { activeEntry, visibleEntries } from '../src/client/selection'

const entries = [
  { id: '1', issuer: 'GitHub', account: 'alice@example.com' },
  { id: '2', issuer: 'Cloudflare', account: 'bob@example.com' }
]

describe('dashboard search and selection', () => {
  it('searches service and account names without case or surrounding whitespace', () => {
    expect(visibleEntries(entries, ' github ')).toEqual([entries[0]])
    expect(visibleEntries(entries, 'BOB@')).toEqual([entries[1]])
  })

  it('never displays a code hidden by the current search', () => {
    const results = visibleEntries(entries, 'cloudflare')
    expect(activeEntry(results, '1')).toEqual(entries[1])
    expect(activeEntry(results, '2')).toEqual(entries[1])
  })

  it('has a true empty state when nothing matches', () => {
    expect(activeEntry(visibleEntries(entries, 'missing'), '1')).toBeUndefined()
    expect(activeEntry([], null)).toBeUndefined()
  })
})
