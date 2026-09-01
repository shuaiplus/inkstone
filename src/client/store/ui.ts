import { create } from 'zustand'
import type { AccentName, BackgroundName, EditorLayout, SortKey, SortOrder, ThemePref, UiDensity, ViewKind } from '@shared/types'
import { ACCENTS, LIMITS, VIEW_KINDS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import { UI_STORAGE_KEY } from '../lib/runtime'


const STORAGE_KEY = UI_STORAGE_KEY

export type PanelName =
  | 'ai'
  | 'command'
  | 'search'
  | 'settings'
  | 'shortcuts'
  | 'graph'
  | 'versions'
  | 'share'
  | 'info'

export type WorkspacePane = 'primary' | 'secondary'

export interface ToastItem {
  id: string
  title: string
  description?: string
  tone: 'default' | 'success' | 'danger' | 'warning'
  action?: { label: string; run: () => void }
  duration: number
}

interface UiState {

  navWidth: number
  listWidth: number
  navCollapsed: boolean
  listCollapsed: boolean

  navDrawerOpen: boolean
  splitRatio: number | null
  workspaceSplitRatio: number | null
  workspacePrimaryNoteId: string | null
  workspaceSecondaryNoteId: string | null
  activeWorkspacePane: WorkspacePane
  workspacePaneLayouts: Record<WorkspacePane, EditorLayout>
  mobilePane: 'nav' | 'list' | 'editor' | 'preview'


  view: ViewKind
  folderId: string | null
  tag: string | null
  sort: SortKey
  order: SortOrder
  density: UiDensity
  expandedFolders: string[]


  activeNoteId: string | null
  selectedIds: string[]
  recentNoteIds: string[]


  panel: PanelName | null
  outlineOpen: boolean
  backlinksOpen: boolean
  toasts: ToastItem[]
  lightbox: { src: string; alt: string } | null


  theme: ThemePref
  accent: AccentName
  background: BackgroundName
  fontScale: number


  setLayout: (patch: Partial<Pick<UiState, 'navWidth' | 'listWidth' | 'splitRatio' | 'workspaceSplitRatio'>>) => void
  setWorkspacePaneLayout: (pane: WorkspacePane, layout: EditorLayout) => void
  setWorkspaceNote: (pane: WorkspacePane, id: string | null, activate?: boolean) => void
  activateWorkspacePane: (pane: WorkspacePane) => void
  closeSecondaryNote: () => void
  removeWorkspaceNote: (id: string) => void
  toggleNav: () => void
  toggleNavDrawer: (open?: boolean) => void
  toggleList: () => void
  setMobilePane: (pane: UiState['mobilePane']) => void
  openView: (view: ViewKind, options?: { folderId?: string | null; tag?: string | null }) => void
  setSort: (sort: SortKey, order?: SortOrder) => void
  setDensity: (density: UiDensity) => void
  toggleFolder: (id: string) => void
  expandFolder: (id: string) => void
  setActiveNote: (id: string | null) => void
  setSelected: (ids: string[]) => void
  toggleSelected: (id: string, additive: boolean) => void
  openPanel: (panel: PanelName) => void
  closePanel: () => void
  togglePanel: (panel: PanelName) => void
  toggleOutline: () => void
  toggleBacklinks: () => void
  setLightbox: (value: UiState['lightbox']) => void
  toast: (input: Omit<ToastItem, 'id' | 'duration' | 'tone'> & { tone?: ToastItem['tone']; duration?: number }) => string
  dismissToast: (id: string) => void
  applyAppearance: (patch: { theme?: ThemePref; accent?: AccentName; background?: BackgroundName; fontScale?: number }) => void
}

export const PANEL_WIDTHS = {
  navigation: { min: 196, max: 380 },
  noteList: { min: 260, max: 520 },
} as const

export const DEFAULT_LAYOUT = {
  navWidth: PANEL_WIDTHS.navigation.min,
  listWidth: PANEL_WIDTHS.noteList.min,
  splitRatio: null as number | null,
} as const

const DEFAULTS = {
  ...DEFAULT_LAYOUT,
  navCollapsed: false,
  listCollapsed: false,
  view: 'all' as ViewKind,
  folderId: null,
  tag: null,
  sort: 'updated' as SortKey,
  order: 'desc' as SortOrder,
  density: 'comfortable' as UiDensity,
  expandedFolders: [] as string[],
  activeNoteId: null,
  workspaceSplitRatio: null as number | null,
  workspacePrimaryNoteId: null as string | null,
  workspaceSecondaryNoteId: null as string | null,
  activeWorkspacePane: 'primary' as WorkspacePane,
  workspacePaneLayouts: { primary: 'edit', secondary: 'edit' } as Record<WorkspacePane, EditorLayout>,
  recentNoteIds: [] as string[],
  theme: 'system' as ThemePref,
  accent: 'indigo' as AccentName,
  background: 'paper' as BackgroundName,
  fontScale: 16,
}

const PERSISTED_KEYS = [
  'navWidth',
  'listWidth',
  'navCollapsed',
  'listCollapsed',
  'splitRatio',
  'workspaceSplitRatio',
  'workspacePrimaryNoteId',
  'workspaceSecondaryNoteId',
  'activeWorkspacePane',
  'workspacePaneLayouts',
  'view',
  'folderId',
  'tag',
  'sort',
  'order',
  'density',
  'expandedFolders',
  'activeNoteId',
  'recentNoteIds',
  'theme',
  'accent',
  'background',
  'fontScale',
] as const

function loadPersisted(): Partial<UiState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const value = parsed as Record<string, unknown>
    const out: Partial<UiState> = {}

    if (isFiniteNumber(value.navWidth)) {
      out.navWidth = clamp(value.navWidth, PANEL_WIDTHS.navigation.min, PANEL_WIDTHS.navigation.max)
    }
    if (isFiniteNumber(value.listWidth)) {
      out.listWidth = clamp(value.listWidth, PANEL_WIDTHS.noteList.min, PANEL_WIDTHS.noteList.max)
    }
    if (typeof value.navCollapsed === 'boolean') out.navCollapsed = value.navCollapsed
    if (typeof value.listCollapsed === 'boolean') out.listCollapsed = value.listCollapsed
    if (isFiniteNumber(value.splitRatio)) out.splitRatio = clamp(value.splitRatio, 0.2, 0.8)
    if (isFiniteNumber(value.workspaceSplitRatio)) {
      out.workspaceSplitRatio = clamp(value.workspaceSplitRatio, 0.2, 0.8)
    }
    if (isChoice(value.view, VIEW_KINDS)) out.view = value.view as ViewKind
    if (value.folderId === null || typeof value.folderId === 'string') {
      out.folderId = value.folderId?.slice(0, 128) ?? null
    }
    if (value.tag === null || typeof value.tag === 'string') {
      out.tag = typeof value.tag === 'string' ? truncateText(value.tag, LIMITS.tagNameMaxLength) : null
    }
    if (isChoice(value.sort, ['updated', 'created', 'title'])) out.sort = value.sort as SortKey
    if (isChoice(value.order, ['asc', 'desc'])) out.order = value.order as SortOrder
    if (isChoice(value.density, ['comfortable', 'compact'])) out.density = value.density as UiDensity
    if (Array.isArray(value.expandedFolders)) {
      out.expandedFolders = uniqueStrings(value.expandedFolders, 500)
    }
    if (value.activeNoteId === null || typeof value.activeNoteId === 'string') {
      out.activeNoteId = value.activeNoteId?.slice(0, 128) ?? null
    }
    if (value.workspacePrimaryNoteId === null || typeof value.workspacePrimaryNoteId === 'string') {
      out.workspacePrimaryNoteId = value.workspacePrimaryNoteId?.slice(0, 128) ?? null
    }
    if (value.workspaceSecondaryNoteId === null || typeof value.workspaceSecondaryNoteId === 'string') {
      out.workspaceSecondaryNoteId = value.workspaceSecondaryNoteId?.slice(0, 128) ?? null
    }
    if (isChoice(value.activeWorkspacePane, ['primary', 'secondary'])) {
      out.activeWorkspacePane = value.activeWorkspacePane as WorkspacePane
    }
    if (value.workspacePaneLayouts && typeof value.workspacePaneLayouts === 'object' && !Array.isArray(value.workspacePaneLayouts)) {
      const layouts = value.workspacePaneLayouts as Record<string, unknown>
      out.workspacePaneLayouts = {
        primary: isChoice(layouts.primary, ['edit', 'split', 'preview']) ? layouts.primary as EditorLayout : 'edit',
        secondary: isChoice(layouts.secondary, ['edit', 'split', 'preview']) ? layouts.secondary as EditorLayout : 'edit',
      }
    }
    if (Array.isArray(value.recentNoteIds)) {
      out.recentNoteIds = uniqueStrings(value.recentNoteIds, 24)
    }
    if (isChoice(value.theme, ['light', 'dark', 'system'])) out.theme = value.theme as ThemePref
    if (isChoice(value.accent, ACCENTS.map((accent) => accent.name))) {
      out.accent = value.accent as AccentName
    }
    if (isChoice(value.background, ['paper', 'white'])) {
      out.background = value.background as BackgroundName
    }
    if (isFiniteNumber(value.fontScale)) out.fontScale = clamp(Math.round(value.fontScale), 13, 22)
    if (!out.workspaceSecondaryNoteId) {
      out.workspacePrimaryNoteId = null
      out.activeWorkspacePane = 'primary'
    } else if (!out.workspacePrimaryNoteId) {
      out.workspacePrimaryNoteId = out.activeNoteId ?? null
    }
    if (out.workspaceSecondaryNoteId && out.workspacePrimaryNoteId) {
      out.activeNoteId = out.activeWorkspacePane === 'secondary'
        ? out.workspaceSecondaryNoteId
        : out.workspacePrimaryNoteId
    }
    return out
  } catch {
    return {}
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isChoice(value: unknown, choices: readonly string[]): value is string {
  return typeof value === 'string' && choices.includes(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function uniqueStrings(value: unknown[], limit: number): string[] {
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    .slice(0, limit)
    .map((item) => item.slice(0, 128))
}

function activatedNoteFields(state: UiState, id: string | null, pane: WorkspacePane): Partial<UiState> {
  return {
    activeNoteId: id,
    activeWorkspacePane: pane,
    selectedIds: id ? [id] : [],
    recentNoteIds: id
      ? [id, ...state.recentNoteIds.filter((recentId) => recentId !== id)].slice(0, 24)
      : state.recentNoteIds,
    mobilePane: id ? 'preview' : state.mobilePane,
  }
}

let persistTimer: number | undefined
let lastPersisted = ''

function serializedPersistedState(state: UiState): string {
  const out: Record<string, unknown> = {}
  for (const key of PERSISTED_KEYS) out[key] = state[key]
  return JSON.stringify(out)
}

function persist(state: UiState): void {
  const serialized = serializedPersistedState(state)
  if (serialized === lastPersisted) return
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serialized)
      lastPersisted = serialized
    } catch {

    }
  }, 220)
}

let toastSeq = 0

export const useUi = create<UiState>((set, get) => ({
  ...DEFAULTS,
  selectedIds: [],
  navDrawerOpen: false,
  panel: null,
  outlineOpen: false,
  backlinksOpen: false,
  toasts: [],
  lightbox: null,
  mobilePane: 'list',
  ...loadPersisted(),

  setLayout: (patch) => set(patch),
  setWorkspacePaneLayout: (pane, layout) => set((state) => ({
    workspacePaneLayouts: { ...state.workspacePaneLayouts, [pane]: layout },
  })),
  setWorkspaceNote: (pane, id, activate = true) => set((state) => {
    if (pane === 'secondary') {
      if (!id) {
        const primaryId = state.workspacePrimaryNoteId ??
          (state.activeWorkspacePane === 'primary' ? state.activeNoteId : null)
        return {
          workspacePrimaryNoteId: null,
          workspaceSecondaryNoteId: null,
          ...activatedNoteFields(state, primaryId, 'primary'),
        }
      }
      const primaryId = state.workspaceSecondaryNoteId
        ? state.workspacePrimaryNoteId
        : state.activeNoteId
      return {
        workspacePrimaryNoteId: primaryId,
        workspaceSecondaryNoteId: id,
        outlineOpen: false,
        ...(activate ? activatedNoteFields(state, id, 'secondary') : {}),
      }
    }

    if (!id && state.workspaceSecondaryNoteId) {
      return {
        workspacePrimaryNoteId: null,
        workspaceSecondaryNoteId: null,
        ...activatedNoteFields(state, state.workspaceSecondaryNoteId, 'primary'),
      }
    }
    if (state.workspaceSecondaryNoteId) {
      return {
        workspacePrimaryNoteId: id,
        ...(activate ? activatedNoteFields(state, id, 'primary') : {}),
      }
    }
    return activatedNoteFields(state, id, 'primary')
  }),
  activateWorkspacePane: (pane) => set((state) => {
    const targetId = pane === 'secondary'
      ? state.workspaceSecondaryNoteId
      : state.workspaceSecondaryNoteId
        ? state.workspacePrimaryNoteId
        : state.activeNoteId
    if (!targetId) return state
    return {
      ...activatedNoteFields(state, targetId, pane),
      outlineOpen: false,
    }
  }),
  closeSecondaryNote: () => set((state) => {
    if (!state.workspaceSecondaryNoteId) return state
    const primaryId = state.workspacePrimaryNoteId ??
      (state.activeWorkspacePane === 'primary' ? state.activeNoteId : null)
    return {
      workspacePrimaryNoteId: null,
      workspaceSecondaryNoteId: null,
      ...activatedNoteFields(state, primaryId, 'primary'),
    }
  }),
  removeWorkspaceNote: (id) => set((state) => {
    const primaryId = state.workspacePrimaryNoteId
    const secondaryId = state.workspaceSecondaryNoteId
    if (primaryId === id && secondaryId === id) {
      return {
        workspacePrimaryNoteId: null,
        workspaceSecondaryNoteId: null,
        ...activatedNoteFields(state, null, 'primary'),
      }
    }
    if (primaryId === id && secondaryId) {
      return {
        workspacePrimaryNoteId: null,
        workspaceSecondaryNoteId: null,
        ...activatedNoteFields(state, secondaryId, 'primary'),
      }
    }
    if (secondaryId === id) {
      const remainingId = primaryId ?? (state.activeWorkspacePane === 'primary' ? state.activeNoteId : null)
      return {
        workspacePrimaryNoteId: null,
        workspaceSecondaryNoteId: null,
        ...activatedNoteFields(state, remainingId, 'primary'),
      }
    }
    if (!secondaryId && state.activeNoteId === id) {
      return activatedNoteFields(state, null, 'primary')
    }
    return state
  }),
  toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
  toggleNavDrawer: (open) => set((s) => ({ navDrawerOpen: open ?? !s.navDrawerOpen })),
  toggleList: () => set((s) => ({ listCollapsed: !s.listCollapsed })),
  setMobilePane: (mobilePane) => set({ mobilePane }),

  openView: (view, options) =>
    set({
      view,
      folderId: options?.folderId ?? null,
      tag: options?.tag ?? null,
      selectedIds: [],
      mobilePane: 'list',

      navDrawerOpen: false,
    }),

  setSort: (sort, order) => set((s) => ({ sort, order: order ?? s.order })),
  setDensity: (density) => set({ density }),

  toggleFolder: (id) =>
    set((s) => ({
      expandedFolders: s.expandedFolders.includes(id)
        ? s.expandedFolders.filter((f) => f !== id)
        : [...s.expandedFolders, id],
    })),

  expandFolder: (id) =>
    set((s) =>
      s.expandedFolders.includes(id) ? s : { expandedFolders: [...s.expandedFolders, id] },
    ),

  setActiveNote: (id) => {
    const state = get()
    const pane = state.workspaceSecondaryNoteId ? state.activeWorkspacePane : 'primary'
    state.setWorkspaceNote(pane, id)
  },

  setSelected: (ids) => set({ selectedIds: ids }),

  toggleSelected: (id, additive) =>
    set((s) => {
      if (!additive) return { selectedIds: [id] }
      return {
        selectedIds: s.selectedIds.includes(id)
          ? s.selectedIds.filter((x) => x !== id)
          : [...s.selectedIds, id],
      }
    }),

  openPanel: (panel) => set({ panel }),
  closePanel: () => set({ panel: null }),
  togglePanel: (panel) => set((s) => ({ panel: s.panel === panel ? null : panel })),
  toggleOutline: () => set((s) => ({ outlineOpen: !s.outlineOpen })),
  toggleBacklinks: () => set((s) => ({ backlinksOpen: !s.backlinksOpen })),
  setLightbox: (lightbox) => set({ lightbox }),

  toast: (input) => {
    const id = `t${++toastSeq}`
    const item: ToastItem = {
      id,
      title: input.title,
      description: input.description,
      tone: input.tone ?? 'default',
      action: input.action,
      duration: input.duration ?? (input.tone === 'danger' ? 6000 : 3800),
    }
    set((s) => ({ toasts: [...s.toasts.slice(-4), item] }))
    return id
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  applyAppearance: (patch) => {
    set(patch)
    applyThemeToDom(get())
  },
}))

lastPersisted = serializedPersistedState(useUi.getState())
useUi.subscribe(persist)

export function applyThemeToDom(state: Pick<UiState, 'theme' | 'accent' | 'background' | 'fontScale'>): void {
  const root = document.documentElement
  const dark =
    state.theme === 'dark' ||
    (state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  root.dataset.theme = dark ? 'dark' : 'light'
  root.dataset.accent = state.accent
  root.dataset.background = state.background
}

let themeTransitionTimer: number | undefined

export function switchThemeWithTransition(
  next: ThemePref,
  origin?: { x: number; y: number },
  commit?: () => void,
): void {
  const ui = useUi.getState()
  const apply = commit ?? (() => ui.applyAppearance({ theme: next }))
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void> }
  }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const root = document.documentElement
  window.clearTimeout(themeTransitionTimer)
  themeTransitionTimer = undefined
  root.classList.remove('theme-transition')

  if (!doc.startViewTransition || reduced || !origin) {
    root.classList.add('theme-transition')
    apply()
    themeTransitionTimer = window.setTimeout(() => {
      root.classList.remove('theme-transition')
      themeTransitionTimer = undefined
    }, 300)
    return
  }

  const transition = doc.startViewTransition(() => {
    apply()
  })

  void transition.ready.then(() => {
    const radius = Math.hypot(
      Math.max(origin.x, innerWidth - origin.x),
      Math.max(origin.y, innerHeight - origin.y),
    )
    document.documentElement.animate(
      {
        clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`],
      },
      {
        duration: 460,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        pseudoElement: '::view-transition-new(root)',
      },
    )
  }).catch(() => {})
}
