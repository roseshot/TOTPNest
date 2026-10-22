import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/worker/index'
import { base64url, encrypt, sharePasswordHash } from '../src/worker/crypto'

const schema = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')
const migrate = readFileSync(new URL('../migrations/0002_share_ids.sql', import.meta.url), 'utf8')
const master = base64url(new Uint8Array(32).fill(7))
const adminPassword = 'test-only-admin-password-123456'
const origin = 'https://totpnest.example'

function database() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(schema)
  const makeSession = () => ({
    prepare(sql) {
      return {
        bind(...values) {
          const stmt = sqlite.prepare(sql)
          return {
            first: async () => stmt.get(...values) || null,
            all: async () => ({ results: stmt.all(...values) }),
            run: async () => stmt.run(...values)
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
  const binding = { withSession: () => makeSession() }
  const env = {
    DB: binding,
    ADMIN_PASSWORD: adminPassword,
    DATA_ENCRYPTION_KEY: master,
    PUBLIC_CODE_RATE_LIMITER: { limit: async () => ({ success: true }) }
  }
  return { sqlite, env }
}

async function seedEntry(sqlite) {
  const entryId = 'entry-one'
  const encrypted = await encrypt('JBSWY3DPEHPK3PXP', master, 'entry:' + entryId + ':v1')
  sqlite.prepare(`INSERT INTO entries
    (id,issuer,account,algorithm,digits,period,secret_nonce,secret_ciphertext,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      entryId, 'Example', 'user@example.com', 'SHA1', 6, 30,
      encrypted.nonce, encrypted.ciphertext, 1, 1
    )
  return entryId
}

async function seedLegacyShare(sqlite, password = null) {
  const entryId = await seedEntry(sqlite)
  const oldId = '11111111-2222-4333-8444-555555555555'
  const verifier = password ? await sharePasswordHash(master, oldId, password) : null
  sqlite.prepare(`INSERT INTO shares
    (id,entry_id,token_hash,token_nonce,token_ciphertext,password_hash,note,expires_at,revoked_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      oldId, entryId, 'legacy-token-hash', 'legacy-nonce', 'legacy-ciphertext', verifier,
      'Existing recipient', null, null, 1
    )
  return oldId
}

async function post(env, route, body = {}, ip = '203.0.113.10', headers = {}) {
  return app.request(origin + route, {
    method: 'POST',
    headers: {
      Origin: origin,
      'CF-Connecting-IP': ip,
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  }, env)
}

afterEach(() => vi.restoreAllMocks())

describe('share migration and brute-force protection', () => {
  it('rotates existing share addresses without losing share metadata or credentials', async () => {
    const { sqlite } = database()
    try {
      const oldId = await seedLegacyShare(sqlite, 'original-password')
      sqlite.exec(migrate)
      const migrated = sqlite.prepare('SELECT * FROM shares WHERE id = ?').get(oldId)
      expect(migrated.public_id).toMatch(/^[0-9a-f]{32}$/)
      expect(migrated.public_id).not.toBe(oldId)
      expect(migrated.note).toBe('Existing recipient')
      expect(migrated.password_hash).toBe(await sharePasswordHash(master, oldId, 'original-password'))
      expect(migrated.token_hash).toBe('legacy-token-hash')
      expect(sqlite.prepare('PRAGMA index_list(shares)').all().some((index) =>
        index.name === 'idx_shares_public_id')).toBe(true)
    } finally { sqlite.close() }
  })

  it('locks one visitor for 30 minutes after five incorrect admin passwords', async () => {
    const { sqlite, env } = database()
    try {
      const now = 1_790_000_000_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      sqlite.exec(migrate)
      for (let i = 0; i < 4; i++) {
        expect((await post(env, '/api/admin/login', { password: 'incorrect' })).status).toBe(401)
      }
      const fifth = await post(env, '/api/admin/login', { password: 'incorrect' })
      expect(fifth.status).toBe(429)
      expect((await fifth.json()).code).toBe('LOCKED')
      expect(fifth.headers.get('Retry-After')).toBe('1800')
      expect((await post(env, '/api/admin/login', { password: adminPassword })).status).toBe(429)
      expect((await post(env, '/api/admin/login', { password: adminPassword }, '203.0.113.11')).status).toBe(200)
      vi.mocked(Date.now).mockReturnValue(now + 30 * 60_000 + 1)
      expect((await post(env, '/api/admin/login', { password: adminPassword })).status).toBe(200)
    } finally { sqlite.close() }
  })

  it('locks unavailable-share scanning for 24 hours, including otherwise valid links', async () => {
    const { sqlite, env } = database()
    try {
      const oldId = await seedLegacyShare(sqlite)
      sqlite.exec(migrate)
      const validId = sqlite.prepare('SELECT public_id FROM shares WHERE id = ?').get(oldId).public_id
      const now = 1_790_000_000_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      for (let i = 0; i < 9; i++) {
        expect((await post(env, '/api/share/' + ('Q'.repeat(20) + String(i).padStart(2, '0')) + '/code')).status).toBe(404)
      }
      const tenth = await post(env, '/api/share/' + ('Q'.repeat(20) + '09') + '/code')
      expect(tenth.status).toBe(429)
      expect((await tenth.json()).code).toBe('LOCKED')
      expect(tenth.headers.get('Retry-After')).toBe('86400')
      expect((await post(env, '/api/share/' + validId + '/code')).status).toBe(429)
      expect((await post(env, '/api/share/' + validId + '/code', {}, '203.0.113.11')).status).toBe(200)
      vi.mocked(Date.now).mockReturnValue(now + 24 * 60 * 60_000 + 1)
      expect((await post(env, '/api/share/' + validId + '/code')).status).toBe(200)
    } finally { sqlite.close() }
  })

  it('enforces five failed share passwords and issues a scoped unlock ticket after expiry', async () => {
    const { sqlite, env } = database()
    try {
      const oldId = await seedLegacyShare(sqlite, 'correct-password')
      sqlite.exec(migrate)
      const validId = sqlite.prepare('SELECT public_id FROM shares WHERE id = ?').get(oldId).public_id
      const now = 1_790_000_000_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      expect((await post(env, '/api/share/' + validId + '/code')).status).toBe(401)
      for (let i = 0; i < 4; i++) {
        expect((await post(env, '/api/share/' + validId + '/unlock', { password: 'wrong' })).status).toBe(401)
      }
      const fifth = await post(env, '/api/share/' + validId + '/unlock', { password: 'wrong' })
      expect(fifth.status).toBe(429)
      expect((await fifth.json()).code).toBe('LOCKED')
      expect((await post(env, '/api/share/' + validId + '/unlock', { password: 'correct-password' })).status).toBe(429)
      vi.mocked(Date.now).mockReturnValue(now + 30 * 60_000 + 1)
      const authorized = await post(env, '/api/share/' + validId + '/unlock', { password: 'correct-password' })
      expect(authorized.status).toBe(200)
      const ticket = (await authorized.json()).unlockToken
      expect((await post(env, '/api/share/' + validId + '/code', {},
        '203.0.113.10', { 'X-Share-Unlock': ticket })).status).toBe(200)
    } finally { sqlite.close() }
  })

  it('creates a short ID-only URL with no bearer-token fragment', async () => {
    const { sqlite, env } = database()
    try {
      await seedEntry(sqlite)
      sqlite.exec(migrate)
      const login = await post(env, '/api/admin/login', { password: adminPassword })
      expect(login.status).toBe(200)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      expect(cookie).toBeTruthy()
      const created = await post(env, '/api/admin/shares', {
        entryId: 'entry-one', note: 'New link', expiresInHours: 24
      }, '203.0.113.10', { Cookie: cookie })
      expect(created.status).toBe(201)
      const data = await created.json()
      expect(data.id).toMatch(/^[A-Za-z0-9]{22}$/)
      expect(data.url).toBe(origin + '/s/' + data.id)
      const record = sqlite.prepare('SELECT public_id,token_nonce,token_ciphertext FROM shares WHERE id = ?').get(data.id)
      expect(record.public_id).toBe(data.id)
      expect(record.token_nonce).toBe('')
      expect(record.token_ciphertext).toBe('')
      expect((await post(env, '/api/share/' + data.id + '/code')).status).toBe(200)
    } finally { sqlite.close() }
  })
})

