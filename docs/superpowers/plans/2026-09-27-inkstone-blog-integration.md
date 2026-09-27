# Inkstone Blog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a password-protected, per-user private blog publishing channel to Inkstone by fully reusing the existing `shares` mechanism, so a user can mark specific shares as published and view them at `/blog/:username`.

**Architecture:** Blog reads and publishing both live on the existing `shares` table (new `blog_published` column, migration 13) and existing `app_meta` table (per-user `blog_password_hash:<userId>` and `blog_title:<userId>`). New server code is isolated in `src/worker/blog/` mounted at `/api/blog`; new client code is isolated in `src/client/blog/` rendered by a `/blog/:username` branch in `App.tsx`. Blog password/title are managed in a new "Blog" tab in the Settings panel. No new data tables, no write-sync hooks, no front-matter coupling.

**Tech Stack:** Hono, D1, React 19, Tailwind CSS 4, markdown-it (existing), scrypt password hashing (existing), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-inkstone-blog-design.md`

## Global Constraints

- Package manager: npm (Inkstone uses npm, not bun)
- React 19.2.8 — no React 18-only APIs
- Hono 4.12.34 — blog routes follow existing patterns in `src/worker/routes/`
- D1 — no foreign key enforcement; use manual joins + `deleted_at IS NULL` filters
- Blog password hashing: reuse `hashPassword()` / `verifyPassword()` from `src/worker/lib/password.ts`
- ID/slug generation: reuse `newId()`, `newSlug()`, `isValidSlug()` from `src/worker/lib/id.ts`
- Per-user blog settings: `getMeta()` / `setMeta()` from `src/worker/db/metadata.ts`, keys `blog_password_hash:<userId>` and `blog_title:<userId>`
- Username identifier: `users.username` (unique, normalized per `normalizeUsername`)
- Global middleware: `app.use('/api/*', requireClientHeader)` only requires `X-Inkstone-Client: 1` for non-GET/HEAD/OPTIONS methods; `loadSession` is optional (does not block anonymous)
- Blog session cookie: `blog_session_<userId>`, HttpOnly, SameSite=Strict, Secure on https, 30-day TTL
- All new blog code lives in `src/{client,worker}/blog/` (client settings component lives in `src/client/features/settings/`), plus the modified files listed below
- No comments in code unless explaining a non-obvious decision

## Review Focus

1. **Unknown blog username** — `GET /api/blog/:username/posts` with a username that doesn't exist must 404, not return an empty list. Tested in Task 3.
2. **Expired share still on blog** — a published share whose `expires_at` is in the past must be excluded from listings and detail. Tested in Task 3.
3. **Soft-deleted note still on blog** — a published share whose note has `deleted_at IS NOT NULL` must be excluded. Tested in Task 3.
4. **Passwordless published share on a public blog vs a protected blog** — `onlyPublic=true` must exclude shares with `password_hash` set; the full view must include them. Tested in Task 3.
5. **Blog password state mismatch** — an unauthenticated visitor to a password-protected blog must get 401 on content endpoints, while the visitor who has the blog-session cookie gets the full list. Tested in Task 4.

---

## File Structure

### New files

```
src/shared/blog/types.ts                    # Blog response types
src/worker/blog/auth.ts                     # Blog password + session helpers + middleware
src/worker/blog/queries.ts                  # D1 query helpers for blog data
src/worker/blog/routes.ts                   # Hono routes for /api/blog/*
src/client/blog/api.ts                      # Blog API client (fetch wrapper)
src/client/blog/router.tsx                  # Lightweight blog sub-router (BlogApp)
src/client/blog/styles.css                  # Rin/Hugo-inspired isolated CSS
src/client/blog/components/header.tsx       # Blog header (title, nav)
src/client/blog/components/footer.tsx       # Blog footer
src/client/blog/components/feed-card.tsx    # Article card
src/client/blog/components/markdown.tsx     # BlogMarkdown (reuses renderMarkdown pipeline)
src/client/blog/pages/feed.tsx              # Article list page
src/client/blog/pages/post.tsx              # Article detail page
src/client/blog/pages/moments.tsx           # Moments page
src/client/blog/pages/timeline.tsx          # Timeline page
src/client/blog/pages/tags.tsx              # Tags index page
src/client/blog/pages/tag.tsx               # Tag-filtered posts page
src/client/blog/pages/login.tsx             # Blog password login page
src/client/features/settings/BlogSettings.tsx  # Settings Blog tab
tests/blog-auth.test.ts                     # Unit tests for auth helpers
tests/blog-queries.test.ts                  # Unit tests for query helpers
```

### Modified existing files

| File | Change |
|---|---|
| `src/shared/types.ts` | Add `blogPublished: boolean` to `ShareInfo` |
| `src/worker/db/schema.ts` | Migration 13 (`blog_published` column + index); `REQUIRED_COLUMNS` for `shares`; `REQUIRED_INDEXES` |
| `src/worker/routes/share.ts` | `POST /:noteId` accepts `blogPublished?`; set column; `toShareInfo` includes it |
| `src/worker/env.ts` | Add `blogOwnerId?: string` to `Variables` |
| `src/worker/app.ts` | Mount `app.route('/api/blog', blogRoutes)` |
| `src/client/App.tsx` | `/blog/:username` branch before share-slug check; skip notebook load on blog paths |
| `src/client/lib/api.ts` | `api.share.create` accepts `blogPublished?` |
| `src/client/features/settings/sections.ts` | Add `blog` to `SettingsSection`, `settingsLoaders`, `warmSettingsSection` |
| `src/client/features/settings/SettingsPanel.tsx` | Add Blog tab to `SECTIONS` |
| `src/client/features/share/SharePanel.tsx` | "Publish to blog" toggle |

---

## Task 1: Schema Migration for `blog_published`

**Files:**
- Modify: `src/worker/db/schema.ts`

**Interfaces:**
- Produces: `shares.blog_published INTEGER NOT NULL DEFAULT 0` column in D1, registered in `REQUIRED_COLUMNS` and `REQUIRED_INDEXES`; migration version 13 appended to `SCHEMA_MIGRATIONS`.

- [ ] **Step 1: Add `blog_published` to the `shares` table in `SCHEMA_STATEMENTS`**

In `src/worker/db/schema.ts`, in the `CREATE TABLE IF NOT EXISTS shares (...)` statement (around line 112), add after `created_at INTEGER NOT NULL`:

```sql
    blog_published INTEGER NOT NULL DEFAULT 0
```

- [ ] **Step 2: Add migration 13 to `SCHEMA_MIGRATIONS`**

Append after migration 12 (before the closing `]` of `SCHEMA_MIGRATIONS`):

```typescript
  {
    version: 13,
    statements: [
      `ALTER TABLE shares ADD COLUMN blog_published INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS idx_shares_blog ON shares(user_id, blog_published, created_at DESC)`,
    ],
  },
```

- [ ] **Step 3: Update `REQUIRED_COLUMNS` for `shares`**

Add `'blog_published'` to the `shares` array in `REQUIRED_COLUMNS` (around line 606).

- [ ] **Step 4: Add the new index to `REQUIRED_INDEXES`**

Add `'idx_shares_blog'` to the `REQUIRED_INDEXES` array.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Run unit tests**

Run: `npm run test:unit`
Expected: PASS (existing tests still pass)

- [ ] **Step 7: Commit**

```bash
git add src/worker/db/schema.ts
git commit -m "feat(blog): add shares.blog_published migration"
```

---

## Task 2: Shared Blog Types

**Files:**
- Create: `src/shared/blog/types.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces: `BlogPostSummary`, `BlogPostDetail`, `TimelineItem`, `BlogTag`, `MomentItem`, `BlogPostsResponse`, `MomentsResponse` — used by worker queries, routes, and client.

- [ ] **Step 1: Create `src/shared/blog/types.ts`**

```typescript
export interface BlogPostSummary {
  id: string
  title: string
  excerpt: string
  created_at: number
  updated_at: number
  tags: string[]
  slug: string
}

export interface BlogPostDetail extends BlogPostSummary {
  content: string
}

export interface TimelineItem {
  id: string
  title: string
  created_at: number
}

export interface BlogTag {
  name: string
  count: number
}

export interface MomentItem {
  id: string
  content: string
  created_at: number
  tags: string[]
}

export interface BlogPostsResponse {
  posts: BlogPostSummary[]
  page: number
  hasMore: boolean
}

export interface MomentsResponse {
  moments: MomentItem[]
  page: number
  hasMore: boolean
}
```

- [ ] **Step 2: Add `blogPublished` to `ShareInfo` in `src/shared/types.ts`**

Add `blogPublished: boolean` to the `ShareInfo` interface (around line 461).

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/shared/blog/types.ts src/shared/types.ts
git commit -m "feat(blog): add shared blog types and ShareInfo.blogPublished"
```

---

## Task 3: Blog Query Helpers

**Files:**
- Create: `src/worker/blog/queries.ts`
- Test: `tests/blog-queries.test.ts`

**Interfaces:**
- Consumes: types from `@shared/blog/types`, `getMeta` from `../db/metadata`, `splitTags` from `../db/rows`
- Produces:
  - `getBlogOwner(db, username: string): Promise<string | null>`
  - `hasBlogPassword(db, userId: string): Promise<boolean>`
  - `listBlogPosts(db, userId, onlyPublic, page, limit): Promise<BlogPostsResponse>`
  - `getBlogPost(db, userId, slug, onlyPublic): Promise<BlogPostDetail | null>`
  - `listBlogMoments(db, userId, onlyPublic): Promise<MomentItem[]>`
  - `listBlogTimeline(db, userId, onlyPublic): Promise<TimelineItem[]>`
  - `listBlogTags(db, userId, onlyPublic): Promise<BlogTag[]>`
  - `listPostsByTag(db, userId, tagName, onlyPublic): Promise<BlogPostSummary[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/blog-queries.test.ts`. Use a minimal in-memory D1 mock object exposing `prepare(sql).bind(...).all()/.first()/.run()`, keyed on the SQL text so different queries return different rows. Test:

```typescript
import { describe, expect, it } from 'vitest'
import { getBlogOwner, listBlogPosts, getBlogPost } from '../src/worker/blog/queries'

describe('blog queries', () => {
  it('getBlogOwner returns null for unknown username', async () => {
    expect(await getBlogOwner(mockDb(), 'nobody')).toBeNull()
  })

  it('listBlogPosts excludes expired shares', async () => {
    const posts = await listBlogPosts(mockDbWithExpiredShare(), 'u1', false, 1, 10)
    expect(posts.posts.map((p) => p.id)).not.toContain('expired-note')
  })

  it('listBlogPosts excludes soft-deleted notes', async () => {
    const posts = await listBlogPosts(mockDbWithDeletedNote(), 'u1', false, 1, 10)
    expect(posts.posts.map((p) => p.id)).not.toContain('deleted-note')
  })

  it('onlyPublic excludes password-protected shares', async () => {
    const posts = await listBlogPosts(mockDbMixed(), 'u1', true, 1, 10)
    expect(posts.posts.map((p) => p.id)).not.toContain('private-note')
    expect(posts.posts.map((p) => p.id)).toContain('public-note')
  })

  it('getBlogPost by slug and unknown slug returns null', async () => {
    const detail = await getBlogPost(mockDb(), 'u1', 'my-slug', false)
    expect(detail?.slug).toBe('my-slug')
    expect(await getBlogPost(mockDb(), 'u1', 'missing', false)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/blog-queries.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/worker/blog/queries.ts`**

Implement the functions with these SQL semantics (all joins filter `n.deleted_at IS NULL` and `(s.expires_at IS NULL OR s.expires_at > Date.now())`, and always `s.user_id = ?`):

- `getBlogOwner`: `SELECT id FROM users WHERE username = ?1`.
- `hasBlogPassword`: `Boolean(await getMeta(db, 'blog_password_hash:' + userId))`.
- `listBlogPosts`: `SELECT s.note_id AS id, n.title, n.excerpt, s.created_at, n.updated_at, s.slug, <tag subquery> FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id WHERE s.user_id = ?1 AND s.blog_published = 1 AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2) <AND s.password_hash IS NULL when onlyPublic> ORDER BY s.created_at DESC LIMIT ?3 OFFSET ?4`, plus a `COUNT(*)` for `hasMore`. Tag subquery mirrors `NOTE_COLUMNS` in `src/worker/db/rows.ts` (`GROUP_CONCAT(t.name, char(1))` over `note_tags`/`tags`).
- `getBlogPost`: same join + filters, `WHERE s.slug = ?1`, limit 1.
- `listBlogMoments`: notes in the user's root `Moments` folder: `JOIN folders f ON f.id = n.folder_id AND f.name = 'Moments' AND f.parent_id IS NULL AND f.deleted_at IS NULL`.
- `listBlogTimeline`: posts grouped by year (`strftime('%Y', datetime(s.created_at/1000, 'unixepoch'))`), returning items with a `year` field.
- `listBlogTags`: tag counts over published posts (`HAVING count > 0`).
- `listPostsByTag`: posts with a tag matching `?tag COLLATE NOCASE`.
- Use `splitTags` from `../db/rows` to decode `tag_names`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/blog-queries.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/worker/blog/queries.ts tests/blog-queries.test.ts
git commit -m "feat(blog): add blog query helpers"
```

---

## Task 4: Blog Auth Helpers and Middleware

**Files:**
- Create: `src/worker/blog/auth.ts`
- Test: `tests/blog-auth.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword` from `../lib/password`, `newId` from `../lib/id`, `getMeta`/`setMeta` from `../db/metadata`, `getCookie`/`setCookie` from `hono/cookie`, `createMiddleware` from `hono/factory`, `AppBindings` from `../env`, `hasBlogPassword` from `./queries` (Task 3)
- Produces:
  - `BLOG_SESSION_PREFIX = 'blog_session:'`
  - `BLOG_PASSWORD_KEY = (userId: string) => `blog_password_hash:${userId}``
  - `BLOG_TITLE_KEY = (userId: string) => `blog_title:${userId}``
  - `BLOG_SESSION_COOKIE = (userId: string) => `blog_session_${userId}``
  - `setBlogPassword(db, userId, password): Promise<void>`
  - `clearBlogPassword(db, userId): Promise<void>`
  - `setBlogTitle(db, userId, title): Promise<void>`
  - `getBlogTitle(db, userId): Promise<string | null>`
  - `handleBlogAuth(db, userId, password): Promise<string | null>` — token on success
  - `validateBlogSession(db, userId, token): Promise<boolean>`
  - `setBlogSessionCookie(c, userId, token): void`
  - `blogAuthMiddleware` — Hono middleware that 401s when the owner has a password and no valid cookie.

- [ ] **Step 1: Write the failing test**

Create `tests/blog-auth.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { handleBlogAuth, validateBlogSession } from '../src/worker/blog/auth'

describe('blog auth', () => {
  it('returns null when no password is set', async () => {
    expect(await handleBlogAuth(mockDbNoMeta(), 'u1', 'secret')).toBeNull()
  })

  it('returns null for wrong password', async () => {
    expect(await handleBlogAuth(mockDbWithPassword(), 'u1', 'wrong')).toBeNull()
  })

  it('returns a token for correct password and validates it', async () => {
    const token = await handleBlogAuth(mockDbWithPassword(), 'u1', 'secret')
    expect(token).toBeTruthy()
    expect(await validateBlogSession(mockDbWithPassword(), 'u1', token!)).toBe(true)
  })

  it('rejects invalid or expired tokens', async () => {
    expect(await validateBlogSession(mockDbNoMeta(), 'u1', 'bogus')).toBe(false)
  })
})
```

Use the same mock D1 style as Task 3, backing `app_meta` with the user-scoped keys.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/blog-auth.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/worker/blog/auth.ts`**

- `BLOG_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000`
- `setBlogPassword`: `await setMeta(db, BLOG_PASSWORD_KEY(userId), await hashPassword(password))`
- `clearBlogPassword`: `await setMeta(db, BLOG_PASSWORD_KEY(userId), '')` (empty string means "no password")
- `setBlogTitle` / `getBlogTitle`: set/get `blog_title:<userId>`
- `handleBlogAuth`: read `BLOG_PASSWORD_KEY(userId)`; if falsy return null; `verifyPassword`; on success create `newId()` token, store `BLOG_SESSION_PREFIX + userId + ':' + token` → `String(Date.now() + TTL)` via `setMeta`; return token
- `validateBlogSession`: read stored expiry; `Number(raw) > Date.now()`
- `setBlogSessionCookie(c, userId, token)`: `setCookie(c, BLOG_SESSION_COOKIE(userId), token, { path: '/', httpOnly: true, sameSite: 'Strict', secure: new URL(c.req.url).protocol === 'https:', maxAge: Math.floor(BLOG_SESSION_TTL_MS / 1000) })`
- `blogAuthMiddleware`: read `c.get('blogOwnerId')`; if `hasBlogPassword(db, ownerId)` and no valid session cookie (`getCookie(c, BLOG_SESSION_COOKIE(ownerId))`) → `c.json({ error: { code: 'blog_auth_required', message: 'Blog authentication required' } }, 401)`; else `await next()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/blog-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/worker/blog/auth.ts tests/blog-auth.test.ts
git commit -m "feat(blog): add blog password auth and session helpers"
```

---

## Task 5: Blog API Routes

**Files:**
- Create: `src/worker/blog/routes.ts`
- Modify: `src/worker/env.ts`

**Interfaces:**
- Consumes: `blogAuthMiddleware`, `handleBlogAuth`, `setBlogSessionCookie`, `setBlogPassword`, `clearBlogPassword`, `setBlogTitle`, `getBlogTitle` from `./auth`; `getBlogOwner`, `hasBlogPassword`, `listBlogPosts`, `getBlogPost`, `listBlogMoments`, `listBlogTimeline`, `listBlogTags`, `listPostsByTag` from `./queries`; `readJson` from `../lib/request`; `requireAuth` from `../middleware/auth`
- Produces: `blogRoutes` — a Hono instance mounted at `/api/blog`.

- [ ] **Step 1: Add `blogOwnerId?: string` to the `Variables` interface in `src/worker/env.ts`**

So `c.set('blogOwnerId', ...)` typechecks.

- [ ] **Step 2: Implement `src/worker/blog/routes.ts`**

```typescript
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
  const userId = c.get('blogOwnerId')
  const body = await readJson<{ password?: string }>(c, 4096)
  const token = await handleBlogAuth(c.env.DB, userId, body.password ?? '')
  if (!token) return c.json({ error: { code: 'invalid_credentials', message: 'Invalid blog password' } }, 401)
  setBlogSessionCookie(c, userId, token)
  return c.json({ ok: true })
})

blogRoutes.use('/:username/*', blogAuthMiddleware)

const publicOnly = async (c: { env: AppBindings['Bindings']; get: (k: string) => string }) =>
  !(await hasBlogPassword(c.env.DB, c.get('blogOwnerId')))

blogRoutes.get('/:username/posts', async (c) => {
  const userId = c.get('blogOwnerId')
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1)
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '10', 10) || 10))
  const onlyPublic = await publicOnly(c)
  return c.json(await listBlogPosts(c.env.DB, userId, onlyPublic, page, limit))
})

blogRoutes.get('/:username/posts/:slug', async (c) => {
  const userId = c.get('blogOwnerId')
  const onlyPublic = await publicOnly(c)
  const post = await getBlogPost(c.env.DB, userId, c.req.param('slug'), onlyPublic)
  if (!post) return c.json({ error: { code: 'not_found', message: 'Post not found' } }, 404)
  return c.json(post)
})

blogRoutes.get('/:username/moments', async (c) => {
  const userId = c.get('blogOwnerId')
  const onlyPublic = await publicOnly(c)
  const moments = await listBlogMoments(c.env.DB, userId, onlyPublic)
  return c.json({ moments })
})

blogRoutes.get('/:username/timeline', async (c) => {
  const userId = c.get('blogOwnerId')
  const onlyPublic = await publicOnly(c)
  const items = await listBlogTimeline(c.env.DB, userId, onlyPublic)
  return c.json({ items })
})

blogRoutes.get('/:username/tags', async (c) => {
  const userId = c.get('blogOwnerId')
  const onlyPublic = await publicOnly(c)
  const tags = await listBlogTags(c.env.DB, userId, onlyPublic)
  return c.json({ tags })
})

blogRoutes.get('/:username/tags/:name', async (c) => {
  const userId = c.get('blogOwnerId')
  const onlyPublic = await publicOnly(c)
  const posts = await listPostsByTag(c.env.DB, userId, c.req.param('name'), onlyPublic)
  return c.json({ name: c.req.param('name'), posts })
})
```

Note: `onlyPublic` is derived from the owner's password state (not from the visitor's session) so the guest browser can render the correct list; `blogAuthMiddleware` already blocks unauthenticated access to a password-protected blog.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/worker/blog/routes.ts src/worker/env.ts
git commit -m "feat(blog): add blog API routes"
```

---

## Task 6: Mount Blog Routes and Extend Share Management

**Files:**
- Modify: `src/worker/app.ts`
- Modify: `src/worker/routes/share.ts`

**Interfaces:**
- Consumes: `blogRoutes` from `./blog/routes`
- Produces: `/api/blog` mounted; share `POST /:noteId` accepts `blogPublished` and `ShareInfo` carries it.

- [ ] **Step 1: Mount blog routes in `app.ts`**

Import `blogRoutes` and add `app.route('/api/blog', blogRoutes)` after `app.route('/api/share', shareManageRoutes)` and before `app.route('/api/public', shareRoutes)` (around line 101-102).

- [ ] **Step 2: Extend `shareManageRoutes.POST /:noteId` in `src/worker/routes/share.ts`**

- Read `blogPublished?: boolean` from the body.
- When `blogPublished === true`, set `blog_published = 1` in the INSERT/UPDATE; when `false`, set `0`; when undefined, keep existing value. Add the column to the `ON CONFLICT DO UPDATE` clause guarded by a `?flag` bind like the existing `password_hash`/`expires_at` pattern.
- Update `ShareRow` and `toShareInfo` to include `blogPublished: Boolean(row.blog_published)`.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run unit tests**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/app.ts src/worker/routes/share.ts
git commit -m "feat(blog): mount blog routes and accept blogPublished on shares"
```

---

## Task 7: Blog API Client

**Files:**
- Create: `src/client/blog/api.ts`
- Modify: `src/client/lib/api.ts`

**Interfaces:**
- Consumes: types from `@shared/blog/types`, `CLIENT_HEADER` from `@shared/constants`
- Produces: `blogApi` object with `auth`, `posts`, `post`, `moments`, `timeline`, `tags`, `tag`, `settings`, `updateSettings` methods; `BlogAuthError` class.

- [ ] **Step 1: Implement `src/client/blog/api.ts`**

```typescript
import type {
  BlogPostsResponse, BlogPostDetail, TimelineItem, BlogTag, BlogPostSummary, MomentsResponse,
} from '@shared/blog/types'
import { CLIENT_HEADER } from '@shared/constants'

const BLOG_API = '/api/blog'

export class BlogAuthError extends Error {
  constructor() { super('Blog authentication required') }
}

async function blogFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BLOG_API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: '1', ...init?.headers },
  })
  if (res.status === 401) throw new BlogAuthError()
  if (!res.ok) throw new Error(`Blog API error: ${res.status}`)
  return res.json() as Promise<T>
}

export async function blogLogin(username: string, password: string): Promise<boolean> {
  const res = await fetch(`${BLOG_API}/${encodeURIComponent(username)}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: '1' },
    body: JSON.stringify({ password }),
  })
  return res.ok
}

export const blogApi = {
  auth: blogLogin,
  posts: (username: string, page = 1, limit = 10) =>
    blogFetch<BlogPostsResponse>(`/${encodeURIComponent(username)}/posts?page=${page}&limit=${limit}`),
  post: (username: string, slug: string) =>
    blogFetch<BlogPostDetail>(`/${encodeURIComponent(username)}/posts/${encodeURIComponent(slug)}`),
  moments: (username: string) =>
    blogFetch<MomentsResponse>(`/${encodeURIComponent(username)}/moments`),
  timeline: (username: string) =>
    blogFetch<{ items: TimelineItem[] }>(`/${encodeURIComponent(username)}/timeline`),
  tags: (username: string) =>
    blogFetch<{ tags: BlogTag[] }>(`/${encodeURIComponent(username)}/tags`),
  tag: (username: string, name: string) =>
    blogFetch<{ name: string; posts: BlogPostSummary[] }>(`/${encodeURIComponent(username)}/tags/${encodeURIComponent(name)}`),
  settings: () =>
    blogFetch<{ hasPassword: boolean; title: string | null }>('/settings'),
  updateSettings: (body: { password?: string | null; title?: string }) =>
    blogFetch<{ ok: true }>('/settings', { method: 'PUT', body }),
}
```

- [ ] **Step 2: Extend `api.share.create` in `src/client/lib/api.ts`**

Add `blogPublished?: boolean` to the body type and pass it through (around line 484).

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/client/blog/api.ts src/client/lib/api.ts
git commit -m "feat(blog): add blog API client"
```

---

## Task 8: Blog Router, Shell, and Markdown Components

**Files:**
- Create: `src/client/blog/router.tsx`
- Create: `src/client/blog/styles.css`
- Create: `src/client/blog/components/header.tsx`
- Create: `src/client/blog/components/footer.tsx`
- Create: `src/client/blog/components/feed-card.tsx`
- Create: `src/client/blog/components/markdown.tsx`

**Interfaces:**
- Consumes: `blogApi`, `BlogAuthError` from `./api`, types from `@shared/blog/types`, `renderMarkdown` from `../../lib/markdown/renderer`, `enhancePreview` from `../../lib/markdown/enhance`
- Produces: `BlogApp` (default export of `router.tsx`), `BlogHeader`, `BlogFooter`, `FeedCard`, `BlogMarkdown`.

- [ ] **Step 1: Create `src/client/blog/styles.css`**

Isolated Rin/Hugo-inspired CSS using CSS variables and a `.blog-app` scope. Include a readable article prose style (`.blog-prose`) for rendered Markdown, a card style, a login form style, and responsive nav. It must not depend on the main Inkstone shell styles. (Design freedom: implement a clean, attractive theme; reference Rin/Hugo aesthetics — serif/sans pairing, generous spacing, subtle borders.)

- [ ] **Step 2: Create `src/client/blog/components/markdown.tsx`**

`BlogMarkdown({ content, slug })` renders Markdown with the existing pipeline:

- `renderMarkdown(content)` from `../../lib/markdown/renderer` → `{ html }`.
- Run the same share-scoped post-processing as `SharePage`'s `addShareAccess` (see `src/client/features/share/SharePage.tsx:254-290`): strip note-embed targets, disable task checkboxes, and append `?share=<slug>` to `/api/files/...` image/link URLs.
- `enhancePreview(host, { math: true, mermaid: true, dark })` in a `useEffect` (mirror `SharePage`).
- Output: `<div className="blog-prose" dangerouslySetInnerHTML={{ __html: html }} ref={hostRef} />`.

- [ ] **Step 3: Create `src/client/blog/components/feed-card.tsx`**

`FeedCard({ post })` renders a post summary card: title (link to `/blog/:username/posts/:slug`), excerpt, date, and tag chips. Uses `post` from `@shared/blog/types`.

- [ ] **Step 4: Create `src/client/blog/components/header.tsx` and `footer.tsx`**

`BlogHeader({ username, title })` renders the blog title and nav links (Articles, Timeline, Tags, Moments — relative to the current username). `BlogFooter()` renders a minimal powered-by footer.

- [ ] **Step 5: Create `src/client/blog/router.tsx`**

`BlogApp` — a lightweight sub-router that parses `window.location.pathname`:

- `/blog/:username` → `FeedPage`
- `/blog/:username/posts/:slug` → `PostPage`
- `/blog/:username/moments` → `MomentsPage`
- `/blog/:username/timeline` → `TimelinePage`
- `/blog/:username/tags` → `TagsPage`
- `/blog/:username/tags/:name` → `TagPage`

Use a `useState` + `popstate` pattern (mirror `SharePage`/`SharePanel` navigation style) or plain anchor links with full page loads — simpler is fine. Wrap pages in lazy `Suspense`. Import `./styles.css`. Render `BlogHeader`/`BlogFooter` around the matched page. On `BlogAuthError` from any fetch, render `LoginPage`.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/client/blog/router.tsx src/client/blog/styles.css src/client/blog/components/
git commit -m "feat(blog): add blog router, shell, and markdown components"
```

---

## Task 9: Blog Pages (Feed, Post, Moments, Timeline, Tags, Login)

**Files:**
- Create: `src/client/blog/pages/feed.tsx`
- Create: `src/client/blog/pages/post.tsx`
- Create: `src/client/blog/pages/moments.tsx`
- Create: `src/client/blog/pages/timeline.tsx`
- Create: `src/client/blog/pages/tags.tsx`
- Create: `src/client/blog/pages/tag.tsx`
- Create: `src/client/blog/pages/login.tsx`

**Interfaces:**
- Consumes: `blogApi`, `BlogAuthError` from `../api`, `FeedCard` from `../components/feed-card`, `BlogMarkdown` from `../components/markdown`, types from `@shared/blog/types`

- [ ] **Step 1: Create `src/client/blog/pages/feed.tsx`**

`FeedPage({ username })` — fetches `blogApi.posts(username)`, renders `FeedCard` per post with prev/next pagination. On `BlogAuthError`, render the login form (or navigate to login).

- [ ] **Step 2: Create `src/client/blog/pages/post.tsx`**

`PostPage({ username, slug })` — fetches `blogApi.post(username, slug)`, renders title, date, tags, and `<BlogMarkdown content={post.content} slug={post.slug} />`.

- [ ] **Step 3: Create `src/client/blog/pages/moments.tsx`**

`MomentsPage({ username })` — fetches `blogApi.moments(username)`, renders each moment as a short card with `BlogMarkdown` content and date. If empty, show a subtle "No moments yet" message.

- [ ] **Step 4: Create `src/client/blog/pages/timeline.tsx`**

`TimelinePage({ username })` — fetches `blogApi.timeline(username)`, groups items by year, renders year sections.

- [ ] **Step 5: Create `src/client/blog/pages/tags.tsx` and `tag.tsx`**

`TagsPage({ username })` — fetches `blogApi.tags(username)`, renders tag chips linking to `/blog/:username/tags/:name`. `TagPage({ username, name })` — fetches `blogApi.tag(username, name)`, renders `FeedCard` per post.

- [ ] **Step 6: Create `src/client/blog/pages/login.tsx`**

`LoginPage({ username })` — password form; on submit calls `blogApi.auth(username, password)`, on success reloads to `/blog/:username`. Handles the "owner has no password" case by showing only the public feed (no login form).

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/client/blog/pages/
git commit -m "feat(blog): add blog pages (feed, post, moments, timeline, tags, login)"
```

---

## Task 10: Wire Up App.tsx

**Files:**
- Modify: `src/client/App.tsx`

- [ ] **Step 1: Add `/blog/:username` path branch**

In `src/client/App.tsx`:

- Add a lazy import for `BlogApp` from `./blog/router` (mirror the `SharePage` lazy import at line 15-17).
- Add a `blogPath` check next to the existing `shareSlug` state (around line 24-27): match `/blog/:username` via a regex, capture the username.
- In the `useEffect` that calls `load()` (line 29-32), skip when on a blog path.
- Add the blog render branch **before** the `shareSlug` check (line 54): if `blogPath`, render `<ErrorBoundary><Suspense fallback={<PageFallback />}><BlogApp username={match} /></Suspense></ErrorBoundary>` plus `<Toaster />`.
- Update the other `useEffect`s that check `shareSlug` (dismissBootScreen, requestOfflineWarmup, timeout) to also skip on blog paths.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/client/App.tsx
git commit -m "feat(blog): wire up /blog/:username routing in App.tsx"
```

---

## Task 11: Settings Blog Tab

**Files:**
- Create: `src/client/features/settings/BlogSettings.tsx`
- Modify: `src/client/features/settings/sections.ts`
- Modify: `src/client/features/settings/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `blogApi.settings()` / `blogApi.updateSettings()` from `../../blog/api`

- [ ] **Step 1: Create `src/client/features/settings/BlogSettings.tsx`**

`BlogSettings` — loads `blogApi.settings()`, shows: a text input for the blog title (save on submit), a password field (set / clear), and the blog URL preview `/blog/:username` (from the current session user). Uses the existing settings UI primitives (form fields, buttons) consistent with sibling settings components.

- [ ] **Step 2: Register the blog section in `src/client/features/settings/sections.ts`**

- Add `'blog'` to the `SettingsSection` union type.
- Add `blog: () => import('./BlogSettings').then((m) => ({ default: m.BlogSettings }))` to `settingsLoaders`.

- [ ] **Step 3: Add the Blog tab in `src/client/features/settings/SettingsPanel.tsx`**

Add a `{ id: 'blog', label: ..., icon: ... }` entry to the `SECTIONS` array (use an existing lucide icon like `FileText` or `Rss`). Add the corresponding locale keys (`settings.blog`) to both `src/shared/locales/en-US.ts` and `src/shared/locales/zh-CN.ts`.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Run i18n check**

Run: `npm run i18n:check`
Expected: PASS (both locale files updated together)

- [ ] **Step 6: Commit**

```bash
git add src/client/features/settings/ src/shared/locales/
git commit -m "feat(blog): add Settings Blog tab for password and title"
```

---

## Task 12: Share Panel Publish Toggle

**Files:**
- Modify: `src/client/features/share/SharePanel.tsx`

- [ ] **Step 1: Add a "Publish to blog" toggle**

In `SharePanel.tsx`, add a toggle (consistent with existing `Switch` usage in the panel) bound to `share.blogPublished`. When the user has an existing share, toggling it calls `api.share.create(noteId, { ..., blogPublished: next })` to persist. When no share exists, creating a share with `blogPublished: true` publishes it directly.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/client/features/share/SharePanel.tsx
git commit -m "feat(blog): add publish-to-blog toggle in share panel"
```

---

## Task 13: Integration Testing and Polish

**Files:**
- Test: manual testing via local dev server + E2E conventions

- [ ] **Step 1: Start the local dev server**

Run: `npm run dev`

- [ ] **Step 2: Test blog password setup (Settings tab)**

1. Log in to Inkstone, open Settings → Blog.
2. Set a title and a password; verify `GET /api/blog/settings` reflects them.

- [ ] **Step 3: Test publishing and blog views**

1. Create a note, share it, toggle "Publish to blog" on.
2. Visit `/blog/:username` — with a password set, confirm the login gate appears; enter the password and confirm the article appears.
3. Toggle "Publish to blog" off and confirm the article disappears.
4. Revoke the share and confirm the article disappears.

- [ ] **Step 4: Test public (no-password) blog and moments**

1. Clear the blog password; visit `/blog/:username` — confirm it loads without login.
2. Confirm only passwordless published shares appear.
3. Create a "Moments" folder, put a published note in it — confirm it appears under `/blog/:username/moments`.

- [ ] **Step 5: Test auth failure paths**

1. Wrong blog password → 401 / "Invalid blog password".
2. Unknown username → 404.

- [ ] **Step 6: Test upstream merge safety**

```bash
git remote add upstream https://github.com/shuaiplus/inkstone.git
git fetch upstream
git checkout -b test-merge main
git merge upstream/main
# Verify only expected files conflict (schema.ts, app.ts, App.tsx, api.ts, sections.ts, SettingsPanel.tsx, SharePanel.tsx, share.ts)
git checkout main
git branch -D test-merge
```

- [ ] **Step 7: Final commit with any fixes**

```bash
git add -A
git commit -m "fix(blog): integration test fixes and polish"
```


