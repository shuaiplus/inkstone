import { CLIENT_HEADER } from '@shared/constants'
import type {
  AppLocale,
  Attachment,
  BackupRun,
  BackupTarget,
  BackupTargetInput,
  Backlink,
  Folder,
  GraphResponse,
  ImportResult,
  ListNotesResponse,
  Note,
  NoteVersion,
  NoteVersionMeta,
  PatchNoteBody,
  PublicUser,
  PublicNote,
  SearchResponse,
  SessionInfo,
  ShareInfo,
  SyncResponse,
  Tag,
  TestConnectionResult,
  UserSettings,
  AiContentRequest,
  AiContinueRequest,
  AiDraftRequest,
  AiEditRequest,
  AiImageRequest,
  AiImageResponse,
  AiConfig,
  AiConfigPatch,
  AiConfigTestRequest,
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

async function download(path: string, fallbackName: string): Promise<{ blob: Blob; filename: string }> {
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
  return { blob: await response.blob(), filename }
}

async function saveDownload(format: 'json' | 'zip'): Promise<void> {
  const { blob, filename } = await download(
    `/api/export?format=${format}`,
    `inkstone-export.${format}`,
  )
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
      request<SessionInfo>('/api/auth/login', { method: 'POST', body: { username, password } }),
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
      }),
  },

  notes: {
    list: (params: Record<string, string | number | undefined>) =>
      request<ListNotesResponse>(`/api/notes${toQuery(params)}`),
    get: (id: string) => request<Note>(`/api/notes/${id}`),
    create: (body: { id?: string; content?: string; title?: string; folderId?: string | null }) =>
      request<Note>('/api/notes', { method: 'POST', body, timeoutMs: 30_000 }),
    patch: (id: string, body: PatchNoteBody) =>
      request<Note>(`/api/notes/${id}`, { method: 'PATCH', body, timeoutMs: 30_000 }),
    remove: (id: string) => request<Note>(`/api/notes/${id}`, { method: 'DELETE' }),
    restore: (id: string) => request<Note>(`/api/notes/${id}/restore`, { method: 'POST' }),
    purge: (id: string) => request<{ ok: true; cursor: number }>(`/api/notes/${id}/purge`, { method: 'DELETE' }),
    duplicate: (id: string) => request<Note>(`/api/notes/${id}/duplicate`, { method: 'POST' }),
    emptyTrash: () => request<{ purged: number }>('/api/notes/trash/empty', { method: 'POST' }),
    versions: (id: string) => request<{ versions: NoteVersionMeta[] }>(`/api/notes/${id}/versions`),
    version: (id: string, versionId: string) =>
      request<NoteVersion>(`/api/notes/${id}/versions/${versionId}`),
    restoreVersion: (id: string, versionId: string) =>
      request<Note>(`/api/notes/${id}/versions/${versionId}/restore`, { method: 'POST' }),
    backlinks: (id: string) => request<{ backlinks: Backlink[] }>(`/api/notes/${id}/backlinks`),
  },

  folders: {
    list: () => request<{ folders: Folder[] }>('/api/folders'),
    create: (body: { name?: string; parentId?: string | null; icon?: string | null }) =>
      request<Folder>('/api/folders', { method: 'POST', body }),
    patch: (id: string, body: { name?: string; parentId?: string | null; icon?: string | null }) =>
      request<Folder>(`/api/folders/${id}`, { method: 'PATCH', body }),
    remove: (id: string, strategy: 'move-up' | 'delete' = 'move-up') =>
      request<{ ok: true }>(`/api/folders/${id}?strategy=${strategy}`, { method: 'DELETE' }),
  },

  tags: {
    list: () => request<{ tags: Tag[] }>('/api/tags'),
    patch: (id: string, body: { name?: string; color?: string | null }) =>
      request<Tag | { ok: true; renamed: number }>(`/api/tags/${id}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      request<{ ok: true; affected: number }>(`/api/tags/${id}`, { method: 'DELETE' }),
  },

  search: (q: string, limit = 50, signal?: AbortSignal) =>
    request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal }),
  reindex: () => request<{ ok: true; indexed: number }>('/api/search/reindex', { method: 'POST' }),
  graph: () => request<GraphResponse>('/api/graph'),

  sync: (since: number, options: { after?: string; snapshot?: number } = {}) =>
    request<SyncResponse>(
      `/api/sync${toQuery({ since, after: options.after, snapshot: options.snapshot })}`,
      { timeoutMs: 30_000 },
    ),

  files: {
    list: () => request<{ files: Attachment[] }>('/api/files'),
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
    patch: (id: string, body: Partial<BackupTargetInput>) =>
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

  share: {
    get: (noteId: string) => request<{ share: ShareInfo | null }>(`/api/share/${noteId}`),
    create: (noteId: string, body: { password?: string | null; expiresIn?: number | null }) =>
      request<{ share: ShareInfo }>(`/api/share/${noteId}`, { method: 'POST', body }),
    remove: (noteId: string) => request<{ ok: true }>(`/api/share/${noteId}`, { method: 'DELETE' }),
    read: (slug: string, password?: string, signal?: AbortSignal) =>
      request<PublicNote>(`/api/public/${slug}`, { method: 'POST', body: { password }, signal }),
  },

  transfer: {
    save: saveDownload,
    import: (files: File[], conflict: 'skip' | 'newer' | 'duplicate' = 'newer') => {
      const form = new FormData()
      for (const file of files) form.append('file', file)
      form.append('conflict', conflict)
      return request<ImportResult>('/api/import', { method: 'POST', formData: form })
    },
  },

  ai: {
    stream: (
      task: 'summarize' | 'polish' | 'draft' | 'edit' | 'continue',
      body: AiContentRequest | AiDraftRequest | AiEditRequest | AiContinueRequest,
      onDelta: (chunk: string) => void,
      signal?: AbortSignal,
    ): Promise<void> => streamAi(`/api/ai/${task}`, body, onDelta, signal),
    image: (body: AiImageRequest, signal?: AbortSignal) =>
      request<AiImageResponse>('/api/ai/image', { method: 'POST', body, signal }),
    getConfig: () => request<AiConfig>('/api/ai/config'),
    saveConfig: (body: AiConfigPatch) =>
      request<AiConfig>('/api/ai/config', { method: 'PUT', body }),
    testConfig: (body: AiConfigTestRequest, signal?: AbortSignal) =>
      request<TestConnectionResult>('/api/ai/test', { method: 'POST', body, signal }),
  },
}

function toQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  if (!entries.length) return ''
  return `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`
}

async function streamAi(
  path: string,
  body: AiContentRequest | AiDraftRequest | AiEditRequest | AiContinueRequest,
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      [CLIENT_HEADER]: '1',
      'X-Inkstone-Origin': CLIENT_ID,
      'Accept-Language': getLocale(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...body, locale: body.locale ?? getLocale() }),
    credentials: 'same-origin',
    signal,
  })

  if (!response.ok) {
    const data = isJsonResponse(response) ? await response.json().catch(() => null) : null
    const error = (data as { error?: { code: string; message: string; details?: unknown } } | null)?.error
    const code = error?.code ?? 'unknown'
    const fallback = error?.message ?? t('api.request_failed_status', { status: response.status })
    throw new ApiError(response.status, code, translateApiError(code, fallback), error?.details)
  }

  if (!response.body) throw new ApiError(502, 'invalid_response', t('api.invalid_server_response'))

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  const processLine = (raw: string): boolean => {
    const line = raw.replace(/\r$/, '')
    if (line === '') {
      eventName = ''
      return false
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      return false
    }
    if (!line.startsWith('data:')) return false
    const data = line.slice(5).trim()
    if (data === '[DONE]') return true
    try {
      const parsed = JSON.parse(data) as unknown
      if (eventName === 'error') {
        const message = typeof parsed === 'string'
          ? parsed
          : (parsed as { message?: unknown } | null)?.message
        throw new ApiError(
          502,
          'server_misconfigured',
          typeof message === 'string' ? message : t('ai.request_failed'),
        )
      }
      if (typeof parsed === 'string') onDelta(parsed)
    } catch (err) {
      if (err instanceof ApiError) throw err
    }
    return false
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const raw of parts) {
        if (processLine(raw)) return
      }
    }
    buffer += decoder.decode()
    if (buffer && processLine(buffer)) return
  } finally {
    reader.releaseLock()
  }
}
