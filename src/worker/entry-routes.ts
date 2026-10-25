import type { Hono } from 'hono'
import { archiveSharesForEntry } from './share-cleanup'
import { encrypt } from './crypto'
import type { Environment, EntrySummary } from './types'
import { ApiError } from './types'
import {
  assertUniqueGroupName, codeFor, getEntry, groupName, jsonBody, requireConfig,
  sanitized, validGroupId, validateEntry
} from './services'

export function registerEntryRoutes(app: Hono<Environment>): void {
app.get('/api/admin/entries', async (c) => {
  const rows = await c.var.db.prepare(`SELECT id, issuer, account, algorithm, digits, period, group_id,
    created_at, updated_at FROM entries ORDER BY issuer COLLATE NOCASE, account COLLATE NOCASE`)
    .all<EntrySummary>()
  return c.json({ entries: rows.results.map(sanitized) })
})

app.get('/api/admin/groups', async (c) => {
  const rows = await c.var.db.prepare(
    'SELECT id, name FROM groups ORDER BY name COLLATE NOCASE'
  ).all<{ id: string; name: string }>()
  return c.json({ groups: rows.results })
})
app.post('/api/admin/groups', async (c) => {
  const name = groupName((await jsonBody(c)).name)
  await assertUniqueGroupName(c, name)
  const id = crypto.randomUUID(), now = Date.now()
  await c.var.db.prepare('INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, now, now).run()
  return c.json({ id, name }, 201)
})
app.put('/api/admin/groups/:id', async (c) => {
  const id = c.req.param('id')
  const exists = await c.var.db.prepare('SELECT id FROM groups WHERE id = ?').bind(id).first()
  if (!exists) throw new ApiError(404, 'Group not found', 'GROUP_MISSING')
  const name = groupName((await jsonBody(c)).name)
  await assertUniqueGroupName(c, name, id)
  await c.var.db.prepare('UPDATE groups SET name = ?, updated_at = ? WHERE id = ?')
    .bind(name, Date.now(), id).run()
  return c.json({ ok: true })
})
app.delete('/api/admin/groups/:id', async (c) => {
  const id = c.req.param('id')
  const exists = await c.var.db.prepare('SELECT id FROM groups WHERE id = ?').bind(id).first()
  if (!exists) throw new ApiError(404, 'Group not found', 'GROUP_MISSING')
  // The foreign key sets member entries to Ungrouped without deleting their secrets or links.
  await c.var.db.prepare('DELETE FROM groups WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})
app.post('/api/admin/entries', async (c) => {
  requireConfig(c)
  const body = await jsonBody(c)
  const data = validateEntry(body, true)
  const groupId = await validGroupId(c, body.groupId)
  const id = crypto.randomUUID(), now = Date.now()
  const box = await encrypt(data.secret!, c.env.DATA_ENCRYPTION_KEY, 'entry:' + id + ':v1')
  await c.var.db.prepare(`INSERT INTO entries
    (id,issuer,account,algorithm,digits,period,secret_nonce,secret_ciphertext,group_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, data.issuer, data.account, data.algorithm, data.digits, data.period,
      box.nonce, box.ciphertext, groupId, now, now).run()
  return c.json({ id }, 201)
})
app.put('/api/admin/entries/:id', async (c) => {
  requireConfig(c)
  const id = c.req.param('id'), previous = await getEntry(c, id)
  const body = await jsonBody(c)
  const data = validateEntry(body, false)
  // Older clients may omit groupId. Keep the existing group rather than clearing it.
  const groupId = body.groupId === undefined ? previous.group_id : await validGroupId(c, body.groupId)
  const box = data.secret ? await encrypt(data.secret, c.env.DATA_ENCRYPTION_KEY, 'entry:' + id + ':v1')
    : { nonce: previous.secret_nonce, ciphertext: previous.secret_ciphertext }
  await c.var.db.prepare(`UPDATE entries SET issuer=?, account=?, algorithm=?, digits=?, period=?,
    secret_nonce=?, secret_ciphertext=?, group_id=?, updated_at=? WHERE id=?`)
    .bind(data.issuer, data.account, data.algorithm, data.digits, data.period,
      box.nonce, box.ciphertext, groupId, Date.now(), id).run()
  return c.json({ ok: true })
})
app.put('/api/admin/entries/:id/group', async (c) => {
  const id = c.req.param('id')
  await getEntry(c, id)
  const groupId = await validGroupId(c, (await jsonBody(c)).groupId)
  await c.var.db.prepare('UPDATE entries SET group_id = ?, updated_at = ? WHERE id = ?')
    .bind(groupId, Date.now(), id).run()
  return c.json({ ok: true })
})
app.delete('/api/admin/entries/:id', async (c) => {
  const id = c.req.param('id')
  await archiveSharesForEntry(c.var.db, id, Date.now())
  await c.var.db.prepare('DELETE FROM entries WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})
app.post('/api/admin/entries/:id/code', async (c) => {
  requireConfig(c)
  return codeFor(c, await getEntry(c, c.req.param('id')))
})
app.post('/api/admin/entries/:id/next', async (c) => {
  requireConfig(c)
  return codeFor(c, await getEntry(c, c.req.param('id')), true)
})
}
