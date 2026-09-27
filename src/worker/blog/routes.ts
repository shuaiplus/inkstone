import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  blogAuthMiddleware, handleBlogAuth, setBlogSessionCookie,
  setBlogPassword, clearBlogPassword, setBlogTitle, getBlogTitle,
} from './auth'
import {
  getBlogOwner, hasBlogPassword, listBlogPosts, getBlogPost,
  listBlogMoments, listBlogTimeline, listBlogTags, listPostsByTag,
} from './queries'

export const blogRoutes = new Hono<AppBindings>()

blogRoutes.use('/settings', requireAuth)

blogRoutes.get('/settings', async (c) => {
  const userId = c.get('userId')
  return c.json({
    hasPassword: await hasBlogPassword(c.env.DB, userId),
    title: await getBlogTitle(c.env.DB, userId),
  })
})

blogRoutes.put('/settings', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ password?: string | null; title?: string }>(c, 4096)
  if (body.password !== undefined) {
    if (body.password === null || body.password === '') await clearBlogPassword(c.env.DB, userId)
    else await setBlogPassword(c.env.DB, userId, body.password)
  }
  if (body.title !== undefined) await setBlogTitle(c.env.DB, userId, body.title)
  return c.json({ ok: true })
})

blogRoutes.use('/:username/*', async (c, next) => {
  const ownerId = await getBlogOwner(c.env.DB, c.req.param('username'))
  if (!ownerId) return c.json({ error: { code: 'not_found', message: 'Blog not found' } }, 404)
  c.set('blogOwnerId', ownerId)
  await next()
})

blogRoutes.post('/:username/auth', async (c) => {
  const userId = c.get('blogOwnerId')!
  const body = await readJson<{ password?: string }>(c, 4096)
  const token = await handleBlogAuth(c.env.DB, userId, body.password ?? '')
  if (!token) return c.json({ error: { code: 'invalid_credentials', message: 'Invalid blog password' } }, 401)
  setBlogSessionCookie(c, userId, token)
  return c.json({ ok: true })
})

blogRoutes.get('/:username/meta', async (c) => {
  const userId = c.get('blogOwnerId')!
  const username = c.req.param('username')
  return c.json({ username, title: await getBlogTitle(c.env.DB, userId) })
})

blogRoutes.use('/:username/*', blogAuthMiddleware)

const publicOnly = async (c: { env: AppBindings['Bindings']; get: (k: string) => string }) =>
  !(await hasBlogPassword(c.env.DB, c.get('blogOwnerId')))

blogRoutes.get('/:username/posts', async (c) => {
  const userId = c.get('blogOwnerId')!
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1)
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '10', 10) || 10))
  const onlyPublic = await publicOnly(c)
  return c.json(await listBlogPosts(c.env.DB, userId, onlyPublic, page, limit))
})

blogRoutes.get('/:username/posts/:slug', async (c) => {
  const userId = c.get('blogOwnerId')!
  const onlyPublic = await publicOnly(c)
  const post = await getBlogPost(c.env.DB, userId, c.req.param('slug'), onlyPublic)
  if (!post) return c.json({ error: { code: 'not_found', message: 'Post not found' } }, 404)
  return c.json(post)
})

blogRoutes.get('/:username/moments', async (c) => {
  const userId = c.get('blogOwnerId')!
  const onlyPublic = await publicOnly(c)
  const moments = await listBlogMoments(c.env.DB, userId, onlyPublic)
  return c.json({ moments })
})

blogRoutes.get('/:username/timeline', async (c) => {
  const userId = c.get('blogOwnerId')!
  const onlyPublic = await publicOnly(c)
  const items = await listBlogTimeline(c.env.DB, userId, onlyPublic)
  return c.json({ items })
})

blogRoutes.get('/:username/tags', async (c) => {
  const userId = c.get('blogOwnerId')!
  const onlyPublic = await publicOnly(c)
  const tags = await listBlogTags(c.env.DB, userId, onlyPublic)
  return c.json({ tags })
})

blogRoutes.get('/:username/tags/:name', async (c) => {
  const userId = c.get('blogOwnerId')!
  const onlyPublic = await publicOnly(c)
  const posts = await listPostsByTag(c.env.DB, userId, c.req.param('name'), onlyPublic)
  return c.json({ name: c.req.param('name'), posts })
})
