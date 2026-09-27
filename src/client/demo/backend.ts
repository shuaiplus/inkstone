import { Hono } from 'hono'
import { APP_VERSION, LIMITS, mergeSettingsPatch } from '@shared/constants'
import { duplicateNoteTitle, utf8ByteLength } from '@shared/text-utils'
import { organizerColorOrNull } from '@shared/organizer-colors'
import {
  deriveExcerpt,
  deriveTitle,
  extractAttachmentIds,
  extractWikiLinks,
  normalizeLinkKey,
  replaceTagInContent,
  wikiNoteTarget,
} from '@shared/markdown-utils'
import type {
  BackupMode,
  BackupRun,
  BackupTarget,
  BackupTargetConfig,
  BackupTargetInput,
  BackupTargetPatchInput,
  ExportAttachment,
  ExportBundle,
  Folder,
  GraphResponse,
  ImportResult,
  McpSettingsInfo,
  Note,
  NoteVersion,
  PublicNote,
  SearchResponse,
  SessionInfo,
  ShareInfo,
  SyncResponse,
} from '@shared/types'
import { createZip, readZip } from '@shared/zip'
import { DEMO_CREDENTIALS } from '../lib/runtime'
import {
  createDemoState,
  listFolders,
  listTags,
  newDemoId,
  refreshNote,
  summarize,
  type DemoState,
} from './state'

interface DemoBackend {
  fetch: (request: Request) => Promise<Response>
}

export function createDemoBackend(): DemoBackend {
  const state = createDemoState()
  const app = new Hono()

  app.use('/api/*', async (c, next) => {
    const path = c.req.path
    if (
      path === '/api/site' ||
      path === '/api/auth/session' ||
      path === '/api/auth/login' ||
      path.startsWith('/api/public/')
    ) {
      return next()
    }
    if (!state.authenticated) return apiError(401, 'unauthenticated', 'Please sign in first')
    return next()
  })

  app.get('/api/site', (c) => c.json(siteInfo(state)))
  app.get('/api/auth/session', (c) => c.json(sessionInfo(state)))
  app.post('/api/auth/login', async (c) => {
    const body = await jsonBody(c.req.raw)
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (username !== DEMO_CREDENTIALS.username || password !== state.password) {
      return apiError(401, 'invalid_credentials', 'Invalid username or password')
    }
    state.authenticated = true
    return c.json(sessionInfo(state))
  })
  app.post('/api/auth/register', () => apiError(403, 'registration_closed', 'Registration is closed'))
  app.post('/api/auth/logout', (c) => {
    state.authenticated = false
    return c.json({ ok: true as const })
  })
  app.get('/api/auth/totp/status', (c) => c.json({
    available: false,
    enabled: false,
    enabledAt: null,
    recoveryCodesRemaining: 0,
  }))
  app.post('/api/auth/password', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.currentPassword !== state.password) {
      return apiError(401, 'wrong_password', 'The current password is incorrect')
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) {
      return apiError(400, 'weak_password', 'The new password must contain at least 8 characters')
    }
    if (body.newPassword.length > LIMITS.passwordMaxLength) {
      return apiError(400, 'weak_password', 'The new password is too long')
    }
    state.password = body.newPassword
    return c.json({ ok: true as const })
  })
  app.put('/api/auth/profile', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 64) {
        return apiError(400, 'invalid_profile_name', 'Enter a valid display name')
      }
      state.user = { ...state.user, name: body.name.trim().replace(/\s+/g, ' ') }
    }
    if (body.avatarUrl !== undefined) {
      if (
        typeof body.avatarUrl !== 'string' ||
        !(
          body.avatarUrl === '' ||
          /^dicebear:[0-9a-f]{32}$/.test(body.avatarUrl) ||
          /^data:image\/(?:png|jpeg|webp);base64,/.test(body.avatarUrl)
        )
      ) {
        return apiError(400, 'invalid_avatar', 'Choose a generated avatar or upload an image')
      }
      state.user = { ...state.user, avatarUrl: body.avatarUrl }
    }
    state.cursor++
    return c.json(state.user)
  })
  app.put('/api/settings/registration', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.password !== state.password) {
      return apiError(401, 'wrong_password', 'The current password is incorrect')
    }
    state.registrationOpen = body.enabled === true
    return c.json({ ok: true as const, registrationOpen: state.registrationOpen })
  })

  app.get('/api/mcp', (c) => c.json(demoMcpSettings()))
  app.all('/api/mcp', () => apiError(403, 'forbidden', 'MCP is display-only in the demo'))
  app.all('/api/mcp/*', () => apiError(403, 'forbidden', 'MCP is display-only in the demo'))

  app.get('/api/notes', (c) => {
    const query = c.req.query()
    let notes = [...state.notes.values()]
    const view = query.view ?? 'all'
    if (view === 'trash') notes = notes.filter((note) => note.deletedAt !== null)
    else {
      notes = notes.filter((note) => note.deletedAt === null)
      if (view === 'starred') notes = notes.filter((note) => note.isStarred)
      if (view === 'unfiled') notes = notes.filter((note) => note.folderId === null)
      if (view === 'archived') notes = notes.filter((note) => note.isArchived)
      if (view === 'folder') notes = notes.filter((note) => note.folderId === query.folderId)
      if (view === 'tag') notes = notes.filter((note) => note.tags.includes(query.tag ?? ''))
      if (view === 'all' || view === 'recent') notes = notes.filter((note) => !note.isArchived)
    }
    const sort = query.sort ?? 'updated'
    const direction = query.order === 'asc' ? 1 : -1
    notes.sort((left, right) => {
      const compared = sort === 'title'
        ? left.title.localeCompare(right.title)
        : sort === 'created'
          ? left.createdAt - right.createdAt
          : left.updatedAt - right.updatedAt
      return compared * direction
    })
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 100))
    return c.json({ notes: notes.slice(0, limit).map(summarize), nextCursor: null, total: notes.length })
  })
  app.post('/api/notes', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.id !== undefined && (typeof body.id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(body.id))) {
      return apiError(400, 'bad_request', 'id must be a valid note id')
    }
    const requestedId = typeof body.id === 'string' ? body.id : newDemoId()
    const existing = state.notes.get(requestedId)
    if (existing) return c.json(existing)
    const content = typeof body.content === 'string' ? body.content : ''
    if (utf8ByteLength(content) > LIMITS.contentMaxBytes) {
      return apiError(413, 'payload_too_large', 'Note content exceeds the 2 MB limit')
    }
    const now = Date.now()
    const base: Note = {
      id: requestedId,
      title: '',
      excerpt: '',
      content: '',
      folderId: typeof body.folderId === 'string' && state.folders.has(body.folderId) ? body.folderId : null,
      tags: [],
      isPinned: false,
      isStarred: body.isStarred === true,
      isArchived: false,
      wordCount: 0,
      charCount: 0,
      rev: 1,
      position: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    const created = refreshNote(base, content, typeof body.title === 'string' ? body.title : undefined)
    state.notes.set(created.id, created)
    state.cursor++
    return c.json(created, 201)
  })
  app.post('/api/notes/trash/empty', (c) => {
    const ids = [...state.notes.values()].filter((note) => note.deletedAt !== null).map((note) => note.id)
    for (const id of ids) purgeNote(state, id)
    return c.json({ purged: ids.length })
  })
  app.get('/api/notes/:id/versions', (c) => {
    const versions = state.versions.get(c.req.param('id')) ?? []
    return c.json({ versions: versions.map(({ content: _content, ...meta }) => meta) })
  })
  app.get('/api/notes/:id/versions/:versionId', (c) => {
    const version = findVersion(state, c.req.param('id'), c.req.param('versionId'))
    return version ? c.json(version) : apiError(404, 'not_found', 'Version not found')
  })
  app.post('/api/notes/:id/versions/:versionId/restore', (c) => {
    const id = c.req.param('id')
    const current = state.notes.get(id)
    const version = findVersion(state, id, c.req.param('versionId'))
    if (!current || !version) return apiError(404, 'not_found', 'Version not found')
    saveVersion(state, current)
    const restored = refreshNote(
      { ...current, rev: current.rev + 1, updatedAt: Date.now() },
      version.content,
      version.title,
    )
    state.notes.set(id, restored)
    state.cursor++
    return c.json(restored)
  })
  app.get('/api/notes/:id/backlinks', (c) => {
    const target = state.notes.get(c.req.param('id'))
    if (!target) return apiError(404, 'not_found', 'Note not found')
    const key = normalizeLinkKey(target.title)
    const backlinks = [...state.notes.values()]
      .filter((note) => note.id !== target.id && extractWikiLinks(note.content).some((link) => link.key === key))
      .map((note) => ({ id: note.id, title: note.title, context: deriveExcerpt(note.content, 120) }))
    return c.json({ backlinks })
  })
  app.post('/api/notes/:id/restore', (c) => {
    const note = state.notes.get(c.req.param('id'))
    if (!note) return apiError(404, 'not_found', 'Note not found')
    const restored = { ...note, deletedAt: null, updatedAt: Date.now(), rev: note.rev + 1 }
    state.notes.set(note.id, restored)
    state.cursor++
    return c.json(restored)
  })
  app.post('/api/notes/:id/duplicate', async (c) => {
    const source = state.notes.get(c.req.param('id'))
    if (!source) return apiError(404, 'not_found', 'Note not found')
    const body = await jsonBody(c.req.raw)
    if (body.id !== undefined && (typeof body.id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(body.id))) {
      return apiError(400, 'bad_request', 'id must be a valid note id')
    }
    const id = typeof body.id === 'string' ? body.id : newDemoId()
    const existing = state.notes.get(id)
    if (existing) return c.json(existing)
    const now = Date.now()
    const copy = refreshNote(
      {
        ...source,
        id,
        rev: 1,
        createdAt: now,
        updatedAt: now,
        position: now,
        deletedAt: null,
      },
      source.content,
      duplicateNoteTitle(source.title, LIMITS.titleMaxLength),
    )
    state.notes.set(copy.id, copy)
    state.cursor++
    return c.json(copy, 201)
  })
  app.delete('/api/notes/:id/purge', (c) => {
    const id = c.req.param('id')
    if (!state.notes.has(id)) return apiError(404, 'not_found', 'Note not found')
    purgeNote(state, id)
    return c.json({ ok: true as const, cursor: state.cursor })
  })
  app.get('/api/notes/:id', (c) => {
    const note = state.notes.get(c.req.param('id'))
    return note ? c.json(note) : apiError(404, 'not_found', 'Note not found')
  })
  app.patch('/api/notes/:id', async (c) => {
    const id = c.req.param('id')
    const note = state.notes.get(id)
    if (!note) return apiError(404, 'not_found', 'Note not found')
    const body = await jsonBody(c.req.raw)
    if (body.rev !== note.rev) {
      return apiError(409, 'conflict', 'The note changed on another device', { server: note })
    }
    const nextContent = typeof body.content === 'string' ? body.content : note.content
    if (utf8ByteLength(nextContent) > LIMITS.contentMaxBytes) {
      return apiError(413, 'payload_too_large', 'Note content exceeds the 2 MB limit')
    }
    if (typeof body.content === 'string' || typeof body.title === 'string') saveVersion(state, note)
    let updated = refreshNote(
      {
        ...note,
        folderId: body.folderId === null
          ? null
          : typeof body.folderId === 'string' && state.folders.has(body.folderId)
            ? body.folderId
            : note.folderId,
        isPinned: typeof body.isPinned === 'boolean' ? body.isPinned : note.isPinned,
        isStarred: typeof body.isStarred === 'boolean' ? body.isStarred : note.isStarred,
        isArchived: typeof body.isArchived === 'boolean' ? body.isArchived : note.isArchived,
        rev: note.rev + 1,
        updatedAt: Date.now(),
      },
      nextContent,
      typeof body.title === 'string' ? body.title : undefined,
    )
    state.notes.set(id, updated)
    state.cursor++
    return c.json(updated)
  })
  app.delete('/api/notes/:id', (c) => {
    const note = state.notes.get(c.req.param('id'))
    if (!note) return apiError(404, 'not_found', 'Note not found')
    const removed = { ...note, deletedAt: Date.now(), updatedAt: Date.now(), rev: note.rev + 1 }
    state.notes.set(note.id, removed)
    state.cursor++
    return c.json(removed)
  })

  app.get('/api/folders', (c) => c.json({ folders: listFolders(state) }))
  app.post('/api/folders', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.id !== undefined && (typeof body.id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(body.id))) {
      return apiError(400, 'bad_request', 'id must be a valid folder id')
    }
    const requestedId = typeof body.id === 'string' ? body.id : null
    const existing = requestedId ? state.folders.get(requestedId) : null
    if (existing) return c.json(existing)
    const parentId = body.parentId === null || body.parentId === undefined
      ? null
      : typeof body.parentId === 'string' && state.folders.has(body.parentId)
        ? body.parentId
        : undefined
    if (parentId === undefined) return apiError(400, 'bad_request', 'The parent folder does not exist')
    if (parentId && demoFolderDepth(state, parentId) >= LIMITS.folderDepthMax) {
      return apiError(400, 'bad_request', `Folder depth cannot exceed ${LIMITS.folderDepthMax} levels`)
    }
    const now = Date.now()
    const siblings = demoFolderSiblings(state, parentId)
    const requestedName = typeof body.name === 'string' ? body.name.trim() : ''
    if (requestedName.length > LIMITS.folderNameMaxLength) {
      return apiError(400, 'bad_request', 'Folder name is too long')
    }
    const name = requestedName || availableDemoFolderName(siblings, 'New folder')
    if (siblings.some((folder) => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return apiError(409, 'conflict', 'A sibling already uses this name')
    }
    const folder: Folder = {
      id: requestedId ?? newDemoId(),
      parentId,
      name,
      icon: typeof body.icon === 'string' ? body.icon : null,
      color: organizerColorOrNull(body.color),
      position: (siblings.at(-1)?.position ?? 0) + 1000,
      createdAt: now,
      updatedAt: now,
      noteCount: 0,
    }
    state.folders.set(folder.id, folder)
    state.cursor++
    return c.json(folder, 201)
  })
  app.patch('/api/folders/:id', async (c) => {
    const current = state.folders.get(c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Folder not found')
    const body = await jsonBody(c.req.raw)
    if ('beforeId' in body && !('parentId' in body)) {
      return apiError(400, 'bad_request', 'parentId is required when reordering a folder')
    }
    const parentId = body.parentId === undefined
      ? current.parentId
      : body.parentId === null
        ? null
        : typeof body.parentId === 'string' && state.folders.has(body.parentId)
          ? body.parentId
          : undefined
    if (parentId === undefined) return apiError(400, 'bad_request', 'The parent folder does not exist')
    if (parentId === current.id || folderDescendants(state, current.id).has(parentId ?? '')) {
      return apiError(400, 'bad_request', 'A folder cannot be moved into its own descendant')
    }
    if ((parentId ? demoFolderDepth(state, parentId) : 0) + demoFolderHeight(state, current.id) > LIMITS.folderDepthMax) {
      return apiError(400, 'bad_request', `Folder depth cannot exceed ${LIMITS.folderDepthMax} levels`)
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : current.name
    if (name.length > LIMITS.folderNameMaxLength) {
      return apiError(400, 'bad_request', 'Folder name is too long')
    }
    if (demoFolderSiblings(state, parentId, current.id).some(
      (folder) => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )) return apiError(409, 'conflict', 'A sibling already uses this name')
    const updated: Folder = {
      ...current,
      name,
      parentId,
      icon: body.icon === null || typeof body.icon === 'string' ? body.icon : current.icon,
      color: 'color' in body ? organizerColorOrNull(body.color) : current.color,
      updatedAt: Date.now(),
    }
    const shouldPlace = 'beforeId' in body || parentId !== current.parentId
    if (shouldPlace) {
      const siblings = demoFolderSiblings(state, parentId, current.id)
      const beforeId = body.beforeId === null || body.beforeId === undefined
        ? null
        : typeof body.beforeId === 'string'
          ? body.beforeId
          : undefined
      if (beforeId === undefined || beforeId === current.id) {
        return apiError(400, 'bad_request', 'The target folder is invalid')
      }
      const index = beforeId === null ? siblings.length : siblings.findIndex((folder) => folder.id === beforeId)
      if (index < 0) return apiError(400, 'bad_request', 'The target folder is not in the destination')
      siblings.splice(index, 0, updated)
      siblings.forEach((folder, orderIndex) => {
        state.folders.set(folder.id, {
          ...folder,
          parentId,
          position: (orderIndex + 1) * 1000,
          updatedAt: folder.id === updated.id ? updated.updatedAt : folder.updatedAt,
        })
      })
    } else {
      state.folders.set(updated.id, updated)
    }
    state.cursor++
    return c.json(state.folders.get(updated.id)!)
  })
  app.delete('/api/folders/:id', (c) => {
    const root = state.folders.get(c.req.param('id'))
    if (!root) return apiError(404, 'not_found', 'Folder not found')
    const strategy = c.req.query('strategy') === 'delete' ? 'delete' : 'move-up'
    const descendants = folderDescendants(state, root.id)
    if (strategy === 'delete') {
      const now = Date.now()
      for (const note of state.notes.values()) {
        if (descendants.has(note.folderId ?? '')) {
          state.notes.set(note.id, { ...note, folderId: null, deletedAt: now, updatedAt: now, rev: note.rev + 1 })
        }
      }
      for (const id of descendants) state.folders.delete(id)
    } else {
      promoteDemoFolderChildren(state, root)
      for (const note of state.notes.values()) {
        if (note.folderId === root.id) state.notes.set(note.id, { ...note, folderId: root.parentId })
      }
      state.folders.delete(root.id)
    }
    state.cursor++
    return c.json({ ok: true as const })
  })

  app.get('/api/tags', (c) => c.json({ tags: listTags(state) }))
  app.post('/api/tags', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.id !== undefined && (typeof body.id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(body.id))) {
      return apiError(400, 'bad_request', 'id must be a valid tag id')
    }
    const requestedId = typeof body.id === 'string' ? body.id : null
    const existingById = requestedId ? listTags(state).find((tag) => tag.id === requestedId) : null
    if (existingById) return c.json(existingById)
    const name = typeof body.name === 'string' ? body.name.trim().replace(/^#+/, '') : ''
    if (!name || /[\s#]/.test(name) || name.length > LIMITS.tagNameMaxLength) {
      return apiError(400, 'bad_request', 'Tag name is invalid')
    }
    const existing = listTags(state).find((tag) =>
      tag.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0)
    if (existing) return apiError(409, 'conflict', 'A tag with this name already exists')
    const id = requestedId ?? newDemoId()
    state.tagIds.set(name, id)
    state.tagColors.set(name, body.color === null || typeof body.color === 'string' ? body.color : null)
    state.cursor++
    return c.json(listTags(state).find((tag) => tag.id === id)!, 201)
  })
  app.patch('/api/tags/:id', async (c) => {
    const current = listTags(state).find((tag) => tag.id === c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Tag not found')
    const body = await jsonBody(c.req.raw)
    if (typeof body.color === 'string' && !/^#[0-9a-f]{6}$/i.test(body.color)) {
      return apiError(400, 'bad_request', 'Tag color must be a six-digit hexadecimal color')
    }
    if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== current.name) {
      const requestedName = body.name.trim().replace(/^#/, '')
      const existing = listTags(state).find((tag) => tag.id !== current.id
        && tag.name.localeCompare(requestedName, undefined, { sensitivity: 'base' }) === 0)
      const nextName = existing?.name ?? requestedName
      let renamed = 0
      for (const note of state.notes.values()) {
        const content = replaceTagInContent(note.content, current.name, nextName)
        if (content === note.content) continue
        state.notes.set(note.id, refreshNote({ ...note, rev: note.rev + 1, updatedAt: Date.now() }, content))
        renamed++
      }
      state.tagIds.delete(current.name)
      if (!existing) state.tagIds.set(nextName, current.id)
      state.tagColors.set(nextName, body.color === null || typeof body.color === 'string'
        ? body.color
        : state.tagColors.get(nextName) ?? state.tagColors.get(current.name) ?? null)
      state.tagColors.delete(current.name)
      state.cursor++
      return c.json({ ok: true as const, renamed })
    }
    if (body.color === null || typeof body.color === 'string') state.tagColors.set(current.name, body.color)
    state.cursor++
    return c.json(listTags(state).find((tag) => tag.id === current.id) ?? current)
  })
  app.delete('/api/tags/:id', (c) => {
    const current = listTags(state).find((tag) => tag.id === c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Tag not found')
    let affected = 0
    for (const note of state.notes.values()) {
      const content = replaceTagInContent(note.content, current.name, null)
      if (content === note.content) continue
      state.notes.set(note.id, refreshNote({ ...note, rev: note.rev + 1, updatedAt: Date.now() }, content))
      affected++
    }
    state.tagIds.delete(current.name)
    state.tagColors.delete(current.name)
    state.cursor++
    return c.json({ ok: true as const, affected })
  })

  app.get('/api/search', (c) => {
    const started = performance.now()
    const query = (c.req.query('q') ?? '').trim()
    const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 50))
    const needle = query.toLocaleLowerCase()
    const results = [...state.notes.values()]
      .filter((note) => note.deletedAt === null && `${note.title}\n${note.content}`.toLocaleLowerCase().includes(needle))
      .slice(0, limit)
      .map((note) => ({ note: summarize(note), snippet: deriveExcerpt(note.content, 140), score: 1 }))
    const response: SearchResponse = {
      results,
      mode: 'like',
      took: Math.max(0, performance.now() - started),
      query: { text: query, tags: [], folder: null, starred: null, archived: null },
    }
    return c.json(response)
  })
  app.post('/api/search/reindex', (c) => c.json({ ok: true as const, indexed: state.notes.size }))
  app.get('/api/graph', (c) => {
    const mode = c.req.query('mode') === 'local' ? 'local' : 'global'
    const centerId = c.req.query('center') || null
    const depth = Math.max(1, Math.min(3, Number(c.req.query('depth')) || 1))
    const limit = Math.max(50, Math.min(600, Number(c.req.query('limit')) || 350))
    const needle = (c.req.query('q') ?? '').trim().toLocaleLowerCase()
    const folderId = c.req.query('folderId') ?? ''
    const tag = (c.req.query('tag') ?? '').trim().toLocaleLowerCase()
    const includeOrphans = c.req.query('includeOrphans') !== '0'
    const includeUnresolved = c.req.query('includeUnresolved') === '1'
    const active = [...state.notes.values()]
      .filter((note) => note.deletedAt === null && !note.isArchived)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const byTitle = new Map<string, Note>()
    for (const note of active) {
      const key = normalizeLinkKey(note.title)
      if (!byTitle.has(key)) byTitle.set(key, note)
    }
    const linkRecords = active.flatMap((note) => extractWikiLinks(note.content).map((link) => ({
      source: note.id,
      target: byTitle.get(link.key)?.id ?? null,
      key: link.key,
      title: wikiNoteTarget(link.target),
    })))
    const allEdges = linkRecords
      .filter((link): link is typeof link & { target: string } => Boolean(link.target && link.target !== link.source))
      .map((link) => ({ source: link.source, target: link.target }))
    const uniqueEdges = [...new Map(allEdges.map((edge) => [`${edge.source}>${edge.target}`, edge])).values()]
    const degree = new Map<string, number>()
    const incoming = new Map<string, number>()
    const outgoing = new Map<string, number>()
    for (const edge of uniqueEdges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
      outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1)
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    }
    let allowed = new Set(active.map((note) => note.id))
    if (mode === 'local' && centerId) {
      allowed = new Set([centerId])
      let frontier = new Set([centerId])
      for (let level = 0; level < depth; level++) {
        const next = new Set<string>()
        for (const edge of uniqueEdges) {
          if (frontier.has(edge.source) && !allowed.has(edge.target)) next.add(edge.target)
          if (frontier.has(edge.target) && !allowed.has(edge.source)) next.add(edge.source)
        }
        for (const id of next) allowed.add(id)
        frontier = next
      }
    }
    const filtered = active.filter((note) => allowed.has(note.id)
      && (!needle || note.title.toLocaleLowerCase().includes(needle))
      && (!folderId || note.folderId === folderId)
      && (!tag || note.tags.some((name) => name.toLocaleLowerCase() === tag))
      && (includeOrphans || (degree.get(note.id) ?? 0) > 0))
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || b.updatedAt - a.updatedAt)
    const shown = filtered.slice(0, limit)
    const shownIds = new Set(shown.map((note) => note.id))
    const edges = uniqueEdges.filter((edge) => shownIds.has(edge.source) && shownIds.has(edge.target))
    const folders = new Map(listFolders(state).map((folder) => [folder.id, folder]))
    const nodes: GraphResponse['nodes'] = shown.map((note) => ({
      id: note.id,
      title: note.title,
      kind: 'note' as const,
      degree: degree.get(note.id) ?? 0,
      inDegree: incoming.get(note.id) ?? 0,
      outDegree: outgoing.get(note.id) ?? 0,
      folderId: note.folderId,
      folderName: note.folderId ? folders.get(note.folderId)?.name ?? null : null,
      folderColor: note.folderId ? folders.get(note.folderId)?.color ?? null : null,
      tags: note.tags.map((name) => ({ name, color: state.tagColors.get(name) ?? null })),
    }))
    const unresolved = new Map<string, { title: string; sources: Set<string> }>()
    if (includeUnresolved) {
      for (const link of linkRecords) {
        if (link.target !== null || !shownIds.has(link.source)) continue
        if (unresolved.size >= 50 && !unresolved.has(link.key)) continue
        const missing = unresolved.get(link.key) ?? { title: link.title, sources: new Set<string>() }
        missing.sources.add(link.source)
        unresolved.set(link.key, missing)
      }
      for (const [key, missing] of unresolved) {
        const id = `unresolved:${key}`
        nodes.push({ id, title: missing.title, kind: 'unresolved', degree: missing.sources.size,
          inDegree: missing.sources.size, outDegree: 0, folderId: null, folderName: null,
          folderColor: null, tags: [] })
        for (const source of missing.sources) edges.push({ source, target: id })
      }
    }
    return c.json({
      nodes,
      edges,
      meta: {
        mode,
        centerId: mode === 'local' ? centerId : null,
        depth,
        totalNodes: filtered.length + unresolved.size,
        totalEdges: edges.length,
        truncated: filtered.length > limit,
        limit,
      },
    })
  })
  app.get('/api/sync', (c) => {
    const since = Number(c.req.query('since')) || 0
    const changed = since < state.cursor
    const response: SyncResponse = {
      cursor: state.cursor,
      full: changed,
      hasMore: false,
      nextKey: null,
      facetsFull: true,
      settingsChanged: false,
      profileChanged: false,
      notes: changed ? [...state.notes.values()].map(summarize) : [],
      folders: changed ? listFolders(state) : [],
      tags: changed ? listTags(state) : [],
      deletions: [],
      serverTime: Date.now(),
    }
    return c.json(response)
  })

  app.post('/api/files/prune', (c) => {
    const references = attachmentReferenceCounts(state)
    let removed = 0
    let freedBytes = 0
    for (const [id, attachment] of state.attachments) {
      if ((references.get(id) ?? 0) > 0) continue
      revokeAttachment(attachment.meta.url)
      state.attachments.delete(id)
      removed++
      freedBytes += attachment.meta.size
    }
    return c.json({ removed, freedBytes })
  })
  app.get('/api/files', (c) => {
    const references = attachmentReferenceCounts(state)
    return c.json({
      files: [...state.attachments.values()].map((item) => ({
        ...item.meta,
        references: references.get(item.meta.id) ?? 0,
      })),
      nextCursor: null,
    })
  })
  app.post('/api/files', async (c) => {
    const form = await c.req.raw.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return apiError(400, 'bad_request', 'Missing file')
    if (file.size > LIMITS.attachmentMaxBytes) {
      return apiError(413, 'payload_too_large', 'The file exceeds the 25 MB limit')
    }
    const usedBytes = [...state.attachments.values()]
      .reduce((total, attachment) => total + attachment.meta.size, 0)
    if (usedBytes + file.size > LIMITS.attachmentQuotaBytes) {
      return apiError(413, 'payload_too_large', 'The account attachment quota has been reached')
    }
    const rawNoteId = form.get('noteId')
    const noteId = typeof rawNoteId === 'string' && rawNoteId ? rawNoteId.slice(0, 128) : null
    if (noteId) {
      const note = state.notes.get(noteId)
      if (!note || note.deletedAt !== null) {
        return apiError(400, 'bad_request', 'The associated note does not exist')
      }
    }
    const id = newDemoId()
    const url = await browserFileUrl(file)
    const meta = {
      id,
      noteId,
      filename: file.name || 'file',
      mime: file.type || 'application/octet-stream',
      size: file.size,
      width: null,
      height: null,
      url,
      createdAt: Date.now(),
    }
    state.attachments.set(id, { meta, file })
    return c.json(meta, 201)
  })
  app.get('/api/files/:id', (c) => {
    const attachment = state.attachments.get(c.req.param('id'))
    return attachment
      ? new Response(attachment.file, { headers: { 'Content-Type': attachment.meta.mime } })
      : apiError(404, 'not_found', 'Attachment not found')
  })
  app.delete('/api/files/:id', (c) => {
    const attachment = state.attachments.get(c.req.param('id'))
    if (!attachment) return apiError(404, 'not_found', 'Attachment not found')
    revokeAttachment(attachment.meta.url)
    state.attachments.delete(attachment.meta.id)
    return c.json({ ok: true as const })
  })

  app.get('/api/settings', (c) => c.json(state.settings))
  app.put('/api/settings', async (c) => {
    state.settings = mergeSettingsPatch(state.settings, await jsonBody(c.req.raw))
    return c.json(state.settings)
  })
  app.get('/api/settings/stats', (c) => {
    const tags = listTags(state)
    const notes = [...state.notes.values()]
    return c.json({
      notes: notes.filter((note) => note.deletedAt === null).length,
      folders: state.folders.size,
      tags: tags.length,
      links: notes.reduce((total, note) => total + extractWikiLinks(note.content).length, 0),
      words: notes.reduce((total, note) => total + note.wordCount, 0),
      versions: [...state.versions.values()].reduce((total, versions) => total + versions.length, 0),
      attachments: state.attachments.size,
      attachmentBytes: [...state.attachments.values()].reduce((total, item) => total + item.meta.size, 0),
      trashed: notes.filter((note) => note.deletedAt !== null).length,
    })
  })

  app.get('/api/update', (c) => c.json({
    currentVersion: APP_VERSION,
    latestVersion: null,
    updateUrl: null,
    checkedAt: null,
    status: 'unavailable' as const,
  }))

  app.get('/api/share', (c) => c.json({
    shares: [...state.shares.values()]
      .flatMap((share) => {
        const note = state.notes.get(share.info.noteId)
        return note ? [{
          ...absoluteShare(share.info, c.req.url),
          noteTitle: note.title,
          deletedAt: note.deletedAt,
        }] : []
      })
      .sort((a, b) => b.createdAt - a.createdAt || b.slug.localeCompare(a.slug)),
  }))
  app.get('/api/share/:noteId', (c) => {
    const share = state.shares.get(c.req.param('noteId'))
    return c.json({ share: share ? absoluteShare(share.info, c.req.url) : null })
  })
  app.post('/api/share/:noteId', async (c) => {
    const noteId = c.req.param('noteId')
    const note = state.notes.get(noteId)
    if (!note || note.deletedAt !== null) return apiError(404, 'not_found', 'Note not found')
    const body = await jsonBody(c.req.raw)
    if (body.password !== undefined && body.password !== null && typeof body.password !== 'string') {
      return apiError(400, 'bad_request', 'password must be a string or null')
    }
    if (
      body.expiresIn !== undefined &&
      body.expiresIn !== null &&
      (typeof body.expiresIn !== 'number' || !Number.isFinite(body.expiresIn) || body.expiresIn < 0)
    ) {
      return apiError(400, 'bad_request', 'expiresIn must be a non-negative number or null')
    }
    const existing = state.shares.get(noteId)
    let expiresAt = existing?.info.expiresAt ?? null
    if (body.expiresIn !== undefined) {
      expiresAt = typeof body.expiresIn === 'number' && Number.isFinite(body.expiresIn) && body.expiresIn > 0
        ? Date.now() + Math.min(body.expiresIn, 365 * 24 * 60 * 60 * 1000)
        : null
    }
    if (typeof body.password === 'string' && body.password.length > LIMITS.passwordMaxLength) {
      return apiError(400, 'bad_request', `The access password must not exceed ${LIMITS.passwordMaxLength} characters`)
    }
    if (typeof body.password === 'string' && body.password.length > 0 && body.password.length < 4) {
      return apiError(400, 'bad_request', 'The access password must be at least 4 characters')
    }
    const password = body.password === null || typeof body.password === 'string'
      ? body.password || null
      : existing?.password ?? null
    const info: ShareInfo = {
      slug: existing?.info.slug ?? `demo-${noteId}`,
      noteId,
      url: '',
      hasPassword: Boolean(password),
      expiresAt,
      views: existing?.info.views ?? 0,
      createdAt: existing?.info.createdAt ?? Date.now(),
    }
    state.shares.set(noteId, { info, password })
    return c.json({ share: absoluteShare(info, c.req.url) })
  })
  app.delete('/api/share/:noteId', (c) => {
    state.shares.delete(c.req.param('noteId'))
    return c.json({ ok: true as const })
  })
  app.post('/api/public/:slug', async (c) => {
    const share = [...state.shares.values()].find((item) => item.info.slug === c.req.param('slug'))
    if (!share || (share.info.expiresAt !== null && share.info.expiresAt <= Date.now())) {
      return apiError(404, 'not_found', 'Shared note not found')
    }
    const body = await jsonBody(c.req.raw)
    if (share.password && body.password !== share.password) {
      return apiError(401, 'unauthenticated', 'Enter the share password')
    }
    const note = state.notes.get(share.info.noteId)
    if (!note || note.deletedAt !== null) return apiError(404, 'not_found', 'Shared note not found')
    share.info = { ...share.info, views: share.info.views + 1 }
    const response: PublicNote = {
      title: note.title,
      content: note.content,
      updatedAt: note.updatedAt,
      createdAt: note.createdAt,
      author: { name: state.user.name, avatarUrl: state.user.avatarUrl },
      site: { name: 'Inkstone Demo' },
      share: { slug: share.info.slug },
    }
    return c.json(response)
  })

  app.get('/api/backup/targets', (c) => c.json({ targets: [...state.backupTargets.values()] }))
  app.post('/api/backup/targets', async (c) => {
    if (state.backupTargets.size >= LIMITS.backupTargetsMax) {
      return apiError(409, 'conflict', `Each account can configure at most ${LIMITS.backupTargetsMax} backup targets`)
    }
    const input = await jsonBody(c.req.raw) as unknown as BackupTargetInput
    const invalid = demoBackupTargetError(input, true)
    if (invalid) return apiError(400, 'bad_request', invalid)
    const target = createBackupTarget(input)
    state.backupTargets.set(target.id, target)
    return c.json(target, 201)
  })
  app.patch('/api/backup/targets/:id', async (c) => {
    const current = state.backupTargets.get(c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Backup target not found')
    const input = await jsonBody(c.req.raw) as unknown as BackupTargetPatchInput
    if (
      input.expectedUpdatedAt !== undefined &&
      (!Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt < 0)
    ) {
      return apiError(400, 'bad_request', 'expectedUpdatedAt must be a non-negative integer')
    }
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current.updatedAt) {
      return apiError(409, 'conflict', 'The backup target changed elsewhere. Refresh and try again')
    }
    const changedType = input.type !== undefined && input.type !== current.type
    const mergedInput: BackupTargetInput = {
      type: input.type ?? current.type,
      name: input.name ?? current.name,
      enabled: input.enabled ?? current.enabled,
      config: input.config
        ? ({ ...current.config, ...input.config } as BackupTargetConfig)
        : current.config,
      secret: input.secret,
    }
    const invalid = demoBackupTargetError(mergedInput, changedType)
    if (invalid) return apiError(400, 'bad_request', invalid)
    const updated: BackupTarget = {
      ...current,
      type: mergedInput.type,
      name: mergedInput.name.trim(),
      enabled: mergedInput.enabled ?? true,
      config: demoBackupConfig(mergedInput),
      hasSecret: current.hasSecret || hasDemoBackupSecret(mergedInput.type, input.secret),
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    }
    state.backupTargets.set(updated.id, updated)
    return c.json(updated)
  })
  app.delete('/api/backup/targets/:id', (c) => {
    if (!state.backupTargets.delete(c.req.param('id'))) {
      return apiError(404, 'not_found', 'Backup target not found')
    }
    return c.json({ ok: true as const })
  })
  app.post('/api/backup/test', async (c) => {
    const input = await jsonBody(c.req.raw) as unknown as BackupTargetInput
    const invalid = demoBackupTargetError(input, true)
    return invalid
      ? apiError(400, 'bad_request', invalid)
      : c.json({ ok: true, message: 'Demo connection succeeded', latencyMs: 24 })
  })
  app.post('/api/backup/targets/:id/test', async (c) => {
    const current = state.backupTargets.get(c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Backup target not found')
    const input = await jsonBody(c.req.raw) as unknown as BackupTargetPatchInput
    const changedType = input.type !== undefined && input.type !== current.type
    const mergedInput: BackupTargetInput = {
      type: input.type ?? current.type,
      name: input.name ?? current.name,
      enabled: input.enabled ?? current.enabled,
      config: input.config
        ? ({ ...current.config, ...input.config } as BackupTargetConfig)
        : current.config,
      secret: input.secret,
    }
    const invalid = demoBackupTargetError(mergedInput, changedType || !current.hasSecret)
    return invalid
      ? apiError(400, 'bad_request', invalid)
      : c.json({ ok: true, message: 'Demo connection succeeded', latencyMs: 18 })
  })
  app.post('/api/backup/run', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (
      body.targetIds !== undefined &&
      (!Array.isArray(body.targetIds) ||
        body.targetIds.some((id) => typeof id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(id)))
    ) {
      return apiError(400, 'bad_request', 'targetIds must be an array of valid backup target IDs')
    }
    const selected = Array.isArray(body.targetIds)
      ? body.targetIds as string[]
      : [...state.backupTargets.keys()]
    const targets = [...new Set(selected)]
      .map((id) => state.backupTargets.get(id))
      .filter((item): item is BackupTarget => Boolean(item?.enabled))
    const startedAt = Date.now()
    const results = targets.map((target) => ({
      targetId: target.id,
      targetName: target.name,
      targetType: target.type,
      ok: true,
      files: state.notes.size + state.attachments.size,
      bytes: [...state.notes.values()].reduce((total, note) => total + note.content.length, 0),
      ms: 40,
      error: null,
    }))
    const run: BackupRun = {
      id: newDemoId(),
      trigger: 'manual' as const,
      status: targets.length ? 'success' : 'failed',
      startedAt,
      finishedAt: Date.now(),
      noteCount: targets.length ? state.notes.size : 0,
      fileCount: results.reduce((total, result) => total + result.files, 0),
      bytes: results.reduce((total, result) => total + result.bytes, 0),
      results,
    }
    state.backupRuns.unshift(run)
    state.backupRuns.splice(LIMITS.backupRunsKept)
    return c.json(run)
  })
  app.get('/api/backup/runs', (c) => c.json({ runs: state.backupRuns }))

  app.get('/api/export', (c) => exportResponse(state, c.req.query('format') === 'json' ? 'json' : 'zip'))
  app.post('/api/import', async (c) => {
    const form = await c.req.raw.formData()
    const files = form.getAll('file').filter((value): value is File => value instanceof File)
    if (files.length > LIMITS.importFilesMax) {
      return apiError(413, 'payload_too_large', `The import cannot contain more than ${LIMITS.importFilesMax} files`)
    }
    if (files.reduce((total, file) => total + file.size, 0) > LIMITS.importUploadMaxBytes) {
      return apiError(413, 'payload_too_large', 'The import upload cannot exceed 64 MB')
    }
    const result: ImportResult = {
      createdNotes: 0,
      updatedNotes: 0,
      skippedNotes: 0,
      createdFolders: 0,
      createdAttachments: 0,
      skippedAttachments: 0,
      warnings: [],
    }
    for (const value of files) {
      try {
        if (value.name.toLowerCase().endsWith('.zip')) {
          const entries = await readZip(new Uint8Array(await value.arrayBuffer()), {
            maxEntries: LIMITS.importArchiveEntriesMax,
            maxEntryBytes: LIMITS.importArchiveExpandedMaxBytes,
            maxTotalBytes: LIMITS.importArchiveExpandedMaxBytes,
          })
          const bundleEntry = entries.find((entry) => entry.path.endsWith('inkstone-export.json'))
          if (!bundleEntry) throw new Error('The ZIP does not contain an Inkstone export')
          await importBundle(
            state,
            JSON.parse(new TextDecoder().decode(bundleEntry.data)),
            result,
            new Map(entries.map((entry) => [entry.path.toLocaleLowerCase(), entry.data])),
          )
        } else if (value.name.toLowerCase().endsWith('.json')) {
          if (value.size > LIMITS.importBundleMaxBytes) {
            throw new Error('The export file cannot exceed 32 MB')
          }
          await importBundle(state, JSON.parse(await value.text()), result)
        } else {
          if (value.size > LIMITS.contentMaxBytes) {
            throw new Error('A note file cannot exceed 2 MB')
          }
          const content = await value.text()
          createImportedNote(state, content, deriveTitle(content), null)
          result.createdNotes++
        }
      } catch (error) {
        result.warnings.push(`${value.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    state.cursor++
    return c.json(result)
  })

  app.all('/api/*', () => apiError(404, 'not_found', 'Demo endpoint not found'))

  return { fetch: (request) => Promise.resolve(app.fetch(request)) }
}

function demoMcpSettings(now = Date.now()): McpSettingsInfo {
  return {
    enabled: true,
    canManageGlobal: true,
    endpoint: 'https://your-inkstone.example/mcp',
    oauth: true,
    preferences: {
      writeEnabled: true,
      trashEnabled: false,
      updatedAt: now - 24 * 60 * 60 * 1000,
    },
    apiKeys: [{
      id: 'demo-api-key',
      name: 'Automation key',
      scopes: ['notes:read', 'notes:write'],
      createdAt: now - 14 * 24 * 60 * 60 * 1000,
      lastUsedAt: now - 18 * 60 * 1000,
    }],
    aiSearch: {
      available: true,
      enabled: true,
      model: '@cf/baai/bge-m3',
      indexedCount: 24,
      pendingCount: 2,
      reason: null,
    },
    grants: [{
      id: 'demo-grant',
      clientId: 'demo-desktop-client',
      clientName: 'Desktop MCP client',
      clientUri: 'https://example.com',
      scopes: ['notes:read', 'notes:write'],
      createdAt: now - 7 * 24 * 60 * 60 * 1000,
      expiresAt: null,
    }],
    privacy: {
      publicEndpoint: false,
      perUserIndex: true,
      externalClientReceivesSelectedContent: true,
    },
  }
}

function siteInfo(state: DemoState) {
  return {
    name: 'Inkstone Demo',
    initialized: true,
    registrationOpen: state.registrationOpen,
    r2Enabled: false,
    kvEnabled: false,
    attachmentStorage: null,
    realtimeEnabled: false,
    version: APP_VERSION,
  } as const
}

function sessionInfo(state: DemoState): SessionInfo {
  return {
    user: state.authenticated ? state.user : null,
    site: siteInfo(state),
    settings: state.authenticated ? state.settings : null,
  }
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json()
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function apiError(status: number, code: string, message: string, details?: unknown): Response {
  return new Response(
    JSON.stringify({ error: { code, message, ...(details === undefined ? {} : { details }) } }),
    { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  )
}

function saveVersion(state: DemoState, note: Note): void {
  const version: NoteVersion = {
    id: newDemoId(),
    noteId: note.id,
    title: note.title,
    size: new TextEncoder().encode(note.content).byteLength,
    createdAt: Date.now(),
    content: note.content,
  }
  state.versions.set(note.id, [version, ...(state.versions.get(note.id) ?? [])].slice(0, 50))
}

function findVersion(state: DemoState, noteId: string, versionId: string): NoteVersion | null {
  return state.versions.get(noteId)?.find((version) => version.id === versionId) ?? null
}

function purgeNote(state: DemoState, id: string): void {
  state.notes.delete(id)
  state.versions.delete(id)
  state.shares.delete(id)
  state.cursor++
}

function demoFolderSiblings(
  state: DemoState,
  parentId: string | null,
  excludeId?: string,
): Folder[] {
  return [...state.folders.values()]
    .filter((folder) => folder.parentId === parentId && folder.id !== excludeId)
    .sort((left, right) => left.position - right.position || left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}

function availableDemoFolderName(siblings: Folder[], base: string): string {
  const names = new Set(siblings.map((folder) => folder.name.toLocaleLowerCase()))
  if (!names.has(base.toLocaleLowerCase())) return base
  let suffix = 2
  while (names.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix++
  return `${base} ${suffix}`
}

function demoFolderDepth(state: DemoState, id: string): number {
  let depth = 1
  let cursor = state.folders.get(id)?.parentId ?? null
  const visited = new Set([id])
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor)
    depth++
    cursor = state.folders.get(cursor)?.parentId ?? null
  }
  return depth
}

function demoFolderHeight(state: DemoState, rootId: string): number {
  let height = 1
  const queue: Array<[string, number]> = [[rootId, 1]]
  const visited = new Set<string>()
  while (queue.length) {
    const [id, depth] = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    height = Math.max(height, depth)
    for (const folder of state.folders.values()) {
      if (folder.parentId === id) queue.push([folder.id, depth + 1])
    }
  }
  return height
}

function promoteDemoFolderChildren(state: DemoState, root: Folder): void {
  const siblings = demoFolderSiblings(state, root.parentId)
  const children = demoFolderSiblings(state, root.id)
  const index = siblings.findIndex((folder) => folder.id === root.id)
  if (index < 0) return
  siblings.splice(index, 1, ...children)
  const now = Date.now()
  siblings.forEach((folder, orderIndex) => {
    state.folders.set(folder.id, {
      ...folder,
      parentId: folder.parentId === root.id ? root.parentId : folder.parentId,
      position: (orderIndex + 1) * 1000,
      updatedAt: folder.parentId === root.id ? now : folder.updatedAt,
    })
  })
}

function folderDescendants(state: DemoState, rootId: string): Set<string> {
  const ids = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of state.folders.values()) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }
  return ids
}

function attachmentReferenceCounts(state: DemoState): Map<string, number> {
  const references = new Map<string, number>()
  for (const note of state.notes.values()) {
    for (const id of extractAttachmentIds(note.content)) {
      if (!state.attachments.has(id)) continue
      references.set(id, (references.get(id) ?? 0) + 1)
    }
    for (const attachment of state.attachments.values()) {
      if (!note.content.includes(attachment.meta.url)) continue
      references.set(attachment.meta.id, (references.get(attachment.meta.id) ?? 0) + 1)
    }
  }
  return references
}

async function browserFileUrl(file: File): Promise<string> {
  if (typeof URL.createObjectURL === 'function') return URL.createObjectURL(file)
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`
}

function revokeAttachment(url: string): void {
  if (url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
}

function absoluteShare(info: ShareInfo, requestUrl: string): ShareInfo {
  return { ...info, url: `${new URL(requestUrl).origin}/s/${info.slug}` }
}

function createBackupTarget(input: BackupTargetInput): BackupTarget {
  const now = Date.now()
  const type = input.type
  const config = demoBackupConfig(input)
  return {
    id: newDemoId(),
    type,
    name: input.name.trim(),
    enabled: input.enabled ?? true,
    config,
    hasSecret: hasDemoBackupSecret(type, input.secret),
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }
}

function demoBackupConfig(input: BackupTargetInput): BackupTargetConfig {
  const mode: BackupMode = input.config.mode === 'mirror' ? 'mirror' : 'archive'
  return input.type === 's3'
    ? {
        endpoint: input.config.endpoint ?? '',
        region: input.config.region ?? 'auto',
        bucket: input.config.bucket ?? '',
        prefix: input.config.prefix ?? '',
        pathStyle: input.config.pathStyle ?? true,
        mode,
      }
    : {
        url: input.config.url ?? '',
        username: input.config.username ?? '',
        prefix: input.config.prefix ?? '',
        mode,
      }
}

function demoBackupTargetError(input: BackupTargetInput, requireSecret: boolean): string | null {
  if (input.type !== 's3' && input.type !== 'webdav') return 'type must be s3 or webdav'
  if (typeof input.name !== 'string' || !input.name.trim()) return 'Enter a name'
  if (input.name.trim().length > 120) return 'The name must not exceed 120 characters'
  if (!input.config || typeof input.config !== 'object' || Array.isArray(input.config)) {
    return 'config must be an object'
  }
  if (input.type === 's3') {
    if (typeof input.config.bucket !== 'string' || !input.config.bucket.trim()) {
      return 'Enter a bucket name'
    }
    if (requireSecret && !hasDemoBackupSecret('s3', input.secret)) {
      return 'Enter an Access Key and Secret Key'
    }
    return null
  }
  if (typeof input.config.url !== 'string' || !input.config.url.trim()) return 'Enter a WebDAV URL'
  if (typeof input.config.username !== 'string' || !input.config.username.trim()) return 'Enter a username'
  if (requireSecret && !hasDemoBackupSecret('webdav', input.secret)) return 'Enter a password'
  return null
}

function hasDemoBackupSecret(
  type: BackupTargetInput['type'],
  secret: BackupTargetInput['secret'],
): boolean {
  if (type === 's3') {
    return Boolean(secret?.accessKeyId?.trim() && secret.secretAccessKey?.trim())
  }
  return Boolean(secret?.password?.trim())
}

function exportBundle(state: DemoState): ExportBundle {
  return {
    format: 'inkstone-export',
    version: 1,
    exportedAt: Date.now(),
    user: { login: state.user.login, name: state.user.name },
    folders: listFolders(state),
    tags: listTags(state),
    notes: [...state.notes.values()],
    attachments: [],
  }
}

async function exportResponse(state: DemoState, format: 'json' | 'zip'): Promise<Response> {
  const baseBundle = exportBundle(state)
  const encoder = new TextEncoder()
  if (format === 'json') {
    return new Response(JSON.stringify(baseBundle, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="inkstone-demo.json"',
      },
    })
  }
  const storedAttachments = [...state.attachments.values()]
  const notes = [...state.notes.values()].map((note) => ({
    ...note,
    content: storedAttachments.reduce(
      (content, attachment) => content.replaceAll(attachment.meta.url, `/api/files/${attachment.meta.id}`),
      note.content,
    ),
  }))
  const noteEntries = demoNoteEntries(notes, encoder)
  const expandedBytes = noteEntries.reduce((total, entry) => total + entry.data.byteLength, 0)
    + storedAttachments.reduce((total, attachment) => total + attachment.meta.size, 0)
  if (expandedBytes > LIMITS.importArchiveExpandedMaxBytes) {
    return apiError(413, 'payload_too_large', 'The demo ZIP would exceed the 80 MB expanded archive limit')
  }
  if (noteEntries.length + storedAttachments.length + 1 > LIMITS.importArchiveEntriesMax) {
    return apiError(413, 'payload_too_large', 'The demo ZIP would contain too many files')
  }

  const attachments: ExportAttachment[] = []
  const attachmentEntries: Array<{ path: string, data: Uint8Array }> = []
  for (const attachment of storedAttachments) {
    const data = new Uint8Array(await attachment.file.arrayBuffer())
    const filename = safeAttachmentFilename(attachment.meta.filename)
    const path = `attachments/${attachment.meta.id}/${filename}`
    attachments.push({
      id: attachment.meta.id,
      noteId: attachment.meta.noteId,
      filename,
      mime: attachment.meta.mime,
      size: data.byteLength,
      width: attachment.meta.width,
      height: attachment.meta.height,
      createdAt: attachment.meta.createdAt,
      path,
      sha256: await sha256Hex(data),
    })
    attachmentEntries.push({ path, data })
  }
  const bundle: ExportBundle = { ...baseBundle, notes, attachments }
  const entries = [
    { path: 'inkstone-export.json', data: encoder.encode(JSON.stringify(bundle, null, 2)) },
    ...noteEntries,
    ...attachmentEntries,
  ]
  if (entries.reduce((total, entry) => total + entry.data.byteLength, 0) > LIMITS.importArchiveExpandedMaxBytes) {
    return apiError(413, 'payload_too_large', 'The demo ZIP would exceed the 80 MB expanded archive limit')
  }
  const data = createZip(entries)
  return new Response(data as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="inkstone-demo.zip"',
    },
  })
}

function demoNoteEntries(notes: Iterable<Note>, encoder: TextEncoder): Array<{ path: string, data: Uint8Array }> {
  const used = new Set<string>()
  return [...notes].map((note) => {
    const base = safeFilename(note.title)
    let name = base
    let suffix = 2
    while (used.has(name.toLocaleLowerCase())) name = `${base} (${suffix++})`
    used.add(name.toLocaleLowerCase())
    return { path: `notes/${name}.md`, data: encoder.encode(note.content) }
  })
}

function safeFilename(value: string): string {
  return (value || 'Untitled note').replace(/[\\/:*?"<>|]/g, '-').slice(0, 100)
}

function safeAttachmentFilename(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return (cleaned || 'file').slice(0, 180)
}

async function importBundle(
  state: DemoState,
  value: unknown,
  result: ImportResult,
  archiveEntries?: Map<string, Uint8Array>,
): Promise<void> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid export file')
  const bundle = value as Partial<ExportBundle>
  if (!Array.isArray(bundle.notes)) throw new Error('The export contains no notes')
  const importedAttachments = archiveEntries
    ? await importBundleAttachments(state, Array.isArray(bundle.attachments) ? bundle.attachments : [], archiveEntries, result)
    : { urls: new Map<string, string>(), sourceNotes: new Map<string, string | null>() }
  if (!archiveEntries && Array.isArray(bundle.attachments) && bundle.attachments.length > 0) {
    result.skippedAttachments += bundle.attachments.length
    result.warnings.push('Attachment bytes are unavailable in JSON exports')
  }
  const folderMap = new Map<string, string>()
  for (const raw of Array.isArray(bundle.folders) ? bundle.folders : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue
    const id = state.folders.has(raw.id) ? newDemoId() : raw.id
    folderMap.set(raw.id, id)
    state.folders.set(id, {
      id,
      parentId: raw.parentId ? folderMap.get(raw.parentId) ?? null : null,
      name: typeof raw.name === 'string' ? raw.name : 'Imported folder',
      icon: typeof raw.icon === 'string' ? raw.icon : null,
      color: organizerColorOrNull(raw.color),
      position: Number.isFinite(raw.position) ? raw.position : state.folders.size + 1,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      updatedAt: Date.now(),
    })
    result.createdFolders++
  }
  const noteMap = new Map<string, string>()
  for (const raw of bundle.notes) {
    if (!raw || typeof raw !== 'object' || typeof raw.content !== 'string') {
      result.skippedNotes++
      continue
    }
    const folderId = typeof raw.folderId === 'string' ? folderMap.get(raw.folderId) ?? null : null
    let content = raw.content
    for (const sourceId of extractAttachmentIds(content)) {
      const url = importedAttachments.urls.get(sourceId)
      if (url) content = content.replaceAll(`/api/files/${sourceId}`, url)
    }
    const id = createImportedNote(state, content, typeof raw.title === 'string' ? raw.title : undefined, folderId)
    if (typeof raw.id === 'string') noteMap.set(raw.id, id)
    result.createdNotes++
  }
  for (const [id, sourceNoteId] of importedAttachments.sourceNotes) {
    const attachment = state.attachments.get(id)
    if (!attachment) continue
    attachment.meta = { ...attachment.meta, noteId: sourceNoteId ? noteMap.get(sourceNoteId) ?? null : null }
  }
}

function createImportedNote(
  state: DemoState,
  content: string,
  title: string | undefined,
  folderId: string | null,
): string {
  const now = Date.now()
  const id = newDemoId()
  const note = refreshNote({
    id,
    title: title ?? deriveTitle(content),
    excerpt: '',
    content: '',
    folderId,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }, content, title)
  state.notes.set(id, note)
  return id
}

async function importBundleAttachments(
  state: DemoState,
  rawAttachments: ExportAttachment[],
  archiveEntries: Map<string, Uint8Array>,
  result: ImportResult,
): Promise<{ urls: Map<string, string>, sourceNotes: Map<string, string | null> }> {
  const prepared: Array<{
    sourceId: string
    sourceNoteId: string | null
    id: string
    filename: string
    mime: string
    width: number | null
    height: number | null
    createdAt: number
    data: Uint8Array
  }> = []
  let importedBytes = 0
  const sourceIds = new Set<string>()
  const manifestPaths = new Set<string>()
  for (const raw of rawAttachments) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(raw.id)) {
      throw new Error('The export contains an invalid attachment ID')
    }
    if (sourceIds.has(raw.id)) throw new Error(`The export contains a duplicate attachment ID: ${raw.id}`)
    sourceIds.add(raw.id)
    if (typeof raw.path !== 'string' || !raw.path || typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.sha256)) {
      throw new Error(`The export contains invalid attachment metadata: ${raw.id}`)
    }
    const pathSegments = raw.path.split('/')
    if (
      raw.path.length > 512 ||
      raw.path.includes('\\') ||
      pathSegments.length !== 3 ||
      pathSegments[0] !== 'attachments' ||
      pathSegments[1] !== raw.id ||
      !pathSegments[2] ||
      /[\u0000-\u001f]/.test(pathSegments[2])
    ) throw new Error(`The export contains an invalid attachment path: ${raw.id}`)
    const pathKey = raw.path.toLocaleLowerCase()
    if (manifestPaths.has(pathKey)) throw new Error(`The export contains a duplicate attachment path: ${raw.path}`)
    manifestPaths.add(pathKey)
    const filename = typeof raw.filename === 'string' ? raw.filename : ''
    const mime = typeof raw.mime === 'string' ? raw.mime : ''
    if (!filename || filename.length > 180 || !mime || mime.length > 255) {
      throw new Error(`The export contains invalid attachment metadata: ${raw.id}`)
    }
    const data = archiveEntries.get(pathKey)
    if (!data) {
      result.skippedAttachments++
      result.warnings.push(`${filename}: attachment bytes are missing from the backup and were not restored`)
      continue
    }
    if (!Number.isSafeInteger(raw.size) || raw.size !== data.byteLength || data.byteLength > LIMITS.attachmentMaxBytes) {
      throw new Error(`The ZIP attachment has an invalid size: ${raw.filename || raw.id}`)
    }
    if (await sha256Hex(data) !== raw.sha256.toLocaleLowerCase()) {
      throw new Error(`The ZIP attachment checksum failed: ${raw.filename || raw.id}`)
    }
    importedBytes += data.byteLength
    prepared.push({
      sourceId: raw.id,
      sourceNoteId: typeof raw.noteId === 'string' && /^[0-9a-hjkmnp-tv-z]{26}$/.test(raw.noteId) ? raw.noteId : null,
      id: state.attachments.has(raw.id) ? newDemoId() : raw.id,
      filename,
      mime,
      width: Number.isFinite(raw.width) ? raw.width : null,
      height: Number.isFinite(raw.height) ? raw.height : null,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      data,
    })
  }
  const usedBytes = [...state.attachments.values()].reduce((total, attachment) => total + attachment.meta.size, 0)
  if (usedBytes + importedBytes > LIMITS.attachmentQuotaBytes) {
    throw new Error('The imported attachments would exceed the account quota')
  }

  const imported = new Map<string, string>()
  const sourceNotes = new Map<string, string | null>()
  const createdIds: string[] = []
  try {
    for (const item of prepared) {
      const file = new File([item.data.slice().buffer as ArrayBuffer], item.filename, {
        type: item.mime,
        lastModified: item.createdAt,
      })
      const url = await browserFileUrl(file)
      state.attachments.set(item.id, {
        file,
        meta: {
          id: item.id,
          noteId: null,
          filename: item.filename,
          mime: item.mime,
          size: file.size,
          width: item.width,
          height: item.height,
          url,
          createdAt: item.createdAt,
        },
      })
      createdIds.push(item.id)
      imported.set(item.sourceId, url)
      sourceNotes.set(item.id, item.sourceNoteId)
      result.createdAttachments++
    }
  } catch (error) {
    for (const id of createdIds) {
      const attachment = state.attachments.get(id)
      if (attachment) revokeAttachment(attachment.meta.url)
      state.attachments.delete(id)
      sourceNotes.delete(id)
      result.createdAttachments--
    }
    throw error
  }
  return { urls: imported, sourceNotes }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('')
}
