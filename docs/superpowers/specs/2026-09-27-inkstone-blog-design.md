# Inkstone Blog Design

> **Purpose:** Add a password-protected, per-user private blog publishing channel to Inkstone by fully reusing the existing `shares` mechanism. Notes are published to a blog by marking their share as `blog_published`; no new data tables, no write-sync hooks, no front-matter coupling.

## Background and Motivation

Inkstone is a self-hosted Markdown notebook on Cloudflare Workers (D1, R2, Hono, React). It already provides a per-note public share feature: the `shares` table stores `slug, note_id, user_id, password_hash, expires_at, views, created_at`, exposed via `shareManageRoutes` (create/read/revoke), `shareRoutes` (public read by slug with optional password), and `sharePageRoutes` (`/s/:slug` rendering).

The goal is a blog publishing channel where a user can designate specific notes as blog articles, protected by a single per-user blog password (or public). The design reuses the share mechanism as the single source of truth so that:
- There is no separate blog-post table, no sync hooks on note writes, and no dependence on note front matter.
- Multi-account isolation falls out of the existing `user_id` column on `shares`.
- Conflict surface with upstream Inkstone releases is minimal (a single new column + isolated new files).

## Requirements

1. **Per-user independent blogs.** Each account has its own blog reachable at `/blog/:username`. Only that user's published shares appear.
2. **Password-protected or public.** Each user may set one blog password (stored per-user, empty allowed).
   - Password set: visitor must enter it to view the blog; on success a blog-session cookie is set.
   - Password empty (public blog): visitor enters directly, but only sees that user's published shares that have **no share password** (`password_hash` null). Published shares that carry their own share password are not listed on a public blog.
3. **Publishing model.** A note is published to the blog by setting `blog_published = 1` on its share (a toggle in the share panel). Revoking the share or setting `blog_published = 0` removes it from the blog. Expired shares (`expires_at` past) are excluded from blog listings.
4. **Moments.** Notes inside the user's root-level folder named `Moments` (`folders.name = 'Moments' AND folders.parent_id IS NULL AND folders.deleted_at IS NULL`) that are also published to the blog appear in the blog's Moments area as short, title-less cards. If no such folder or no moments, the Moments area is hidden.
5. **Timeline.** A time-grouped listing of blog posts (grouped by year), using the share/note creation time.
6. **Styling.** Blog UI is a distinct, pleasant theme inspired by Rin / Hugo; article detail rendering reuses Inkstone's existing Markdown pipeline (markdown-it + `enhancePreview` + Mermaid + attachment share-parameter injection).
7. **Scope exclusion.** Comments, blogroll, RSS/Atom, SEO/OpenGraph, featured-image extraction, and GitHub-OAuth authoring are out of scope for this phase to keep the merge surface small. Blog password management lives in the share panel.
8. **Multi-account correctness.** Blog listings are always scoped by `shares.user_id` matching the blog owner. Blog session cookies are scoped per blog owner.

## Architecture

### Data model

The only schema change is one new column on the existing `shares` table (a new D1 migration; upstream `main` is at schema version 12, so the new migration is version 13):

```sql
ALTER TABLE shares ADD COLUMN blog_published INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_shares_blog ON shares(user_id, blog_published, created_at DESC);
```

- `blog_published = 1` → the share's note is published on the blog.
- All other blog data (slug, note id, user id, password hash, expiry, timestamps) comes from existing `shares` columns.
- `REQUIRED_COLUMNS` and `REQUIRED_TABLES`/`REQUIRED_INDEXES` in `src/worker/db/schema.ts` are updated accordingly.

Per-user blog password is stored in the existing `app_meta` table with a user-scoped key: `blog_password_hash:<userId>` (scrypt hash via existing `hashPassword`/`verifyPassword`).

### Server (`src/worker/blog/`)

New isolated directory `src/worker/blog/`:

- `blog/auth.ts`
  - `setBlogPassword(db, userId, password)`, `hasBlogPassword(db, userId)`
  - `handleBlogAuth(db, userId, password) => token | null`
  - `validateBlogSession(db, token, userId) => boolean`
  - `blogAuthMiddleware` — checks the blog-session cookie for the blog owner; 401 otherwise.
  - Cookie: `blog_session_<userId>` (per-owner), `HttpOnly`, `SameSite=Strict`, secure on https, 30-day TTL. Token stored in `app_meta` under `blog_session:<userId>:<token>` with expiry.
- `blog/queries.ts`
  - `listBlogPosts(db, userId, { onlyPublic })` → posts (title, slug, excerpt, created_at, updated_at, tags), excluding `notes.deleted_at IS NOT NULL`, excluding expired shares, and when `onlyPublic` also excluding `shares.password_hash IS NOT NULL`. Sorted by share creation desc.
  - `getBlogPost(db, userId, slug)` → single post detail (content included), same filters.
  - `listBlogMoments(db, userId, { onlyPublic })` → notes in the user's root `Moments` folder that are published, same filters.
  - `listBlogTimeline(db, userId, { onlyPublic })` → posts grouped by year.
  - `listBlogTags(db, userId, { onlyPublic })` → tag counts across published posts.
  - `getBlogOwner(db, username) => userId | null` (lookup by `users.username`).
- `blog/routes.ts`
  - `POST /api/blog/:username/auth` — password → sets blog-session cookie.
  - `GET /api/blog/:username/posts`, `/posts/:slug`, `/moments`, `/timeline`, `/tags` — public read endpoints (no Inkstone session), gated by `blogAuthMiddleware` when the owner has a password set.
  - Mounted in `app.ts` at `/api/blog`.
- Note on global middleware: `app.use('/api/*', requireClientHeader)` only enforces the `X-Inkstone-Client: 1` header for non-GET/HEAD/OPTIONS methods (`src/worker/middleware/auth.ts`). Blog public read endpoints are all GET → no header required. Only `POST /api/blog/:username/auth` and authenticated settings endpoints (`PUT/GET`) require the header; the blog frontend sends it, consistent with the rest of the UI. `loadSession` is also global on `/api/*` but is optional (does not block anonymous).
- Blog password settings endpoints use the Inkstone session (`requireAuth`) and are registered on `blogRoutes` **before** `blogAuthMiddleware`, so they are reachable only by the logged-in owner: `PUT /api/blog/settings` (set/clear password), `GET /api/blog/settings` (has password).

### Modifying existing server files

- `src/worker/db/schema.ts` — add migration 13 (`blog_published` column + index), update `REQUIRED_COLUMNS` for `shares` and `REQUIRED_INDEXES`.
- `src/worker/routes/share.ts` — `shareManageRoutes.POST /:noteId` accepts `blogPublished?: boolean`; set/clear the column. `toShareInfo` includes `blogPublished`.
- `src/worker/app.ts` — mount `app.route('/api/blog', blogRoutes)`.

### Client (`src/client/blog/`)

New isolated directory `src/client/blog/` with a lightweight sub-router and Rin/Hugo-inspired styling (isolated CSS using CSS variables; does not depend on the main Inkstone shell). Pages:

- `/blog/:username` — feed (article list) + login gate when the owner has a password.
- `/blog/:username/posts/:slug` — article detail; renders via the existing Markdown pipeline (reuse `renderMarkdown` + `enhancePreview` + Mermaid from `src/client/lib/markdown/`, and attachment `share` parameter injection from `SharePage`).
- `/blog/:username/moments` — moments cards (hidden if none).
- `/blog/:username/timeline` — year-grouped timeline.
- `/blog/:username/tags` and `/blog/:username/tags/:name` — tag index and tag-filtered posts.

Client API wrapper `src/client/blog/api.ts` (`fetch`-based, sends `X-Inkstone-Client: 1`).

`src/client/App.tsx` — add a `/blog/:username` path branch (before the share-slug check) that renders `BlogApp` without the notebook shell; skip session `load()` on blog paths.

`src/client/features/share/SharePanel.tsx` — add a "Publish to blog" toggle writing `blogPublished`.

### Authentication flows

- **Blog owner sets a password:** from authenticated Inkstone UI (`PUT /api/blog/settings` with Inkstone session) or via share panel; stores scrypt hash in `app_meta[blog_password_hash:<userId>]`.
- **Visitor opens `/blog/:username`:**
  - Owner has no password → public blog; client loads with `onlyPublic = true` (only passwordless shares listed).
  - Owner has password → show password form; submit → `POST /api/blog/:username/auth` → blog-session cookie → client loads with full list.
  - Server enforces: if owner has a password and no valid blog-session cookie → 401 on content endpoints; if owner has no password → endpoints return only public (passwordless) shares, no cookie needed.

### Error handling

- Unknown username → 404.
- Wrong blog password → 401 `invalid_credentials`.
- Expired share / deleted note → excluded from listings and detail (404 for detail).
- Blog API endpoints reuse Inkstone's `ApiError`/`errorResponse` conventions.

### Testing

- Unit tests (Vitest, mirroring `tests/` patterns):
  - `sync`/queries filtering: excludes soft-deleted notes, excludes expired shares, `onlyPublic` excludes password-protected shares.
  - `getBlogPost` by slug and unknown slug → null.
  - Blog auth: correct/incorrect/no-password-set cases; session token valid/invalid/expired.
  - `Moments` folder detection (root `Moments` folder, deleted folders excluded).
- E2E against a disposable local instance per the project's `test:e2e` convention, covering: publish toggle, public blog (empty password), password-protected blog, moments, timeline.

## File Structure

### New files

```
src/worker/blog/auth.ts
src/worker/blog/queries.ts
src/worker/blog/routes.ts
src/client/blog/api.ts
src/client/blog/router.tsx
src/client/blog/styles.css
src/client/blog/pages/feed.tsx
src/client/blog/pages/post.tsx
src/client/blog/pages/moments.tsx
src/client/blog/pages/timeline.tsx
src/client/blog/pages/tags.tsx
src/client/blog/pages/login.tsx
src/client/blog/components/header.tsx
src/client/blog/components/footer.tsx
src/client/blog/components/feed-card.tsx
src/client/blog/components/markdown.tsx
tests/blog-auth.test.ts
tests/blog-queries.test.ts
```

### Modified existing files

| File | Change |
|---|---|
| `src/worker/db/schema.ts` | Migration 13 (`blog_published` + index); `REQUIRED_COLUMNS`/`REQUIRED_INDEXES` |
| `src/worker/routes/share.ts` | Accept `blogPublished`; include in `toShareInfo` |
| `src/worker/app.ts` | Mount `/api/blog` |
| `src/client/App.tsx` | `/blog/:username` branch, skip notebook load on blog paths |
| `src/client/features/share/SharePanel.tsx` | "Publish to blog" toggle |

## Explicitly Out of Scope

- Comments, blogroll, RSS/Atom, SEO/OpenGraph tags, featured/cover images.
- Publishing via GitHub OAuth or MCP.
- Blog themes/plugins beyond the single Rin/Hugo-inspired style.

## Open Decisions (defaults chosen)

- Blog password management UI surface: a "Blog" section in the share panel (`SharePanel`), next to the "Publish to blog" toggle. It calls `PUT/GET /api/blog/settings` with the Inkstone session.
- Blog path identifier is `users.username` (unique); URL-encoding handled at routes.
