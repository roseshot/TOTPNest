import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { app } from '../src/worker/index'
import { base64url, encrypt, sharePasswordHash } from '../src/worker/crypto'

const schema = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')
const migrate = readFileSync(new URL('../migrations/0002_share_ids.sql', import.meta.url), 'utf8')
const cleanupMigration = readFileSync(new URL('../migrations/0003_share_cleanup.sql', import.meta.url), 'utf8')
const groupMigration = readFileSync(new URL('../migrations/0004_groups_and_views.sql', import.meta.url), 'utf8')
const visitorMigration = readFileSync(new URL('../migrations/0005_share_unique_visitors.sql', import.meta.url), 'utf8')
const analyticsMigration = readFileSync(new URL('../migrations/0006_share_analytics_and_history.sql', import.meta.url), 'utf8')
const lastSeenMigration = readFileSync(new URL('../migrations/0007_share_unique_visitor_last_seen.sql', import.meta.url), 'utf8')
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
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
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
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
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
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
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
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
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

  it('cannot reset share-password guessing by unlocking a known share', async () => {
    const { sqlite, env } = database()
    try {
      const oldId = await seedLegacyShare(sqlite, 'known-password')
      sqlite.exec(migrate)
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
      const validId = sqlite.prepare('SELECT public_id FROM shares WHERE id = ?').get(oldId).public_id
      vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000)
      for (let i = 0; i < 2; i++) {
        expect((await post(env, '/api/share/' + validId + '/unlock', { password: 'wrong' })).status).toBe(401)
      }
      expect((await post(env, '/api/share/' + validId + '/unlock', { password: 'known-password' })).status).toBe(200)
      for (let i = 0; i < 2; i++) {
        expect((await post(env, '/api/share/' + validId + '/unlock', { password: 'wrong' })).status).toBe(401)
      }
      expect((await post(env, '/api/share/' + validId + '/unlock', { password: 'wrong' })).status).toBe(429)
    } finally { sqlite.close() }
  })

  it('revokes a share immediately but retains its D1 row until UTC midnight', async () => {
    const { sqlite, env } = database()
    try {
      const id = await seedLegacyShare(sqlite)
      sqlite.exec(migrate)
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
      sqlite.exec(cleanupMigration)
      const publicId = sqlite.prepare('SELECT public_id FROM shares WHERE id = ?').get(id).public_id
      const midnight = Date.parse('2026-10-24T00:00:00Z')
      const revokedAt = midnight - 30_000
      vi.spyOn(Date, 'now').mockReturnValue(revokedAt)
      const login = await post(env, '/api/admin/login', { password: adminPassword })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      expect(cookie).toBeTruthy()

      const revoked = await app.request(origin + '/api/admin/shares/' + id, {
        method: 'DELETE', headers: { Origin: origin, Cookie: cookie }
      }, env)
      expect(revoked.status).toBe(200)
      expect(sqlite.prepare('SELECT revoked_at FROM shares WHERE id = ?').get(id))
        .toMatchObject({ revoked_at: revokedAt })
      expect(sqlite.prepare('SELECT id FROM entries WHERE id = ?').get('entry-one')).toBeDefined()
      expect((await post(env, '/api/share/' + publicId + '/code')).status).toBe(404)
      const adminList = await app.request(origin + '/api/admin/shares', {
        headers: { Cookie: cookie }
      }, env)
      expect(adminList.status).toBe(200)
      expect((await adminList.json()).shares).toEqual([])

      // Repeating the request must not shift the purge eligibility.
      vi.mocked(Date.now).mockReturnValue(revokedAt + 10_000)
      expect((await app.request(origin + '/api/admin/shares/' + id, {
        method: 'DELETE', headers: { Origin: origin, Cookie: cookie }
      }, env)).status).toBe(200)
      expect(sqlite.prepare('SELECT revoked_at FROM shares WHERE id = ?').get(id))
        .toMatchObject({ revoked_at: revokedAt })

      await worker.scheduled({ cron: '0 0 * * *', scheduledTime: midnight }, env, {})
      expect(sqlite.prepare('SELECT id FROM shares WHERE id = ?').get(id)).toBeUndefined()
      expect(sqlite.prepare('SELECT reason FROM share_history WHERE id = ?').get(id)).toMatchObject({ reason: 'revoked' })
      expect(sqlite.prepare('SELECT id FROM entries WHERE id = ?').get('entry-one')).toBeDefined()
    } finally { sqlite.close() }
  })

  it('removes previously revoked and expired shares during migration', async () => {
    for (const status of ['revoked', 'expired', 'active']) {
      const { sqlite } = database()
      try {
        const id = await seedLegacyShare(sqlite)
        sqlite.exec(migrate)
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
        if (status === 'revoked') {
          sqlite.prepare('UPDATE shares SET revoked_at = ? WHERE id = ?').run(123, id)
        } else if (status === 'expired') {
          sqlite.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(1, id)
        }
        sqlite.exec(cleanupMigration)
        const row = sqlite.prepare('SELECT id FROM shares WHERE id = ?').get(id)
        expect(Boolean(row)).toBe(status === 'active')
        expect(sqlite.prepare('SELECT id FROM entries WHERE id = ?').get('entry-one')).toBeDefined()
        expect(sqlite.prepare('PRAGMA index_list(shares)').all().some((index) =>
          index.name === 'idx_shares_expires_at')).toBe(true)
      } finally { sqlite.close() }
    }
  })

  it('denies expired shares immediately and purges them at UTC midnight', async () => {
    const { sqlite, env } = database()
    try {
      const oldId = await seedLegacyShare(sqlite)
      sqlite.exec(migrate)
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
      sqlite.exec(cleanupMigration)
      const publicId = sqlite.prepare('SELECT public_id FROM shares WHERE id = ?').get(oldId).public_id
      const midnight = Date.parse('2026-10-24T00:00:00Z')
      const now = midnight - 30_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      sqlite.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(now - 1, oldId)

      const login = await post(env, '/api/admin/login', { password: adminPassword })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      const active = await post(env, '/api/admin/shares',
        { entryId: 'entry-one', note: 'Active', expiresInHours: 24 },
        '203.0.113.10', { Cookie: cookie })
      const permanent = await post(env, '/api/admin/shares',
        { entryId: 'entry-one', note: 'Permanent', expiresInHours: 0 },
        '203.0.113.10', { Cookie: cookie })
      expect(active.status).toBe(201)
      expect(permanent.status).toBe(201)
      const activeId = (await active.json()).id
      const permanentId = (await permanent.json()).id

      expect((await post(env, '/api/share/' + publicId + '/code')).status).toBe(404)
      // The expired row is not exposed in the admin list even before cleanup.
      const adminList = await app.request(origin + '/api/admin/shares', {
        headers: { Cookie: cookie }
      }, env)
      expect((await adminList.json()).shares.map((share) => share.id).sort()).toEqual(
        [activeId, permanentId].sort()
      )
      expect(sqlite.prepare('SELECT id FROM shares WHERE id = ?').get(oldId)).toBeDefined()

      await worker.scheduled({ cron: '0 0 * * *', scheduledTime: midnight }, env, {})
      expect(sqlite.prepare('SELECT id FROM shares WHERE id = ?').get(oldId)).toBeUndefined()
      expect(sqlite.prepare('SELECT id FROM shares WHERE id = ?').get(activeId)).toBeDefined()
      expect(sqlite.prepare('SELECT id FROM shares WHERE id = ?').get(permanentId)).toBeDefined()
      expect(sqlite.prepare('SELECT id FROM entries WHERE id = ?').get('entry-one')).toBeDefined()
    } finally { sqlite.close() }
  })

  it('does not purge shares that became inactive after a delayed midnight trigger', async () => {
    const { sqlite, env } = database()
    try {
      const id = await seedLegacyShare(sqlite)
      sqlite.exec(migrate)
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
      sqlite.exec(cleanupMigration)
      const midnight = Date.parse('2026-10-24T00:00:00Z')
      const justAfterMidnight = midnight + 5_000
      vi.spyOn(Date, 'now').mockReturnValue(justAfterMidnight)
      const login = await post(env, '/api/admin/login', { password: adminPassword })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      expect((await app.request(origin + '/api/admin/shares/' + id, {
        method: 'DELETE', headers: { Origin: origin, Cookie: cookie }
      }, env)).status).toBe(200)

      // A delayed run for the prior midnight cannot remove the new revocation.
      await worker.scheduled({ cron: '0 0 * * *', scheduledTime: midnight }, env, {})
      expect(sqlite.prepare('SELECT revoked_at FROM shares WHERE id = ?').get(id))
        .toMatchObject({ revoked_at: justAfterMidnight })
      // The following day's cleanup removes the retained record.
      await worker.scheduled({ cron: '0 0 * * *', scheduledTime: midnight + 86_400_000 }, env, {})
      expect(sqlite.prepare('SELECT id FROM shares WHERE id = ?').get(id)).toBeUndefined()
    } finally { sqlite.close() }
  })

  it('keeps a newly expired share until the next UTC midnight cutoff', async () => {
    const { sqlite, env } = database()
    try {
      const id = await seedLegacyShare(sqlite)
      sqlite.exec(migrate)
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
      sqlite.exec(cleanupMigration)
      const midnight = Date.parse('2026-10-24T00:00:00Z')
      const expiredAt = midnight + 2_000
      sqlite.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(expiredAt, id)
      vi.spyOn(Date, 'now').mockReturnValue(midnight + 20_000)
      const publicId = sqlite.prepare('SELECT public_id FROM shares WHERE id = ?').get(id).public_id
      expect((await post(env, '/api/share/' + publicId + '/code')).status).toBe(404)

      await worker.scheduled({ cron: '0 0 * * *', scheduledTime: midnight }, env, {})
      expect(sqlite.prepare('SELECT id FROM shares WHERE id = ?').get(id)).toBeDefined()
      await worker.scheduled({ cron: '0 0 * * *', scheduledTime: midnight + 86_400_000 }, env, {})
      expect(sqlite.prepare('SELECT id FROM shares WHERE id = ?').get(id)).toBeUndefined()
    } finally { sqlite.close() }
  })

  it('keeps password lockouts isolated to one share for the same visitor', async () => {
    const { sqlite, env } = database()
    try {
      await seedEntry(sqlite)
      sqlite.exec(migrate)
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
      const login = await post(env, '/api/admin/login', { password: adminPassword })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      const create = async (note) => {
        const response = await post(env, '/api/admin/shares', {
          entryId: 'entry-one', note, expiresInHours: 24, password: 'correct-password'
        }, '203.0.113.10', { Cookie: cookie })
        expect(response.status).toBe(201)
        return (await response.json()).id
      }
      const firstId = await create('First')
      const secondId = await create('Second')
      vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000)
      for (let i = 0; i < 4; i++) {
        expect((await post(env, '/api/share/' + firstId + '/unlock', { password: 'wrong' })).status).toBe(401)
      }
      expect((await post(env, '/api/share/' + firstId + '/unlock', { password: 'wrong' })).status).toBe(429)
      const second = await post(env, '/api/share/' + secondId + '/unlock', { password: 'correct-password' })
      expect(second.status).toBe(200)
    } finally { sqlite.close() }
  })

  it('archives share metadata when the underlying TOTP entry is deleted', async () => {
    const { sqlite, env } = database()
    try {
      await seedEntry(sqlite)
      sqlite.exec(migrate)
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
      const login = await post(env, '/api/admin/login', { password: adminPassword })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      const created = await post(env, '/api/admin/shares', {
        entryId: 'entry-one', note: 'Private note', publicLabel: 'Build bot', expiresInHours: 24
      }, '203.0.113.10', { Cookie: cookie })
      const id = (await created.json()).id
      const deleted = await app.request(origin + '/api/admin/entries/entry-one', {
        method: 'DELETE', headers: { Origin: origin, Cookie: cookie }
      }, env)
      expect(deleted.status).toBe(200)
      const history = sqlite.prepare('SELECT * FROM share_history WHERE id = ?').get(id)
      expect(history).toMatchObject({ reason: 'entry_deleted', public_label: 'Build bot', note: 'Private note' })
      expect(history).not.toHaveProperty('public_id')
      expect(sqlite.prepare('SELECT id FROM shares WHERE id = ?').get(id)).toBeUndefined()
    } finally { sqlite.close() }
  })

  it('cleans stale sessions, lockout rows, view receipts and unique-browser records', async () => {
    const { sqlite, env } = database()
    try {
      const id = await seedLegacyShare(sqlite)
      sqlite.exec(migrate)
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
      const cutoff = Date.parse('2026-10-24T00:00:00Z')
      sqlite.prepare('INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)')
        .run('expired-session', cutoff - 1, cutoff - 1000)
      sqlite.prepare('INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)')
        .run('live-session', cutoff + 1000, cutoff - 1000)
      sqlite.prepare('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)')
        .run('expired-lock', 5, cutoff - 1)
      sqlite.prepare('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)')
        .run('live-lock', 1, cutoff + 1000)
      const staleVisit = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const freshVisit = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const oldVisitor = 'old-browser-hash'
      const newVisitor = 'new-browser-hash'
      sqlite.prepare('INSERT INTO share_visits (share_id, visit_id, visitor_hash, viewed_at) VALUES (?, ?, ?, ?)')
        .run(id, staleVisit, oldVisitor, cutoff - 120 * 24 * 60 * 60_000)
      sqlite.prepare('INSERT INTO share_visits (share_id, visit_id, visitor_hash, viewed_at) VALUES (?, ?, ?, ?)')
        .run(id, freshVisit, newVisitor, cutoff - 10 * 24 * 60 * 60_000)
      await (await import('../src/worker/share-cleanup')).cleanupExpiredShares(env.DB, cutoff)
      expect(sqlite.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get('expired-session')).toBeUndefined()
      expect(sqlite.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get('live-session')).toBeDefined()
      expect(sqlite.prepare('SELECT key FROM rate_limits WHERE key = ?').get('expired-lock')).toBeUndefined()
      expect(sqlite.prepare('SELECT key FROM rate_limits WHERE key = ?').get('live-lock')).toBeDefined()
      expect(sqlite.prepare('SELECT visit_id FROM share_visits WHERE visit_id = ?').get(staleVisit)).toBeUndefined()
      expect(sqlite.prepare('SELECT visit_id FROM share_visits WHERE visit_id = ?').get(freshVisit)).toBeDefined()
      expect(sqlite.prepare('SELECT visitor_hash FROM share_unique_visitors WHERE visitor_hash = ?').get(oldVisitor)).toBeUndefined()
      expect(sqlite.prepare('SELECT visitor_hash FROM share_unique_visitors WHERE visitor_hash = ?').get(newVisitor)).toBeDefined()
      expect(sqlite.prepare('SELECT view_count FROM share_stats WHERE share_id = ?').get(id).view_count).toBe(2)
    } finally { sqlite.close() }
  })

  it('exposes liveness separately from database/config readiness', async () => {
    const { env } = database()
    expect((await app.request(origin + '/api/health/live', {}, env)).status).toBe(200)
    expect((await app.request(origin + '/api/health/ready', {}, env)).status).toBe(200)
    const broken = { ...env, DATA_ENCRYPTION_KEY: 'invalid' }
    const response = await app.request(origin + '/api/health/ready', {}, broken)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false })
  })

  it('creates a short ID-only URL with no bearer-token fragment', async () => {
    const { sqlite, env } = database()
    try {
      await seedEntry(sqlite)
      sqlite.exec(migrate)
      sqlite.exec(groupMigration)
      sqlite.exec(visitorMigration)
      sqlite.exec(analyticsMigration)
      sqlite.exec(lastSeenMigration)
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

