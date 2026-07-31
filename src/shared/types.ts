


export type UserRole = 'owner' | 'member'

export interface PublicUser {
  id: string
  login: string
  name: string
  avatarUrl: string
  role: UserRole
  createdAt: number

  username: string
}

export interface SiteInfo {
  name: string

  initialized: boolean

  registrationOpen: boolean

  r2Enabled: boolean

  kvEnabled: boolean

  attachmentStorage: 'r2' | 'kv' | null

  realtimeEnabled: boolean
  version: string
}

export interface SessionInfo {
  user: PublicUser | null
  site: SiteInfo
  settings: UserSettings | null
}


export type ThemePref = 'light' | 'dark' | 'system'
export type AppLocale = 'zh-CN' | 'en-US'
export type AccentName = 'cinnabar' | 'indigo' | 'celadon' | 'amber' | 'terracotta' | 'wisteria' | 'graphite'
export type UiDensity = 'comfortable' | 'compact'
export type ProseFont = 'sans' | 'serif'
export type ProseWidth = 'narrow' | 'normal' | 'wide' | 'full'
export type EditorLayout = 'edit' | 'split' | 'preview'
export type BackupSchedule = 'off' | 'hourly' | 'sixHourly' | 'daily'

export interface AppearanceSettings {
  language: AppLocale
  theme: ThemePref
  accent: AccentName
  density: UiDensity
  proseFont: ProseFont
  proseSize: number
  proseWidth: ProseWidth
  proseLineHeight: number
}

export interface EditorSettings {
  fontSize: number
  fontFamily: 'mono' | 'sans'
  lineNumbers: boolean
  typewriter: boolean
  focusMode: boolean
  spellcheck: boolean
  showToolbar: boolean
  tabSize: number
  autoSaveDelay: number
}

export interface PreviewSettings {
  layout: EditorLayout
  syncScroll: boolean
  showToc: boolean
  math: boolean
  mermaid: boolean
}

export interface BackupSettings {
  schedule: BackupSchedule
}

export interface SyncSettings {
  realtime: boolean
  pollIntervalMs: number
}

export interface UserSettings {
  appearance: AppearanceSettings
  editor: EditorSettings
  preview: PreviewSettings
  backup: BackupSettings
  sync: SyncSettings
}


export interface NoteSummary {
  id: string
  title: string
  excerpt: string
  folderId: string | null
  tags: string[]
  isPinned: boolean
  isStarred: boolean
  isArchived: boolean
  wordCount: number
  charCount: number
  rev: number
  position: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface Note extends NoteSummary {
  content: string
}

export interface Folder {
  id: string
  parentId: string | null
  name: string
  icon: string | null
  position: number
  createdAt: number
  updatedAt: number

  noteCount?: number
}

export interface Tag {
  id: string
  name: string
  color: string | null
  count: number
  createdAt: number
}

export interface NoteVersionMeta {
  id: string
  noteId: string
  title: string
  size: number
  createdAt: number
}

export interface NoteVersion extends NoteVersionMeta {
  content: string
}

export interface Backlink {
  id: string
  title: string
  context: string
}

export interface Attachment {
  id: string
  noteId: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  url: string
  createdAt: number
}


export type ViewKind =
  | 'all'
  | 'recent'
  | 'starred'
  | 'unfiled'
  | 'archived'
  | 'trash'
  | 'folder'
  | 'tag'

export type SortKey = 'updated' | 'created' | 'title'
export type SortOrder = 'asc' | 'desc'

export interface ListNotesQuery {
  view?: ViewKind
  folderId?: string
  tag?: string
  sort?: SortKey
  order?: SortOrder
  limit?: number
  cursor?: string
}

export interface ListNotesResponse {
  notes: NoteSummary[]
  nextCursor: string | null
  total: number
}

export interface CreateNoteBody {
  id?: string
  title?: string
  content?: string
  folderId?: string | null
}

export interface PatchNoteBody {
  rev: number
  title?: string
  content?: string
  folderId?: string | null
  isPinned?: boolean
  isStarred?: boolean
  isArchived?: boolean

  quiet?: boolean
  preserveVersion?: boolean
}

export interface ConflictPayload {
  code: 'conflict'
  message: string
  server: Note
}


export type SearchMode = 'fts' | 'like'

export interface SearchHit {
  note: NoteSummary
  snippet: string
  score: number
}

export interface SearchResponse {
  results: SearchHit[]
  mode: SearchMode
  took: number
  query: {
    text: string
    tags: string[]
    folder: string | null
    starred: boolean | null
    archived: boolean | null
  }
}

export interface GraphNode {
  id: string
  title: string
  degree: number
  folderId: string | null
}

export interface GraphEdge {
  source: string
  target: string
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
}


export interface SyncDeletion {
  entity: 'note' | 'folder' | 'tag'
  id: string
}

export interface SyncResponse {
  cursor: number
  full: boolean

  hasMore: boolean

  nextKey: string | null

  facetsFull: boolean

  settingsChanged: boolean
  profileChanged?: boolean
  notes: NoteSummary[]
  folders: Folder[]
  tags: Tag[]
  deletions: SyncDeletion[]
  serverTime: number
}

export type RealtimeMessage =
  | { type: 'changed'; cursor: number; origin: string | null }
  | { type: 'ping' }
  | { type: 'pong'; serverTime: number }


export type BackupTargetType = 'webdav' | 's3'
export type BackupMode = 'archive' | 'mirror'

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  pathStyle: boolean
  mode: BackupMode
}

export interface WebdavConfig {
  url: string
  username: string
  prefix: string
  mode: BackupMode
}

export type BackupTargetConfig = S3Config | WebdavConfig

export interface BackupTarget {
  id: string
  type: BackupTargetType
  name: string
  enabled: boolean
  config: BackupTargetConfig
  hasSecret: boolean
  lastRunAt: number | null
  lastStatus: 'success' | 'failed' | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface BackupTargetInput {
  type: BackupTargetType
  name: string
  enabled?: boolean
  config: Partial<S3Config> & Partial<WebdavConfig>

  secret?: {
    password?: string
    accessKeyId?: string
    secretAccessKey?: string
  }
}

export interface BackupTargetResult {
  targetId: string
  targetName: string
  targetType: BackupTargetType
  ok: boolean
  files: number
  bytes: number
  ms: number
  error: string | null
}

export interface BackupRun {
  id: string
  trigger: 'manual' | 'cron'
  status: 'running' | 'success' | 'partial' | 'failed'
  startedAt: number
  finishedAt: number | null
  noteCount: number
  fileCount: number
  bytes: number
  results: BackupTargetResult[]
}

export interface TestConnectionResult {
  ok: boolean
  message: string
  detail?: string
  latencyMs?: number
}


export interface ShareInfo {
  slug: string
  noteId: string
  url: string
  hasPassword: boolean
  expiresAt: number | null
  views: number
  createdAt: number
}

export interface PublicNote {
  title: string
  content: string
  updatedAt: number
  createdAt: number
  author: { name: string; avatarUrl: string }
  site: { name: string }
  share: { slug: string }
}


export interface ExportBundle {

  format: string
  version: 1
  exportedAt: number
  user: { login: string; name: string }
  folders: Folder[]
  tags: Tag[]
  notes: Note[]

  attachments: ExportAttachment[]
}

export interface ExportAttachment {
  id: string
  noteId: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  createdAt: number
  path: string
  sha256: string
}

export interface ImportResult {
  createdNotes: number
  updatedNotes: number
  skippedNotes: number
  createdFolders: number
  createdAttachments: number
  skippedAttachments: number
  warnings: string[]
}


export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type AiTask = 'summarize' | 'polish' | 'draft' | 'edit'

export interface AiContentRequest {
  content: string
  selection?: string
  locale?: AppLocale
}

export interface AiDraftRequest {
  topic: string
  locale?: AppLocale
}

export interface AiEditRequest {
  instruction: string
  content: string
  selection?: string
  locale?: AppLocale
}

export interface AiConfig {
  baseUrl: string
  model: string
  hasKey: boolean
}

export interface AiConfigPatch {
  baseUrl?: string
  model?: string
  apiKey?: string | null
}

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'bad_request'
  | 'payload_too_large'
  | 'storage_unavailable'
  | 'internal'
  | 'invalid_username'
  | 'invalid_profile_name'
  | 'invalid_avatar'
  | 'weak_password'
  | 'username_taken'
  | 'invalid_credentials'
  | 'wrong_password'
  | 'too_many_attempts'
  | 'registration_closed'
  | 'server_misconfigured'