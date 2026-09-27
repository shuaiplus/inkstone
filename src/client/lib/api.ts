import { CLIENT_HEADER } from '@shared/constants'
import type { MarkdownBackupManifest } from '@shared/backup-format'
import type {
  AppLocale,
  Attachment,
  AttachmentWithUsage,
  BackupRun,
  BackupTarget,
  BackupTargetInput,
  BackupTargetPatchInput,
  Backlink,
  Folder,
  GraphResponse,
  ImportResult,
  ListNotesResponse,
  McpAiSearchStatus,
  McpApiKey,
  McpSettingsInfo,
  Note,
  NoteVersion,
  NoteVersionMeta,
  PatchNoteBody,
  PasswordLoginResult,
  PublicUser,
  PublicNote,
  SearchResponse,
  SessionInfo,
  ShareInfo,
  ShareListItem,
  SyncResponse,
  Tag,
  TestConnectionResult,
  TotpRecoveryCodesResult,
  TotpLoginResult,
  TotpSetupInfo,
  TotpStatus,
  UpdateCheckResponse,
  UserSettings,
} from '@shared/types'
import { publishBroadcast } from './db'
import { getLocale, t, translateApiError } from './i18n'


export const CLIENT_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  get isOffline(): boolean {
    return this.status === 0
  }
  get isAuth(): boolean {
    return this.status === 401
  }
  get isConflict(): boolean {
    return this.status === 409
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
  formData?: FormData
  timeoutMs?: number
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, formData, timeoutMs } = options

  const headers: Record<string, string> = {
    [CLIENT_HEADER]: '1',
    'X-Inkstone-Origin': CLIENT_ID,
    'Accept-Language': getLocale(),
  }
  let payload: BodyInit | undefined
  if (formData) {
    payload = formData
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const timeoutController = timeoutMs && timeoutMs > 0 ? new AbortController() : null
  let timedOut = false
  let timeoutHandle = 0
  let detachCallerSignal: (() => void) | undefined
  if (timeoutController) {
    const abortFromCaller = () => timeoutController.abort(signal?.reason)
    if (signal?.aborted) abortFromCaller()
    else if (signal) {
      signal.addEventListener('abort', abortFromCaller, { once: true })
      detachCallerSignal = () => signal.removeEventListener('abort', abortFromCaller)
    }
    timeoutHandle = window.setTimeout(() => {
      timedOut = true
      timeoutController.abort()
    }, timeoutMs)
  }

  try {
    const response = await fetch(path, {
      method,
      headers,
      body: payload,
      signal: timeoutController?.signal ?? signal,
      credentials: 'same-origin',
    })

    const notifyOtherTabs = method !== 'GET' && shouldNotifyOtherTabs(path)
    if (response.status === 204) {
      if (notifyOtherTabs) publishBroadcast({ type: 'local-write', clientId: CLIENT_ID })
      return undefined as T
    }

    const isJson = isJsonResponse(response)
    let data: unknown = null
    let invalidJson = false
    if (isJson) {
      const raw = await response.text()
      if (raw.trim()) {
        try {
          data = JSON.parse(raw)
        } catch {
          invalidJson = true
        }
      }
    }

    if (!response.ok) {
      const error = (data as { error?: { code: string; message: string; details?: unknown } } | null)?.error
      const code = error?.code ?? 'unknown'
      const fallback = error?.message ?? t("api.request_failed_status", { status: response.status })
      throw new ApiError(
        response.status,
        code,
        translateApiError(code, fallback),
        error?.details,
      )
    }

    if (invalidJson) {
      throw new ApiError(502, 'invalid_response', t("api.invalid_server_response"))
    }

    if (notifyOtherTabs) {
      publishBroadcast({ type: 'local-write', clientId: CLIENT_ID })
    }
    return (isJson ? data : await response.text()) as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (timedOut) throw new ApiError(0, 'request_timeout', t("api.request_timed_out"))
    if ((err as Error)?.name === 'AbortError') throw err
    throw new ApiError(0, 'offline', t("api.no_network_connection"))
  } finally {
    if (timeoutHandle) window.clearTimeout(timeoutHandle)
    detachCallerSignal?.()
  }
}

function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json' || Boolean(mediaType?.endsWith('+json'))
}

async function fetchDownload(path: string, fallbackName: string): Promise<{ response: Response; filename: string }> {
  let response: Response
  try {
    response = await fetch(path, {
      headers: {
        [CLIENT_HEADER]: '1',
        'X-Inkstone-Origin': CLIENT_ID,
        'Accept-Language': getLocale(),
      },
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, 'offline', t("api.no_network_connection"))
  }

  if (!response.ok) {
    const data = isJsonResponse(response)
      ? await response.json().catch(() => null)
      : null
    const error = (data as { error?: { code: string; message: string; details?: unknown } } | null)?.error
    const code = error?.code ?? 'unknown'
    const fallback = error?.message ?? t("api.request_failed_status", { status: response.status })
    throw new ApiError(
      response.status,
      code,
      translateApiError(code, fallback),
      error?.details,
    )
  }

  const disposition = response.headers.get('Content-Disposition') ?? ''
  const filename = /filename="([^"\r\n]+)"/i.exec(disposition)?.[1] ?? fallbackName
  return { response, filename }
}

async function saveDownload(format: 'json' | 'zip'): Promise<void> {
  if (format === 'zip') {
    const picker = (window as Window & {
      showSaveFilePicker?: (options: {
        suggestedName: string
        types: Array<{ description: string; accept: Record<string, string[]> }>
      }) => Promise<FileSystemFileHandle>
    }).showSaveFilePicker
    if (picker) {
      let handle: FileSystemFileHandle
      try {
        handle = await picker.call(window, {
          suggestedName: `inkstone-backup-${new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 15)}.zip`,
          types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
        })
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') return
        throw error
      }
      const { response } = await fetchDownload('/api/export?format=zip', 'inkstone-backup.zip')
      if (!response.body) throw new ApiError(0, 'unknown', t('api.no_network_connection'))
      const writable = await handle.createWritable()
      await response.body.pipeTo(writable)
      return
    }

    const { response, filename } = await fetchDownload('/api/export?format=zip', 'inkstone-backup.zip')
    await saveResponseDownload(response, filename)
    return
  }

  const { response, filename } = await fetchDownload('/api/export?format=json', 'inkstone-export.json')
  await saveResponseDownload(response, filename)
}

async function saveResponseDownload(response: Response, filename: string): Promise<void> {
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.append(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

function shouldNotifyOtherTabs(path: string): boolean {
  return /^\/api\/(?:notes(?:\/|$)|folders(?:\/|$)|tags(?:\/|$)|import(?:\?|$))/.test(path)
}


export const api = {
  session: () => request<SessionInfo>('/api/auth/session'),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  auth: {
    register: (username: string, password: string, locale: AppLocale = getLocale()) =>
      request<SessionInfo>('/api/auth/register', {
        method: 'POST',
        body: { username, password, locale },
      }),
    login: (username: string, password: string) =>
      request<PasswordLoginResult>('/api/auth/login', { method: 'POST', body: { username, password } }),
    totp: {
      status: () => request<TotpStatus>('/api/auth/totp/status'),
      startSetup: (currentPassword: string) =>
        request<TotpSetupInfo>('/api/auth/totp/setup', {
          method: 'POST',
          body: { currentPassword },
        }),
      confirmSetup: (setupToken: string, code: string) =>
        request<TotpRecoveryCodesResult & { enabledAt: number }>('/api/auth/totp/setup/confirm', {
          method: 'POST',
          body: { setupToken, code },
        }),
      cancelSetup: (setupToken: string) =>
        request<{ ok: true }>('/api/auth/totp/setup', {
          method: 'DELETE',
          body: { setupToken },
        }),
      completeLogin: (challengeToken: string, code: string) =>
        request<TotpLoginResult>('/api/auth/totp/login', {
          method: 'POST',
          body: { challengeToken, code },
        }),
      regenerateRecoveryCodes: (currentPassword: string, code: string) =>
        request<TotpRecoveryCodesResult>('/api/auth/totp/recovery-codes', {
          method: 'POST',
          body: { currentPassword, code },
        }),
      disable: (currentPassword: string, code: string) =>
        request<{ ok: true }>('/api/auth/totp', {
          method: 'DELETE',
          body: { currentPassword, code },
        }),
    },
    setPassword: (body: {
      currentPassword: string
      newPassword: string
    }) =>
      request<{ ok: true }>('/api/auth/password', { method: 'POST', body }),
    updateProfile: (body: { name?: string; avatarUrl?: string }) =>
      request<PublicUser>('/api/auth/profile', {
        method: 'PUT',
        body,
        timeoutMs: 30_000,
      }).then((user) => {
        publishBroadcast({ type: 'profile-changed', clientId: CLIENT_ID })
        return user
      }),
    updateRegistration: (enabled: boolean, password: string) =>
      request<{ ok: true; registrationOpen: boolean }>('/api/settings/registration', {
        method: 'PUT',
        body: { enabled, password },
      }).then((result) => {
        publishBroadcast({ type: 'site-changed', clientId: CLIENT_ID })
        return result
      }),
  },

  notes: {
    list: (params: Record<string, string | number | undefined>) =>
      request<ListNotesResponse>(`/api/notes${toQuery(params)}`),
    get: (id: string) => request<Note>(`/api/notes/${id}`),
    create: (body: { id?: string; content?: string; title?: string; folderId?: string | null; isStarred?: boolean }) =>
      request<Note>('/api/notes', { method: 'POST', body, timeoutMs: 30_000 }),
    patch: (id: string, body: PatchNoteBody) =>
      request<Note>(`/api/notes/${id}`, { method: 'PATCH', body, timeoutMs: 30_000 }),
    remove: (id: string) => request<Note>(`/api/notes/${id}`, { method: 'DELETE' }),
    restore: (id: string) => request<Note>(`/api/notes/${id}/restore`, { method: 'POST' }),
    purge: (id: string) => request<{ ok: true; cursor: number }>(`/api/notes/${id}/purge`, { method: 'DELETE' }),
    duplicate: (id: string, body: { id?: string } = {}) =>
      request<Note>(`/api/notes/${id}/duplicate`, { method: 'POST', body }),
    emptyTrash: () => request<{ purged: number }>('/api/notes/trash/empty', { method: 'POST' }),
    versions: (id: string, signal?: AbortSignal) =>
      request<{ versions: NoteVersionMeta[] }>(`/api/notes/${id}/versions`, { signal }),
    version: (id: string, versionId: string, signal?: AbortSignal) =>
      request<NoteVersion>(`/api/notes/${id}/versions/${versionId}`, { signal }),
    restoreVersion: (id: string, versionId: string) =>
      request<Note>(`/api/notes/${id}/versions/${versionId}/restore`, { method: 'POST' }),
    backlinks: (id: string, signal?: AbortSignal) =>
      request<{ backlinks: Backlink[] }>(`/api/notes/${id}/backlinks`, { signal }),
  },

  folders: {
    list: () => request<{ folders: Folder[] }>('/api/folders'),
    create: (body: { id?: string; name?: string; parentId?: string | null; icon?: string | null; color?: string | null }) =>
      request<Folder>('/api/folders', { method: 'POST', body }),
    patch: (id: string, body: {
      name?: string
      parentId?: string | null
      beforeId?: string | null
      icon?: string | null
      color?: string | null
    }) =>
      request<Folder>(`/api/folders/${id}`, { method: 'PATCH', body }),
    remove: (id: string, strategy: 'move-up' | 'delete' = 'move-up') =>
      request<{ ok: true }>(`/api/folders/${id}?strategy=${strategy}`, { method: 'DELETE' }),
  },

  tags: {
    list: () => request<{ tags: Tag[] }>('/api/tags'),
    create: (body: { id?: string; name: string; color?: string | null }) =>
      request<Tag>('/api/tags', { method: 'POST', body }),
    patch: (id: string, body: { name?: string; color?: string | null }) =>
      request<Tag | { ok: true; renamed: number }>(`/api/tags/${id}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      request<{ ok: true; affected: number }>(`/api/tags/${id}`, { method: 'DELETE' }),
  },

  search: (q: string, limit = 50, signal?: AbortSignal) =>
    request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal }),
  reindex: () => request<{ ok: true; indexed: number }>('/api/search/reindex', { method: 'POST' }),
  graph: (params: import('@shared/types').GraphQuery = {}, signal?: AbortSignal) =>
    request<GraphResponse>(`/api/graph${toQuery({
      mode: params.mode,
      center: params.center,
      depth: params.depth,
      q: params.q,
      folderId: params.folderId,
      tag: params.tag,
      includeOrphans: params.includeOrphans === undefined ? undefined : params.includeOrphans ? 1 : 0,
      includeUnresolved: params.includeUnresolved === undefined ? undefined : params.includeUnresolved ? 1 : 0,
      limit: params.limit,
    })}`, { signal }),

  sync: (since: number, options: { after?: string; snapshot?: number } = {}) =>
    request<SyncResponse>(
      `/api/sync${toQuery({ since, after: options.after, snapshot: options.snapshot })}`,
      { timeoutMs: 30_000 },
    ),

  files: {
    list: (cursor?: string, signal?: AbortSignal) => request<{ files: AttachmentWithUsage[]; nextCursor?: string | null }>(
      `/api/files${toQuery({ cursor })}`,
      { signal },
    ),
    upload: (file: File, noteId?: string) => {
      const form = new FormData()
      form.append('file', file)
      if (noteId) form.append('noteId', noteId)
      return request<Attachment>('/api/files', { method: 'POST', formData: form })
    },
    remove: (id: string) => request<{ ok: true }>(`/api/files/${id}`, { method: 'DELETE' }),
    prune: () => request<{ removed: number; freedBytes: number }>('/api/files/prune', { method: 'POST' }),
  },

  backup: {
    targets: () => request<{ targets: BackupTarget[] }>('/api/backup/targets'),
    create: (body: BackupTargetInput) => request<BackupTarget>('/api/backup/targets', { method: 'POST', body }),
    patch: (id: string, body: BackupTargetPatchInput) =>
      request<BackupTarget>(`/api/backup/targets/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<{ ok: true }>(`/api/backup/targets/${id}`, { method: 'DELETE' }),
    test: (id: string, body: Partial<BackupTargetInput> = {}) =>
      request<TestConnectionResult>(`/api/backup/targets/${id}/test`, { method: 'POST', body }),
    testDraft: (body: BackupTargetInput) =>
      request<TestConnectionResult>('/api/backup/test', { method: 'POST', body }),
    run: (targetIds?: string[]) => request<BackupRun>('/api/backup/run', { method: 'POST', body: { targetIds } }),
    runs: () => request<{ runs: BackupRun[] }>('/api/backup/runs'),
  },

  settings: {
    get: () => request<UserSettings>('/api/settings'),
    save: (body: Partial<UserSettings>) =>
      request<UserSettings>('/api/settings', { method: 'PUT', body }).then((settings) => {
        publishBroadcast({ type: 'settings-changed', clientId: CLIENT_ID })
        return settings
      }),
    stats: () => request<Record<string, number>>('/api/settings/stats'),
  },

  mcp: {
    get: () => request<McpSettingsInfo>('/api/mcp'),
    save: (body: {
      enabled?: boolean
      writeEnabled?: boolean
      trashEnabled?: boolean
    }) => request<{
      enabled: boolean
      preferences: McpSettingsInfo['preferences']
      reconnectRequired: boolean
    }>('/api/mcp', { method: 'PUT', body }),
    revokeGrant: (id: string) => request<{ ok: true }>(`/api/mcp/grants/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    revokeAllGrants: () => request<{ ok: true; revoked: number }>('/api/mcp/grants/revoke-all', { method: 'POST' }),
    createKey: (name: string) =>
      request<{ key: McpApiKey; token: string }>('/api/mcp/keys', { method: 'POST', body: { name } }),
    revokeKey: (id: string) =>
      request<{ ok: true }>(`/api/mcp/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    aiSearch: {
      save: (enabled: boolean) =>
        request<McpAiSearchStatus>('/api/mcp/ai-search', { method: 'PUT', body: { enabled } }),
      reindex: () =>
        request<McpAiSearchStatus & { ok: true; enqueued: number }>('/api/mcp/ai-search/reindex', { method: 'POST' }),
      clear: () =>
        request<{ ok: true; removed: number }>('/api/mcp/ai-search/clear', { method: 'POST' }),
    },
  },

  update: {
    check: () => request<UpdateCheckResponse>('/api/update', { timeoutMs: 10_000 }),
  },

  share: {
    list: (signal?: AbortSignal) =>
      request<{ shares: ShareListItem[] }>('/api/share', { signal }),
    get: (noteId: string, signal?: AbortSignal) =>
      request<{ share: ShareInfo | null }>(`/api/share/${noteId}`, { signal }),
    create: (noteId: string, body: { password?: string | null; expiresIn?: number | null }) =>
      request<{ share: ShareInfo }>(`/api/share/${noteId}`, { method: 'POST', body }),
    remove: (noteId: string) => request<{ ok: true }>(`/api/share/${noteId}`, { method: 'DELETE' }),
    read: (slug: string, password?: string, signal?: AbortSignal) =>
      request<PublicNote>(`/api/public/${slug}`, { method: 'POST', body: { password }, signal }),
  },

  transfer: {
    save: saveDownload,
    import: (
      files: File[],
      conflict: 'skip' | 'newer' | 'duplicate' = 'newer',
      backup?: { manifest: MarkdownBackupManifest; paths: string[] },
    ) => {
      const form = new FormData()
      for (const file of files) form.append('file', file)
      form.append('conflict', conflict)
      if (backup) {
        form.append('backupManifest', JSON.stringify(backup.manifest))
        form.append('backupPaths', JSON.stringify(backup.paths))
      }
      return request<ImportResult>('/api/import', { method: 'POST', formData: form })
    },
  },
}

function toQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  if (!entries.length) return ''
  return `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`
}
