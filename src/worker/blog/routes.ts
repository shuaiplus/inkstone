import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { LIMITS } from '@shared/constants'
import { BLOG_PRIVATE_TAG } from '@shared/blog/tags'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson, requestClientIp } from '../lib/request'
import {
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
  ThrottleError,
} from '../lib/throttle'
import { requireAuth } from '../middleware/auth'
import {
  blogAuthMiddleware, handleBlogAuth, setBlogSessionCookie, BLOG_SESSION_COOKIE,
  setBlogPassword, clearBlogPassword, setBlogTitle, getBlogTitle,
  setBlogDescription, getBlogDescription,
  clearBlogSession, deleteBlogSessionCookie,
} from './auth'
import { getBlogPasswordHash, ensureBlogShare } from './publish'
import {
  getBlogOwner, getBlogOwnerUsername, hasBlogPassword, listBlogPosts, getBlogPost,
  listBlogMoments, listBlogTimeline, listBlogTags, listPostsByTag,
  getAdjacentPosts,
} from './queries'

export const blogRoutes = new Hono<AppBindings>()

blogRoutes.use('/settings', requireAuth)

blogRoutes.get('/settings', async (c) => {
  const userId = c.get('userId')
  return c.json({
    hasCustomPassword: await hasBlogPassword(c.env.DB, userId),
    title: await getBlogTitle(c.env.DB, userId),
    description: await getBlogDescription(c.env.DB, userId),
  })
})

async function rehashBlogPrivateShares(db: D1Database, userId: string): Promise<void> {
  const newHash = await getBlogPasswordHash(db, userId)
  const { results } = await db
    .prepare(
      `SELECT n.id FROM notes n
        JOIN note_tags nt ON nt.note_id = n.id
        JOIN tags t ON t.id = nt.tag_id AND t.user_id = n.user_id
       WHERE n.user_id = ?1 AND n.deleted_at IS NULL AND t.name = '${BLOG_PRIVATE_TAG}'`,
    )
    .bind(userId)
    .all<{ id: string }>()
  for (const row of results) {
    await ensureBlogShare(db, userId, row.id, 'private', newHash)
  }
}

blogRoutes.put('/settings', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ password?: string | null; title?: string; description?: string | null }>(c, 4096)
  if (body.password !== undefined) {
    if (typeof body.password === 'string' && body.password.length > LIMITS.passwordMaxLength) {
      throw ApiError.badRequest(`The blog password must not exceed ${LIMITS.passwordMaxLength} characters`)
    }
    if (body.password === null || body.password === '') await clearBlogPassword(c.env.DB, userId)
    else await setBlogPassword(c.env.DB, userId, body.password)
    await rehashBlogPrivateShares(c.env.DB, userId)
  }
  if (body.title !== undefined) await setBlogTitle(c.env.DB, userId, body.title)
  if (body.description !== undefined) await setBlogDescription(c.env.DB, userId, body.description ?? '')
  return c.json({ ok: true })
})

blogRoutes.get('/owner', async (c) => {
  const username = await getBlogOwnerUsername(c.env.DB)
  if (!username) return c.json({ error: { code: 'not_found', message: 'No blog owner found' } }, 404)
  return c.json({ username })
})

blogRoutes.use('/:username/*', async (c, next) => {
  const ownerId = await getBlogOwner(c.env.DB, c.req.param('username'))
  if (!ownerId) return c.json({ error: { code: 'not_found', message: 'Blog not found' } }, 404)
  c.set('blogOwnerId', ownerId)
  await next()
})

blogRoutes.post('/:username/auth', async (c) => {
  const userId = c.get('blogOwnerId')!
  const username = c.req.param('username')
  const body = await readJson<{ password?: string }>(c, 4096)
  const password = typeof body.password === 'string' ? body.password : ''
  const throttleKeys = [
    `blog:${username}:ip:${requestClientIp(c)}`,
    { key: `blog-auth:${username}`, freeFails: 40 },
  ]
  const workKeys = [
    {
      key: `blog-work:${username}:ip:${requestClientIp(c)}`,
      maxAttempts: 8,
      windowMs: 10 * 60 * 1000,
    },
    {
      key: `blog-work-account:${username}`,
      maxAttempts: 60,
      windowMs: 10 * 60 * 1000,
    },
  ]
  try {
    await assertNotLocked(c.env.DB, throttleKeys)
    await consumeAttemptBudget(c.env.DB, workKeys)
  } catch (err) {
    if (err instanceof ThrottleError) {
      return c.json({ error: { code: 'too_many_attempts', message: 'Too many attempts. Try again later' } }, 429)
    }
    throw err
  }
  const token = await handleBlogAuth(c.env.DB, userId, password)
  if (!token) {
    await recordLoginFailure(c.env.DB, throttleKeys)
    return c.json({ error: { code: 'invalid_credentials', message: 'Invalid blog password' } }, 401)
  }
  await clearLoginFailures(c.env.DB, [
    ...throttleKeys.map((target) => (typeof target === 'string' ? target : target.key)),
    ...workKeys.map((target) => target.key),
  ])
  setBlogSessionCookie(c, userId, token)
  return c.json({ ok: true })
})

blogRoutes.get('/:username/meta', async (c) => {
  const userId = c.get('blogOwnerId')!
  const username = c.req.param('username')
  return c.json({
    username,
    title: await getBlogTitle(c.env.DB, userId),
    description: await getBlogDescription(c.env.DB, userId),
  })
})

blogRoutes.use('/:username/*', blogAuthMiddleware)

const requestTier = (c: Context<AppBindings>) => (c.get('blogAuthed') ? 'all' : 'public')

blogRoutes.get('/:username/session', (c) => {
  return c.json({ authed: c.get('blogAuthed') })
})

blogRoutes.post('/:username/logout', async (c) => {
  const userId = c.get('blogOwnerId')!
  const token = getCookie(c, BLOG_SESSION_COOKIE(userId))
  if (token) await clearBlogSession(c.env.DB, userId, token)
  deleteBlogSessionCookie(c, userId)
  return c.json({ ok: true })
})

blogRoutes.get('/:username/posts', async (c) => {
  const userId = c.get('blogOwnerId')!
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1)
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '10', 10) || 10))
  return c.json(await listBlogPosts(c.env.DB, userId, requestTier(c), page, limit))
})

blogRoutes.get('/:username/posts/:slug', async (c) => {
  const userId = c.get('blogOwnerId')!
  const post = await getBlogPost(c.env.DB, userId, c.req.param('slug'), 'all')
  if (!post) return c.json({ error: { code: 'not_found', message: 'Post not found' } }, 404)
  if (post.tags.includes(BLOG_PRIVATE_TAG) && !c.get('blogAuthed')) {
    return c.json({ error: { code: 'blog_auth_required', message: 'Blog authentication required' } }, 401)
  }
  const adjacent = await getAdjacentPosts(c.env.DB, userId, requestTier(c), post.created_at, post.id)
  return c.json({ ...post, previous: adjacent.previous, next: adjacent.next })
})

blogRoutes.get('/:username/moments', async (c) => {
  const userId = c.get('blogOwnerId')!
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20))
  return c.json(await listBlogMoments(c.env.DB, userId, requestTier(c), page, limit))
})

blogRoutes.get('/:username/timeline', async (c) => {
  const userId = c.get('blogOwnerId')!
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20))
  return c.json(await listBlogTimeline(c.env.DB, userId, requestTier(c), page, limit))
})

blogRoutes.get('/:username/tags', async (c) => {
  const userId = c.get('blogOwnerId')!
  const tags = await listBlogTags(c.env.DB, userId, requestTier(c))
  return c.json({ tags })
})

blogRoutes.get('/:username/tags/:name', async (c) => {
  const userId = c.get('blogOwnerId')!
  const posts = await listPostsByTag(c.env.DB, userId, c.req.param('name'), requestTier(c))
  return c.json({ name: c.req.param('name'), posts })
})
