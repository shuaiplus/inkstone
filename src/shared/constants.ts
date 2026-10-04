import type { AccentName, UserSettings, ViewKind } from './types'
import { version as packageVersion } from '../../package.json'

export const APP_VERSION = packageVersion
export const GITHUB_REPOSITORY_URL = 'https://github.com/shuaiplus/inkstone'
export const GITHUB_PACKAGE_URL =
  'https://raw.githubusercontent.com/shuaiplus/inkstone/refs/heads/main/package.json'
export const CLIENT_HEADER = 'X-Inkstone-Client'
export const SESSION_COOKIE = '__Host-inkstone_session'
export const LEGACY_SESSION_COOKIE = 'inkstone_session'

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000
export const SESSION_RENEW_BEFORE_MS = SESSION_TTL_MS / 2


export const LIMITS = {
  passwordMaxLength: 128,
  titleMaxLength: 512,
  // D1 limits an entire row to 2,000,000 bytes; reserve room for note metadata.
  contentMaxBytes: 1_900_000,
  folderNameMaxLength: 120,
  tagNameMaxLength: 60,
  folderDepthMax: 12,
  attachmentMaxBytes: 25 * 1024 * 1024,
  attachmentQuotaBytes: 1024 * 1024 * 1024,
  attachmentUploadsPerHour: 100,
  importFilesMax: 500,
  importUploadMaxBytes: 64 * 1024 * 1024,
  importBundleMaxBytes: 32 * 1024 * 1024,
  importArchiveEntriesMax: 2500,
  importArchiveExpandedMaxBytes: 80 * 1024 * 1024,
  versionsPerNote: 50,
  backupRunsKept: 50,
  backupTargetsMax: 12,
  changeLogKept: 5000,
  syncBatchSize: 500,
  searchLimit: 50,

  ftsContentChars: 200_000,
} as const

export const ACCENTS: { name: AccentName; swatch: string; foreground: string }[] = [
  { name: 'cinnabar', swatch: 'oklch(58% 0.15 31)', foreground: 'white' },
  { name: 'indigo', swatch: 'oklch(62% 0.16 252)', foreground: 'white' },
  { name: 'celadon', swatch: 'oklch(66% 0.13 150)', foreground: 'oklch(16% 0.008 265)' },
  { name: 'amber', swatch: 'oklch(76% 0.15 95)', foreground: 'oklch(16% 0.008 265)' },
  { name: 'terracotta', swatch: 'oklch(68% 0.1 205)', foreground: 'oklch(16% 0.008 265)' },
  { name: 'wisteria', swatch: 'oklch(62% 0.16 300)', foreground: 'white' },
  { name: 'graphite', swatch: 'oklch(55% 0.035 250)', foreground: 'white' },
]

export const PROSE_WIDTH_CH: Record<string, string> = {
  narrow: '58ch',
  normal: '72ch',
  wide: '88ch',
  full: '100%',
}

export const VIEW_KINDS: ViewKind[] = ['all', 'recent', 'starred', 'unfiled', 'archived', 'trash', 'folder', 'tag']

export const DEFAULT_SETTINGS: UserSettings = {
  appearance: {
    language: 'zh-CN',
    theme: 'system',
    accent: 'cinnabar',
    background: 'paper',
    density: 'comfortable',
    proseFont: 'sans',
    proseSize: 16,
    proseWidth: 'normal',
    proseLineHeight: 1.65,
  },
  editor: {
    fontSize: 15,
    fontFamily: 'mono',
    lineNumbers: false,
    typewriter: false,
    focusMode: false,
    spellcheck: false,
    showToolbar: true,
    livePreview: true,
    tabSize: 2,
    autoSaveDelay: 500,
  },
  preview: {
    layout: 'live',
    syncScroll: true,
    showToc: true,
    math: true,
    mermaid: true,
    codeBlockCollapse: true,
    codeBlockCollapseLines: 24,
  },
  backup: {
    schedule: 'sixHourly',
    retentionCount: 0,
  },
  sync: {
    realtime: true,
    pollIntervalMs: 15_000,
  },
}

export const BACKUP_INTERVALS: Record<string, number> = {
  off: 0,
  hourly: 60 * 60 * 1000,
  sixHourly: 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
}

const THEMES = ['light', 'dark', 'system'] as const
const LANGUAGES = ['zh-CN', 'en-US'] as const
const ACCENT_NAMES = ACCENTS.map((accent) => accent.name)
const BACKGROUND_NAMES = ['paper', 'white'] as const
const DENSITIES = ['comfortable', 'compact'] as const
const PROSE_FONTS = ['sans', 'serif'] as const
const PROSE_WIDTHS = ['narrow', 'normal', 'wide', 'full'] as const
const EDITOR_FONTS = ['mono', 'sans'] as const
const EDITOR_LAYOUTS = ['live', 'split', 'preview'] as const
const BACKUP_SCHEDULES = ['off', 'hourly', 'sixHourly', 'daily', 'weekly', 'monthly', 'yearly'] as const


export function mergeSettings(partial: unknown): UserSettings {
  const base = cloneDefaultSettings()
  const src = asRecord(partial)
  const appearance = asRecord(src.appearance)
  const editor = asRecord(src.editor)
  const preview = asRecord(src.preview)
  const backup = asRecord(src.backup)
  const sync = asRecord(src.sync)

  base.appearance.theme = enumValue(appearance.theme, THEMES, base.appearance.theme)
  base.appearance.language = enumValue(
    appearance.language,
    LANGUAGES,
    base.appearance.language,
  )
  base.appearance.accent = enumValue(appearance.accent, ACCENT_NAMES, base.appearance.accent)
  base.appearance.background = enumValue(
    appearance.background,
    BACKGROUND_NAMES,
    base.appearance.background,
  )
  base.appearance.density = enumValue(
    appearance.density,
    DENSITIES,
    base.appearance.density,
  )
  base.appearance.proseFont = enumValue(
    appearance.proseFont,
    PROSE_FONTS,
    base.appearance.proseFont,
  )
  base.appearance.proseSize = integerInRange(
    appearance.proseSize,
    13,
    22,
    base.appearance.proseSize,
  )
  base.appearance.proseWidth = enumValue(
    appearance.proseWidth,
    PROSE_WIDTHS,
    base.appearance.proseWidth,
  )
  base.appearance.proseLineHeight = numberInRange(
    appearance.proseLineHeight,
    1.4,
    2.2,
    base.appearance.proseLineHeight,
  )

  base.editor.fontSize = integerInRange(editor.fontSize, 12, 22, base.editor.fontSize)
  base.editor.fontFamily = enumValue(editor.fontFamily, EDITOR_FONTS, base.editor.fontFamily)
  base.editor.lineNumbers = booleanValue(editor.lineNumbers, base.editor.lineNumbers)
  base.editor.typewriter = booleanValue(editor.typewriter, base.editor.typewriter)
  base.editor.focusMode = booleanValue(editor.focusMode, base.editor.focusMode)
  base.editor.spellcheck = booleanValue(editor.spellcheck, base.editor.spellcheck)
  base.editor.showToolbar = booleanValue(editor.showToolbar, base.editor.showToolbar)
  base.editor.livePreview = booleanValue(editor.livePreview, base.editor.livePreview)
  base.editor.tabSize = editor.tabSize === 4 ? 4 : editor.tabSize === 2 ? 2 : base.editor.tabSize
  base.editor.autoSaveDelay = integerInRange(
    editor.autoSaveDelay,
    200,
    3000,
    base.editor.autoSaveDelay,
  )

  base.preview.layout = enumValue(preview.layout, EDITOR_LAYOUTS, base.preview.layout)
  base.preview.syncScroll = booleanValue(preview.syncScroll, base.preview.syncScroll)
  base.preview.showToc = booleanValue(preview.showToc, base.preview.showToc)
  base.preview.math = booleanValue(preview.math, base.preview.math)
  base.preview.mermaid = booleanValue(preview.mermaid, base.preview.mermaid)
  base.preview.codeBlockCollapse = booleanValue(preview.codeBlockCollapse, base.preview.codeBlockCollapse)
  base.preview.codeBlockCollapseLines = integerInRange(
    preview.codeBlockCollapseLines,
    8,
    100,
    base.preview.codeBlockCollapseLines,
  )

  base.backup.schedule = enumValue(
    backup.schedule,
    BACKUP_SCHEDULES,
    base.backup.schedule,
  )
  base.backup.retentionCount = integerInRange(backup.retentionCount, 0, 1000, base.backup.retentionCount)

  base.sync.realtime = booleanValue(sync.realtime, base.sync.realtime)
  base.sync.pollIntervalMs = integerInRange(
    sync.pollIntervalMs,
    5000,
    120_000,
    base.sync.pollIntervalMs,
  )

  return base
}


export function mergeSettingsPatch(current: unknown, patch: unknown): UserSettings {
  const previous = asRecord(current)
  const incoming = asRecord(patch)
  const combined: Record<string, unknown> = { ...previous }
  for (const section of ['appearance', 'editor', 'preview', 'backup', 'sync'] as const) {
    combined[section] = {
      ...asRecord(previous[section]),
      ...asRecord(incoming[section]),
    }
  }
  return mergeSettings(combined)
}

function cloneDefaultSettings(): UserSettings {
  return {
    appearance: { ...DEFAULT_SETTINGS.appearance },
    editor: { ...DEFAULT_SETTINGS.editor },
    preview: { ...DEFAULT_SETTINGS.preview },
    backup: { ...DEFAULT_SETTINGS.backup },
    sync: { ...DEFAULT_SETTINGS.sync },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(numberInRange(value, min, max, fallback))
}
