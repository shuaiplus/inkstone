import { Hono } from 'hono'
import { initializeDatabase } from './db/schema'
import { ApiError, errorResponse } from './lib/errors'
import { loadSession, requireClientHeader } from './middleware/auth'
import { authRoutes } from './routes/auth'
import { totpRoutes } from './routes/totp'
import { notesRoutes } from './routes/notes'
import { foldersRoutes } from './routes/folders'
import { tagsRoutes } from './routes/tags'
import { searchRoutes } from './routes/search'
import { syncRoutes } from './routes/sync'
import { filesRoutes } from './routes/files'
import { avatarRoutes } from './routes/avatars'
import { backupRoutes } from './routes/backup'
import { settingsRoutes } from './routes/settings'
import { shareManageRoutes, sharePageRoutes, shareRoutes } from './routes/share'
import { transferRoutes } from './routes/transfer'
import { updateRoutes } from './routes/update'
import { mcpAuthorizeRoutes } from './routes/mcp-authorize'
import { mcpSettingsRoutes } from './routes/mcp-settings'
import { aiRoutes } from './routes/ai'
import type { AppBindings } from './env'
import { selectAttachmentStorage } from './attachments/backend'

const LOCAL_AI_CONNECT_SRC = "'self' http://127.0.0.1:11434 http://localhost:11434"

export function createApp() {
  const app = new Hono<AppBindings>()

  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    await next()
    const isHttps = new URL(c.req.url).protocol === 'https:'
    const imageSchemes = isHttps ? 'https:' : 'https: http:'
    const formAction = authorizationFormAction(c.req.url, c.res)
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    c.header(
      'Content-Security-Policy',
        "default-src 'self'; base-uri 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        `img-src 'self' data: blob: ${imageSchemes}; font-src 'self' data:; connect-src ${LOCAL_AI_CONNECT_SRC}; worker-src 'self' blob:; ` +
        `manifest-src 'self'; media-src 'self' blob:; form-action ${formAction}; frame-src 'none'; ` +
        "frame-ancestors 'none'; object-src 'none'",
    )
    if (isHttps) {
      c.header('Strict-Transport-Security', 'max-age=31536000')
    }
    if (c.req.path.startsWith('/api/') && !c.res.headers.has('Cache-Control')) {
      c.header('Cache-Control', 'no-store')
    }
  })


  app.use('/api/*', async (c, next) => {
    c.set('database', await initializeDatabase(c.env))
    await next()
  })
  app.use('/s/*', async (c, next) => {
    c.set('database', await initializeDatabase(c.env))
    await next()
  })
  app.use('/authorize', async (c, next) => {
    c.set('database', await initializeDatabase(c.env))
    await next()
  })

  app.use('/api/*', requireClientHeader)
  app.use('/api/*', loadSession)
  app.use('/authorize', loadSession)

  app.get('/api/health', async (c) => {
    const database = c.get('database')
    if (!c.get('userId')) return c.json({ ok: true })
    return c.json({
      ok: true,
      database: 'ready',
      fts: database.ftsEnabled,
      r2: Boolean(c.env.FILES),
      kv: Boolean(c.env.FILES_KV),
      attachmentStorage: selectAttachmentStorage(c.env),
      realtime: Boolean(c.env.SYNC_HUB),
      credentialVault: Boolean(c.env.CREDENTIAL_VAULT),
      mcp: Boolean(c.env.OAUTH_KV),
      time: Date.now(),
    })
  })

  app.route('/api/auth/totp', totpRoutes)
  app.route('/api/auth', authRoutes)
  app.route('/api/notes', notesRoutes)
  app.route('/api/folders', foldersRoutes)
  app.route('/api/tags', tagsRoutes)
  app.route('/api', searchRoutes)
  app.route('/api/sync', syncRoutes)
  app.route('/api/files', filesRoutes)
  app.route('/api/avatars', avatarRoutes)
  app.route('/api/backup', backupRoutes)
  app.route('/api/settings', settingsRoutes)
  app.route('/api/update', updateRoutes)
  app.route('/api/mcp', mcpSettingsRoutes)
  app.route('/api/ai', aiRoutes)
  app.route('/api/share', shareManageRoutes)
  app.route('/api/public', shareRoutes)
  app.route('/api', transferRoutes)

  app.all('/api/*', () => {
    throw ApiError.notFound('API endpoint not found')
  })


  app.route('/s', sharePageRoutes)
  app.route('/', mcpAuthorizeRoutes)


  app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

  return app
}

function authorizationFormAction(requestUrl: string, response: Response): string {
  const sources = ["'self'"]
  const url = new URL(requestUrl)
  if (url.pathname !== '/authorize' || response.status !== 200 ||
      !response.headers.get('Content-Type')?.includes('text/html')) {
    return sources.join(' ')
  }
  const redirectUri = url.searchParams.get('redirect_uri')
  if (!redirectUri) return sources.join(' ')
  try {
    const callback = new URL(redirectUri)
    if ((callback.protocol === 'http:' || callback.protocol === 'https:') && callback.origin !== url.origin) {
      sources.push(callback.origin)
    }
  } catch {
  }
  return sources.join(' ')
}
