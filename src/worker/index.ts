import { Hono } from 'hono'
import type { Bindings, Environment } from './types'
import { ApiError } from './types'
import { BOOKMARK_HEADER, openSession } from './db'
import { cleanupExpiredShares } from './share-cleanup'
import { getAdminSession, requireConfig } from './services'
import { registerAuthRoutes } from './auth-routes'
import { registerEntryRoutes } from './entry-routes'
import { registerShareRoutes } from './share-routes'

const app = new Hono<Environment>()

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store, private')
  c.header('Pragma', 'no-cache')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex')
  const session = openSession(c.env.DB, new URL(c.req.url).pathname,
    c.req.method, c.req.header(BOOKMARK_HEADER) ?? null)
  c.set('db', session)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (c.req.header('Origin') !== new URL(c.req.url).origin) {
      return c.json({ error: 'Untrusted request origin' }, 403)
    }
  }
  await next()
  const bookmark = session.getBookmark()
  if (bookmark) c.header(BOOKMARK_HEADER, bookmark)
})
app.use('/api/admin/*', async (c, next) => {
  const pathname = new URL(c.req.url).pathname
  if (pathname === '/api/admin/login' || pathname === '/api/admin/session') return next()
  if (!await getAdminSession(c)) return c.json({ error: 'Admin sign in required', code: 'UNAUTHORIZED' }, 401)
  return next()
})

app.get('/api/health', (c) => c.json({ ok: true }))
app.get('/api/health/live', (c) => c.json({ ok: true }))
app.get('/api/health/ready', async (c) => {
  try {
    requireConfig(c)
    await c.var.db.prepare('SELECT 1 AS ready').bind().first()
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 503)
  }
})

registerAuthRoutes(app)
registerEntryRoutes(app)
registerShareRoutes(app)

app.onError((error, c) => {
  const status = error instanceof ApiError ? error.status : 500
  const message = error instanceof ApiError ? error.message : 'Service temporarily unavailable'
  const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR'
  return new Response(JSON.stringify({ error: message, code }), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private', 'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
      ...(error instanceof ApiError && error.retryAfterSeconds
        ? { 'Retry-After': String(error.retryAfterSeconds) } : {}) }
  })
})
app.notFound((c) => c.json({ error: 'Endpoint not found' }, 404))

export { app }

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx)
  },
  async scheduled(event: ScheduledController, env: Bindings) {
    // A delayed midnight run must not remove links revoked or expired after its cutoff.
    await cleanupExpiredShares(env.DB, event.scheduledTime)
  }
} satisfies ExportedHandler<Bindings>
