import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/worker/index'
import { base64url } from '../src/worker/crypto'

const migrations = ['0001_init.sql', '0002_share_ids.sql', '0003_share_cleanup.sql', '0004_groups_and_views.sql']
const origin = 'https://totpnest.example'
const adminPassword = 'test-only-admin-password-123456'
const masterKey = base64url(new Uint8Array(32).fill(7))
const setupKey = 'JBSWY3DPEHPK3PXP'
const visitOne = '11111111-1111-4111-8111-111111111111'
const visitTwo = '22222222-2222-4222-8222-222222222222'

function database() {
  const sqlite = new DatabaseSync(':memory:')
  for (const name of migrations) {
    sqlite.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'))
  }
  const makeSession = () => ({
    prepare(sql) {
      return {
        bind(...values) {
          const query = sqlite.prepare(sql)
          return {
            first: async () => query.get(...values) || null,
            all: async () => ({ results: query.all(...values) }),
            run: async () => query.run(...values)
          }
        }
      }
    },
    batch: async (statements) => {
      for (const statement of statements) await statement.run()
      return []
    },
    getBookmark: () => null
  })
  const env = {
    DB: { withSession: () => makeSession() },
    ADMIN_PASSWORD: adminPassword,
    DATA_ENCRYPTION_KEY: masterKey,
    PUBLIC_CODE_RATE_LIMITER: { limit: async () => ({ success: true }) }
  }
  return { sqlite, env }
}

async function post(env, path, body = {}, cookie = '', otherHeaders = {}) {
  return app.request(origin + path, {
    method: 'POST', headers: {
      Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...otherHeaders
    },
    body: JSON.stringify(body)
  }, env)
}
async function admin(env) {
  const response = await post(env, '/api/admin/login', { password: adminPassword })
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie').split(';')[0]
}
async function adminRequest(env, path, cookie, method = 'GET', body = undefined) {
  return app.request(origin + path, {
    method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }, env)
}
const newCode = (groupId = null) => ({
  issuer: 'GitHub', account: 'example@example.com', algorithm: 'SHA1',
  digits: 6, period: 30, secret: setupKey, groupId
})

afterEach(() => vi.restoreAllMocks())

describe('groups and successful shared-code views', () => {
  it('keeps existing codes ungrouped during the additive migration', () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      for (const name of migrations.slice(0, 3)) {
        sqlite.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'))
      }
      sqlite.prepare(`INSERT INTO entries
        (id, issuer, account, algorithm, digits, period, secret_nonce, secret_ciphertext, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('legacy-code', 'Example', 'one@example.com', 'SHA1', 6, 30, 'nonce', 'cipher', 1, 1)
      sqlite.exec(readFileSync(new URL('../migrations/0004_groups_and_views.sql', import.meta.url), 'utf8'))
      expect(sqlite.prepare('SELECT group_id FROM entries WHERE id = ?').get('legacy-code')).toEqual({ group_id: null })
    } finally { sqlite.close() }
  })

  it('creates, renames, filters and deletes groups without deleting codes or their links', async () => {
    const { sqlite, env } = database()
    try {
      const cookie = await admin(env)
      expect((await app.request(origin + '/api/admin/groups', {}, env)).status).toBe(401)
      const created = await adminRequest(env, '/api/admin/groups', cookie, 'POST', { name: 'Work' })
      expect(created.status).toBe(201)
      const group = await created.json()
      const duplicate = await adminRequest(env, '/api/admin/groups', cookie, 'POST', { name: 'work' })
      expect(duplicate.status).toBe(409)
      expect((await duplicate.json()).code).toBe('GROUP_EXISTS')
      expect((await adminRequest(env, '/api/admin/groups', cookie, 'POST', { name: '   ' })).status).toBe(400)
      expect((await adminRequest(env, '/api/admin/groups', cookie, 'POST', { name: 'x'.repeat(51) })).status).toBe(400)
      expect((await adminRequest(env, '/api/admin/entries', cookie, 'POST', newCode('not-a-group'))).status).toBe(400)
      const added = await adminRequest(env, '/api/admin/entries', cookie, 'POST', newCode(group.id))
      expect(added.status).toBe(201)
      const id = (await added.json()).id
      const entryList = await adminRequest(env, '/api/admin/entries', cookie)
      expect((await entryList.json()).entries[0].groupId).toBe(group.id)

      const shareResponse = await adminRequest(env, '/api/admin/shares', cookie, 'POST', {
        entryId: id, note: '', expiresInHours: 24
      })
      expect(shareResponse.status).toBe(201)
      const share = await shareResponse.json()
      const rename = await adminRequest(env, '/api/admin/groups/' + group.id, cookie, 'PUT', { name: 'Team' })
      expect(rename.status).toBe(200)
      const groups = await adminRequest(env, '/api/admin/groups', cookie)
      expect((await groups.json()).groups).toEqual([{ id: group.id, name: 'Team' }])

      const removed = await adminRequest(env, '/api/admin/groups/' + group.id, cookie, 'DELETE')
      expect(removed.status).toBe(200)
      expect(sqlite.prepare('SELECT group_id FROM entries WHERE id=?').get(id).group_id).toBeNull()
      expect(sqlite.prepare('SELECT id FROM shares WHERE id=?').get(share.id).id).toBe(share.id)
      expect((await adminRequest(env, '/api/admin/entries', cookie).then(r => r.json())).entries[0].groupId).toBeNull()
    } finally { sqlite.close() }
  })

  it('moves existing codes without changing the secret or the group on invalid input', async () => {
    const { sqlite, env } = database()
    try {
      const cookie = await admin(env)
      const g1 = await (await adminRequest(env, '/api/admin/groups', cookie, 'POST', { name: 'Personal' })).json()
      const g2 = await (await adminRequest(env, '/api/admin/groups', cookie, 'POST', { name: 'Work' })).json()
      const created = await (await adminRequest(env, '/api/admin/entries', cookie, 'POST', newCode(g1.id))).json()
      const original = sqlite.prepare('SELECT secret_ciphertext, secret_nonce FROM entries WHERE id=?').get(created.id)
      expect((await adminRequest(env, '/api/admin/entries/' + created.id + '/group', cookie, 'PUT', {
        groupId: 'invalid'
      })).status).toBe(400)
      expect(sqlite.prepare('SELECT group_id FROM entries WHERE id=?').get(created.id).group_id).toBe(g1.id)
      expect((await adminRequest(env, '/api/admin/entries/' + created.id + '/group', cookie, 'PUT', {
        groupId: g2.id
      })).status).toBe(200)
      const moved = sqlite.prepare('SELECT group_id, secret_ciphertext, secret_nonce FROM entries WHERE id=?').get(created.id)
      expect(moved.group_id).toBe(g2.id)
      expect({ secret_ciphertext: moved.secret_ciphertext, secret_nonce: moved.secret_nonce }).toEqual(original)
      expect((await adminRequest(env, '/api/admin/entries/' + created.id + '/group', cookie, 'PUT', {
        groupId: null
      })).status).toBe(200)
      expect(sqlite.prepare('SELECT group_id FROM entries WHERE id=?').get(created.id).group_id).toBeNull()
    } finally { sqlite.close() }
  })

  it('counts one successful code view per page visit, not per automatic refresh or retry', async () => {
    const { sqlite, env } = database()
    try {
      const cookie = await admin(env)
      const entryId = (await (await adminRequest(env, '/api/admin/entries', cookie, 'POST', newCode())).json()).id
      const share = await (await adminRequest(env, '/api/admin/shares', cookie, 'POST', {
        entryId, note: '', expiresInHours: 0
      })).json()
      const id = share.id
      const endpoint = '/api/share/' + id + '/code'
      const first = await post(env, endpoint, {}, '', { 'X-Share-Visit': visitOne })
      expect(first.status).toBe(200)
      expect(JSON.stringify(await first.json())).not.toMatch(/visitCount|viewCount|account|issuer/)
      expect((await post(env, endpoint, {}, '', { 'X-Share-Visit': visitOne })).status).toBe(200)
      expect((await post(env, endpoint)).status).toBe(200)
      expect((await post(env, endpoint, {}, '', { 'X-Share-Visit': visitTwo })).status).toBe(200)
      const listed = await adminRequest(env, '/api/admin/shares', cookie)
      expect((await listed.json()).shares[0].viewCount).toBe(2)
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM share_visits WHERE share_id=?').get(id).n).toBe(2)

      // A revoked link never increments its views, and the receipts follow the share on cleanup.
      expect((await adminRequest(env, '/api/admin/shares/' + id, cookie, 'DELETE')).status).toBe(200)
      expect((await post(env, endpoint, {}, '', { 'X-Share-Visit': crypto.randomUUID() })).status).toBe(404)
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM share_visits').get().n).toBe(2)
    } finally { sqlite.close() }
  })

  it('does not count password prompts, failed passwords or unavailable links', async () => {
    const { env } = database()
    const cookie = await admin(env)
    const entryId = (await (await adminRequest(env, '/api/admin/entries', cookie, 'POST', newCode())).json()).id
    const share = await (await adminRequest(env, '/api/admin/shares', cookie, 'POST', {
      entryId, note: '', expiresInHours: 24, password: 'very-strong-share-password'
    })).json()
    const endpoint = '/api/share/' + share.id
    expect((await post(env, endpoint + '/code', {}, '', { 'X-Share-Visit': visitOne })).status).toBe(401)
    expect((await post(env, endpoint + '/unlock', { password: 'wrong' })).status).toBe(401)
    let list = await adminRequest(env, '/api/admin/shares', cookie)
    expect((await list.json()).shares[0].viewCount).toBe(0)
    const unlocked = await post(env, endpoint + '/unlock', { password: 'very-strong-share-password' })
    expect(unlocked.status).toBe(200)
    const ticket = (await unlocked.json()).unlockToken
    expect((await post(env, endpoint + '/code', {}, '', {
      'X-Share-Visit': visitOne, 'X-Share-Unlock': ticket
    })).status).toBe(200)
    list = await adminRequest(env, '/api/admin/shares', cookie)
    expect((await list.json()).shares[0].viewCount).toBe(1)
  })
})
