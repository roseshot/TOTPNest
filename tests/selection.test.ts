import { describe, expect, it } from 'vitest'
import { activeEntry, visibleEntries } from '../src/client/selection'
import { entriesInGroup } from '../src/client/groups'

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

describe('group filtering', () => {
  const accounts = [
    { id: 'a', issuer: 'Example', account: 'one@example.com', groupId: 'work' },
    { id: 'b', issuer: 'Example', account: 'two@example.com', groupId: 'personal' },
    { id: 'c', issuer: 'Example', account: 'three@example.com', groupId: null }
  ]

  it('shows every code when all groups are selected', () => {
    expect(entriesInGroup(accounts, 'all')).toEqual(accounts)
  })

  it('filters named groups and the ungrouped list', () => {
    expect(entriesInGroup(accounts, 'work')).toEqual([accounts[0]])
    expect(entriesInGroup(accounts, 'ungrouped')).toEqual([accounts[2]])
    expect(entriesInGroup(accounts, 'missing')).toEqual([])
  })

  it('combines group filtering with search without selecting a hidden code', () => {
    const filtered = visibleEntries(entriesInGroup(accounts, 'personal'), 'TWO@')
    expect(activeEntry(filtered, 'a')).toEqual(accounts[1])
  })
})
