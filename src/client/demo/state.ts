import { LIMITS, mergeSettings } from '@shared/constants'
import { countText, deriveExcerpt, deriveTitle, extractTags, sortTagNames } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import { welcomeNoteTemplates } from '@shared/welcome-notes'
import type {
  Attachment,
  BackupRun,
  BackupTarget,
  Folder,
  Note,
  NoteSummary,
  NoteVersion,
  PublicUser,
  ShareInfo,
  Tag,
  UserSettings,
} from '@shared/types'

export interface DemoAttachment {
  meta: Attachment
  file: File
}

export interface DemoShare {
  info: ShareInfo
  password: string | null
}

export interface DemoState {
  authenticated: boolean
  password: string
  registrationOpen: boolean
  cursor: number
  user: PublicUser
  settings: UserSettings
  notes: Map<string, Note>
  folders: Map<string, Folder>
  tagIds: Map<string, string>
  tagColors: Map<string, string | null>
  versions: Map<string, NoteVersion[]>
  attachments: Map<string, DemoAttachment>
  shares: Map<string, DemoShare>
  backupTargets: Map<string, BackupTarget>
  backupRuns: BackupRun[]
}

const seedId = (value: number) => `01j${String(value).padStart(23, '0')}`

export function newDemoId(): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
  const bytes = crypto.getRandomValues(new Uint8Array(26))
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join('')
}

export function createDemoState(): DemoState {
  const now = Date.now()
  const folders: Folder[] = []
  const notes = welcomeNoteTemplates('zh-CN').map(({ content }, index) =>
    note(seedId(20 + index), content, null, now - index, { isPinned: true, isStarred: true }),
  )
  const tagIds = new Map<string, string>()
  for (const item of notes) {
    for (const name of item.tags) if (!tagIds.has(name)) tagIds.set(name, newDemoId())
  }
  const tagColors = new Map<string, string | null>([['getting-started', '#6366f1']])
  const preferredLocaleTag = notes[0]?.tags.find((name) => name !== 'Inkstone')
  if (preferredLocaleTag) tagColors.set(preferredLocaleTag, '#b5482e')
  const welcomeShare: ShareInfo = {
    slug: 'welcome',
    noteId: notes[0]!.id,
    url: '/s/welcome',
    hasPassword: false,
    expiresAt: null,
    views: 12,
    createdAt: now - 86_400_000 * 4,
  }

  return {
    authenticated: false,
    password: 'password',
    registrationOpen: false,
    cursor: 1,
    user: {
      id: seedId(1),
      login: 'admin',
      username: 'admin',
      name: 'Demo Admin',
      avatarUrl: 'dicebear:0123456789abcdef0123456789abcdef',
      role: 'owner',
      createdAt: now - 86_400_000 * 30,
    },
    settings: mergeSettings({ sync: { realtime: false, pollIntervalMs: 300_000 } }),
    notes: new Map(notes.map((item) => [item.id, item])),
    folders: new Map(folders.map((item) => [item.id, item])),
    tagIds,
    tagColors,
    versions: new Map(),
    attachments: new Map(),
    shares: new Map([[welcomeShare.noteId, { info: welcomeShare, password: null }]]),
    backupTargets: new Map(),
    backupRuns: [],
  }
}

export function summarize(note: Note): NoteSummary {
  const { content: _content, ...summary } = note
  return summary
}

export function refreshNote(note: Note, content: string, title?: string): Note {
  const counted = countText(content)
  return {
    ...note,
    content,
    title: title === undefined ? note.title : truncateText(title.trim(), LIMITS.titleMaxLength),
    excerpt: deriveExcerpt(content),
    tags: sortTagNames(extractTags(content)),
    wordCount: counted.words,
    charCount: counted.chars,
  }
}

export function listFolders(state: DemoState): Folder[] {
  return [...state.folders.values()]
    .map((item) => ({
      ...item,
      noteCount: [...state.notes.values()].filter(
        (note) => note.folderId === item.id && note.deletedAt === null,
      ).length,
    }))
    .sort((left, right) => left.position - right.position || left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}

export function listTags(state: DemoState): Tag[] {
  const counts = new Map<string, number>()
  for (const item of state.notes.values()) {
    if (item.deletedAt !== null) continue
    for (const name of item.tags) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const names = new Set([...state.tagIds.keys(), ...counts.keys()])
  return sortTagNames(names).map((name) => {
    let id = state.tagIds.get(name)
    if (!id) {
      id = newDemoId()
      state.tagIds.set(name, id)
    }
    return {
      id,
      name,
      color: state.tagColors.get(name) ?? null,
      count: counts.get(name) ?? 0,
      createdAt: Date.now() - 86_400_000,
    }
  })
}

function note(
  id: string,
  content: string,
  folderId: string | null,
  createdAt: number,
  flags: Partial<Pick<Note, 'isPinned' | 'isStarred' | 'isArchived' | 'deletedAt'>> = {},
): Note {
  const counted = countText(content)
  return {
    id,
    title: deriveTitle(content),
    excerpt: deriveExcerpt(content),
    content,
    folderId,
    tags: sortTagNames(extractTags(content)),
    isPinned: flags.isPinned ?? false,
    isStarred: flags.isStarred ?? false,
    isArchived: flags.isArchived ?? false,
    wordCount: counted.words,
    charCount: counted.chars,
    rev: 1,
    position: createdAt,
    createdAt,
    updatedAt: createdAt,
    deletedAt: flags.deletedAt ?? null,
  }
}
