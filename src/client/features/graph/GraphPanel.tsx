import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownToLine,
  ArrowRight,
  CircleDot,
  Filter,
  FolderOpen,
  Maximize2,
  Minus,
  Network,
  PanelRightClose,
  Plus,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import type { GraphNode, GraphQuery, GraphResponse } from '@shared/types'
import { organizerColorOrNull } from '@shared/organizer-colors'
import { truncateText } from '@shared/text-utils'
import { api } from '../../lib/api'
import { Button, IconButton } from '../../components/primitives'
import { Menu, Tooltip, useDialogFocus, useEscape, useLockScroll, type MenuItem } from '../../components/overlay'
import { Empty, LoadingBlock } from '../../components/feedback'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'

const PHYSICS_FRAME_LIMIT = 360
const GRAPH_PREFS_KEY = 'inkstone.graph.preferences.v1'

type GroupBy = 'none' | 'folder' | 'tag'
interface GraphPreferences {
  mode: 'global' | 'local'
  depth: number
  includeOrphans: boolean
  includeUnresolved: boolean
  arrows: boolean
  labels: boolean
  groupBy: GroupBy
  folderId: string
  tag: string
  repulsion: number
  linkDistance: number
  nodeScale: number
}

const DEFAULT_PREFERENCES: GraphPreferences = {
  mode: 'global',
  depth: 1,
  includeOrphans: true,
  includeUnresolved: true,
  arrows: true,
  labels: true,
  groupBy: 'none',
  folderId: '',
  tag: '',
  repulsion: 900,
  linkDistance: 76,
  nodeScale: 1,
}

interface CanvasNode extends GraphNode {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

interface CanvasState {
  nodes: CanvasNode[]
  edges: Array<{ a: CanvasNode; b: CanvasNode }>
  scale: number
  offsetX: number
  offsetY: number
  dragging: { node: CanvasNode | null; startX: number; startY: number; ox: number; oy: number } | null
  pointers: Map<number, { x: number; y: number }>
  pinch: { distance: number; scale: number; centerX: number; centerY: number } | null
  frame: number
  raf: number
  schedule: (() => void) | null
}

export function graphScaleAfterWheel(scale: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return scale
  return Math.min(4, Math.max(0.2, scale * (deltaY > 0 ? 0.92 : 1.08)))
}

function loadPreferences(): GraphPreferences {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFERENCES
  try {
    const stored = JSON.parse(localStorage.getItem(GRAPH_PREFS_KEY) ?? '{}') as Partial<GraphPreferences>
    return {
      mode: stored.mode === 'local' ? 'local' : 'global',
      depth: boundedPreference(stored.depth, DEFAULT_PREFERENCES.depth, 1, 3),
      includeOrphans: booleanPreference(stored.includeOrphans, DEFAULT_PREFERENCES.includeOrphans),
      includeUnresolved: booleanPreference(stored.includeUnresolved, DEFAULT_PREFERENCES.includeUnresolved),
      arrows: booleanPreference(stored.arrows, DEFAULT_PREFERENCES.arrows),
      labels: booleanPreference(stored.labels, DEFAULT_PREFERENCES.labels),
      groupBy: stored.groupBy === 'folder' || stored.groupBy === 'tag' ? stored.groupBy : 'none',
      folderId: typeof stored.folderId === 'string' && /^[0-9a-hjkmnp-tv-z]{26}$/.test(stored.folderId)
        ? stored.folderId
        : '',
      tag: typeof stored.tag === 'string' ? truncateText(stored.tag.trim(), 60) : '',
      repulsion: boundedPreference(stored.repulsion, DEFAULT_PREFERENCES.repulsion, 300, 1800),
      linkDistance: boundedPreference(stored.linkDistance, DEFAULT_PREFERENCES.linkDistance, 40, 150),
      nodeScale: boundedPreference(stored.nodeScale, DEFAULT_PREFERENCES.nodeScale, 0.7, 1.8),
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function boundedPreference(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function booleanPreference(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function nodeColor(node: CanvasNode, groupBy: GroupBy, fallback: string): string {
  if (groupBy === 'folder') return organizerColorOrNull(node.folderColor) ?? fallback
  if (groupBy === 'tag') return organizerColorOrNull(node.tags[0]?.color) ?? fallback
  return fallback
}

function normalizedResponse(response: GraphResponse): GraphResponse {
  const nodes = response.nodes.map((node) => ({
    ...node,
    kind: node.kind ?? 'note',
    inDegree: node.inDegree ?? 0,
    outDegree: node.outDegree ?? 0,
    folderId: node.folderId ?? null,
    folderName: node.folderName ?? null,
    folderColor: node.folderColor ?? null,
    tags: node.tags ?? [],
  }))
  return {
    nodes,
    edges: response.edges,
    meta: response.meta ?? {
      mode: 'global', centerId: null, depth: 1,
      totalNodes: nodes.length, totalEdges: response.edges.length,
      truncated: false, limit: nodes.length,
    },
  }
}

export function GraphPanel({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const titleId = useId()
  const [prefs, setPrefs] = useState(loadPreferences)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [data, setData] = useState<GraphResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [hover, setHover] = useState<CanvasNode | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [context, setContext] = useState<{ x: number; y: number; node: CanvasNode } | null>(null)
  const openNote = useNotes((state) => state.openNote)
  const createNote = useNotes((state) => state.createNote)
  const folders = useNotes((state) => state.folders ?? [])
  const tags = useNotes((state) => state.tags ?? [])
  const activeNoteId = useUi((state) => state.activeNoteId)
  const hoverRef = useRef<CanvasNode | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const activeNoteIdRef = useRef(activeNoteId)
  const lastPointerEventAtRef = useRef(Number.NEGATIVE_INFINITY)
  const stateRef = useRef<CanvasState>({
    nodes: [], edges: [], scale: 1, offsetX: 0, offsetY: 0,
    dragging: null, pointers: new Map(), pinch: null,
    frame: 0, raf: 0, schedule: null,
  })

  useEscape(true, onClose)
  useLockScroll(true)
  useDialogFocus(true, panelRef)

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 220)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    try {
      localStorage.setItem(GRAPH_PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // Private browsing or a locked-down browser can reject local preferences.
    }
  }, [prefs])

  const request: GraphQuery = useMemo(() => ({
    mode: prefs.mode,
    center: prefs.mode === 'local' ? activeNoteId ?? undefined : undefined,
    depth: prefs.depth,
    q: query || undefined,
    folderId: prefs.folderId || undefined,
    tag: prefs.tag || undefined,
    includeOrphans: prefs.includeOrphans,
    includeUnresolved: prefs.includeUnresolved,
    limit: 350,
  }), [activeNoteId, prefs.mode, prefs.depth, prefs.folderId, prefs.tag, prefs.includeOrphans, prefs.includeUnresolved, query])

  useEffect(() => {
    if (request.mode === 'local' && !request.center) {
      setData(null)
      setLoadError(t('graph.local_requires_note'))
      return
    }
    const controller = new AbortController()
    let cancelled = false
    setData(null)
    setLoadError(null)
    api.graph(request, controller.signal).then((response) => {
      if (!cancelled) setData(normalizedResponse(response))
    }).catch((error) => {
      if (!cancelled && (error as Error)?.name !== 'AbortError') {
        setLoadError(error instanceof Error ? error.message : String(error))
      }
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [request, reload])

  useEffect(() => {
    activeNoteIdRef.current = activeNoteId
    stateRef.current.schedule?.()
  }, [activeNoteId])
  useEffect(() => {
    selectedIdRef.current = selectedId
    stateRef.current.schedule?.()
  }, [selectedId])

  const fitGraph = useCallback(() => {
    const canvas = canvasRef.current
    const state = stateRef.current
    if (!canvas || !state.nodes.length) return
    const rect = canvas.getBoundingClientRect()
    const xs = state.nodes.map((node) => node.x)
    const ys = state.nodes.map((node) => node.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const width = Math.max(80, maxX - minX + 80)
    const height = Math.max(80, maxY - minY + 80)
    state.scale = Math.min(2.5, Math.max(0.2, Math.min(rect.width / width, rect.height / height)))
    state.offsetX = rect.width / 2 - ((minX + maxX) / 2) * state.scale
    state.offsetY = rect.height / 2 - ((minY + maxY) / 2) * state.scale
    state.schedule?.()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const state = stateRef.current
    hoverRef.current = null
    setHover(null)
    setSelectedId((current) => data.nodes.some((node) => node.id === current) ? current : null)
    state.nodes = data.nodes.map((node, index) => {
      const angle = index * 2.399963
      const radius = 18 * Math.sqrt(index)
      return {
        ...node,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        r: (4 + Math.min(9, Math.sqrt(node.degree) * 2.4)) * prefs.nodeScale,
      }
    })
    const byId = new Map(state.nodes.map((node) => [node.id, node]))
    state.edges = data.edges.flatMap((edge) => {
      const a = byId.get(edge.source), b = byId.get(edge.target)
      return a && b ? [{ a, b }] : []
    })
    state.frame = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      ? PHYSICS_FRAME_LIMIT
      : 0
    const resize = () => {
      const dpr = Math.min(2, devicePixelRatio || 1)
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!state.offsetX && !state.offsetY) {
        state.offsetX = rect.width / 2
        state.offsetY = rect.height / 2
      }
      state.schedule?.()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    const style = getComputedStyle(document.documentElement)
    const colors = {
      edge: style.getPropertyValue('--border-strong').trim() || 'rgba(127,127,127,.35)',
      node: style.getPropertyValue('--text-tertiary').trim() || '#777',
      accent: style.getPropertyValue('--accent').trim() || '#4f46e5',
      text: style.getPropertyValue('--text-secondary').trim() || '#555',
    }
    const schedule = () => { if (!state.raf) state.raf = requestAnimationFrame(tick) }
    const tick = () => {
      state.raf = 0
      const rect = canvas.getBoundingClientRect()
      if (state.frame < PHYSICS_FRAME_LIMIT) {
        state.frame++
        for (let i = 0; i < state.nodes.length; i++) {
          const a = state.nodes[i]!
          for (let j = i + 1; j < state.nodes.length; j++) {
            const b = state.nodes[j]!
            let dx = b.x - a.x, dy = b.y - a.y
            let distanceSquared = dx * dx + dy * dy
            if (distanceSquared < 0.01) {
              dx = (Math.random() - 0.5) * 0.6
              dy = (Math.random() - 0.5) * 0.6
              distanceSquared = 0.36
            }
            if (distanceSquared > 120000) continue
            const distance = Math.sqrt(distanceSquared)
            const force = prefs.repulsion / distanceSquared
            const fx = dx / distance * force, fy = dy / distance * force
            a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy
          }
          a.vx -= a.x * 0.0022
          a.vy -= a.y * 0.0022
        }
        for (const edge of state.edges) {
          const dx = edge.b.x - edge.a.x, dy = edge.b.y - edge.a.y
          const distance = Math.hypot(dx, dy) || 1
          const force = (distance - prefs.linkDistance) * 0.008
          const fx = dx / distance * force, fy = dy / distance * force
          edge.a.vx += fx; edge.a.vy += fy; edge.b.vx -= fx; edge.b.vy -= fy
        }
        let movement = 0
        for (const node of state.nodes) {
          if (state.dragging?.node === node) continue
          node.vx *= 0.86; node.vy *= 0.86
          const moveX = Math.max(-8, Math.min(8, node.vx))
          const moveY = Math.max(-8, Math.min(8, node.vy))
          node.x += moveX; node.y += moveY
          movement += Math.abs(moveX) + Math.abs(moveY)
        }
        if (state.frame > 90 && movement < state.nodes.length * 0.01) state.frame = PHYSICS_FRAME_LIMIT
      }
      ctx.clearRect(0, 0, rect.width, rect.height)
      ctx.save()
      ctx.translate(state.offsetX, state.offsetY)
      ctx.scale(state.scale, state.scale)
      const emphasizedId = hoverRef.current?.id ?? selectedIdRef.current
      ctx.lineWidth = 1 / state.scale
      for (const edge of state.edges) {
        const related = emphasizedId === edge.a.id || emphasizedId === edge.b.id
        ctx.strokeStyle = related ? colors.accent : colors.edge
        ctx.globalAlpha = related ? 0.9 : emphasizedId ? 0.14 : 0.42
        ctx.beginPath(); ctx.moveTo(edge.a.x, edge.a.y); ctx.lineTo(edge.b.x, edge.b.y); ctx.stroke()
        if (prefs.arrows) {
          const angle = Math.atan2(edge.b.y - edge.a.y, edge.b.x - edge.a.x)
          const x = edge.b.x - Math.cos(angle) * (edge.b.r + 2)
          const y = edge.b.y - Math.sin(angle) * (edge.b.r + 2)
          const size = 5 / Math.sqrt(state.scale)
          ctx.beginPath()
          ctx.moveTo(x, y)
          ctx.lineTo(x - Math.cos(angle - Math.PI / 6) * size, y - Math.sin(angle - Math.PI / 6) * size)
          ctx.lineTo(x - Math.cos(angle + Math.PI / 6) * size, y - Math.sin(angle + Math.PI / 6) * size)
          ctx.closePath(); ctx.fillStyle = related ? colors.accent : colors.edge; ctx.fill()
        }
      }
      ctx.globalAlpha = 1
      for (const node of state.nodes) {
        const active = node.id === activeNoteIdRef.current
        const emphasized = node.id === emphasizedId
        ctx.beginPath(); ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2)
        ctx.fillStyle = active || emphasized ? colors.accent : nodeColor(node, prefs.groupBy, colors.node)
        ctx.globalAlpha = emphasizedId && !emphasized && !active ? 0.34 : 1
        if (node.kind === 'unresolved') {
          ctx.strokeStyle = ctx.fillStyle
          ctx.lineWidth = 1.5 / state.scale
          ctx.stroke()
        } else {
          ctx.fill()
        }
        if (active || selectedIdRef.current === node.id) {
          ctx.strokeStyle = colors.accent; ctx.globalAlpha = 0.42; ctx.lineWidth = 3 / state.scale
          ctx.beginPath(); ctx.arc(node.x, node.y, node.r + 4, 0, Math.PI * 2); ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
      if (prefs.labels && (state.scale > 0.68 || emphasizedId)) {
        ctx.font = `${11 / state.scale}px ${style.getPropertyValue('--font-ui')}`
        ctx.textAlign = 'center'
        for (const node of state.nodes) {
          const emphasized = node.id === emphasizedId
          if (!emphasized && node.degree < 1 && state.scale < 1.1) continue
          ctx.fillStyle = emphasized ? colors.accent : colors.text
          ctx.globalAlpha = emphasized ? 1 : emphasizedId ? 0.26 : 0.72
          const label = node.title.length > 18 ? `${truncateText(node.title, 18)}…` : node.title
          ctx.fillText(label, node.x, node.y + node.r + 12 / state.scale)
        }
      }
      ctx.globalAlpha = 1
      ctx.restore()
      if (state.frame < PHYSICS_FRAME_LIMIT) schedule()
    }
    state.schedule = schedule
    schedule()
    const fitTimer = window.setTimeout(fitGraph, 120)
    return () => {
      window.clearTimeout(fitTimer)
      cancelAnimationFrame(state.raf)
      state.raf = 0; state.schedule = null
      observer.disconnect()
    }
  }, [data, fitGraph, prefs.arrows, prefs.groupBy, prefs.labels, prefs.linkDistance, prefs.nodeScale, prefs.repulsion])

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const state = stateRef.current
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: (clientX - rect.left - state.offsetX) / state.scale, y: (clientY - rect.top - state.offsetY) / state.scale }
  }, [])
  const nodeAt = useCallback((x: number, y: number): CanvasNode | null => {
    const nodes = stateRef.current.nodes
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index]!
      if (Math.hypot(node.x - x, node.y - y) <= node.r + 7) return node
    }
    return null
  }, [])

  const beginDrag = useCallback((clientX: number, clientY: number, button: number) => {
    if (button !== 0) return
    const state = stateRef.current
    const point = toWorld(clientX, clientY)
    const node = nodeAt(point.x, point.y)
    state.dragging = { node, startX: clientX, startY: clientY, ox: state.offsetX, oy: state.offsetY }
    if (node) setSelectedId(node.id)
  }, [nodeAt, toWorld])
  const moveDrag = useCallback((clientX: number, clientY: number) => {
    const state = stateRef.current
    const point = toWorld(clientX, clientY)
    if (state.dragging) {
      if (state.dragging.node) {
        state.dragging.node.x = point.x; state.dragging.node.y = point.y
        state.dragging.node.vx = 0; state.dragging.node.vy = 0
        state.frame = Math.min(state.frame, PHYSICS_FRAME_LIMIT - 100)
      } else {
        state.offsetX = state.dragging.ox + clientX - state.dragging.startX
        state.offsetY = state.dragging.oy + clientY - state.dragging.startY
      }
      state.schedule?.(); return
    }
    const node = nodeAt(point.x, point.y)
    if (hoverRef.current?.id !== node?.id) {
      hoverRef.current = node; setHover(node); state.schedule?.()
    }
  }, [nodeAt, toWorld])
  const endDrag = useCallback((clientX: number, clientY: number) => {
    const state = stateRef.current
    const drag = state.dragging
    state.dragging = null
    if (!drag) return
    const moved = Math.abs(clientX - drag.startX) + Math.abs(clientY - drag.startY)
    if (drag.node && moved < 5) {
      if (drag.node.kind === 'note') void openNote(drag.node.id)
      else void createNote?.({ title: drag.node.title, open: true })
      onClose()
    }
  }, [createNote, onClose, openNote])

  const selected = data?.nodes.find((node) => node.id === selectedId) ?? null
  const menuItems: MenuItem[] = context ? [
    { id: 'open', label: context.node.kind === 'unresolved' ? t('graph.create_note') : t('graph.open_note'), icon: <FolderOpen size={14}/>, onSelect: () => {
      if (context.node.kind === 'unresolved') void createNote?.({ title: context.node.title, open: true })
      else void openNote(context.node.id)
      onClose()
    } },
    { id: 'right', label: t('graph.open_to_right'), icon: <PanelRightClose size={14}/>, disabled: context.node.kind === 'unresolved', onSelect: () => { void openNote(context.node.id, { pane: 'secondary' }) } },
    { id: 'local', label: t('graph.make_local_center'), icon: <CircleDot size={14}/>, disabled: context.node.kind === 'unresolved', separatorBefore: true, onSelect: () => {
      void openNote(context.node.id)
      setPrefs((value) => ({ ...value, mode: 'local' }))
    } },
  ] : []

  const changePref = <K extends keyof GraphPreferences>(key: K, value: GraphPreferences[K]) => {
    setPrefs((current) => ({ ...current, [key]: value }))
  }

  return createPortal(<div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
    className="app-viewport-fixed fixed z-[230] flex flex-col bg-[var(--bg-base)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none md:py-0">
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 md:px-4">
      <div className="mr-1 flex min-w-0 items-baseline gap-2.5">
        <h2 id={titleId} className="text-[14px] font-semibold tracking-[-0.014em]">{t('common.graph')}</h2>
        {data && <span className="whitespace-nowrap text-[11.5px] text-[var(--text-quaternary)]">
          {data.nodes.filter((node) => node.kind === 'note').length}{t('graph.notes')}{data.edges.length}{t('graph.links')}
          {data.nodes.some((node) => node.kind === 'unresolved') && ` · ${data.nodes.filter((node) => node.kind === 'unresolved').length}${t('graph.unresolved_short')}`}
        </span>}
      </div>
      <div className="flex h-8 items-center rounded-[var(--r-md)] bg-[var(--bg-inset)] p-0.5" role="group" aria-label={t('graph.scope')}>
        <button type="button" aria-pressed={prefs.mode === 'global'} onClick={() => changePref('mode', 'global')}
          className={`h-7 rounded-[var(--r-sm)] px-2.5 text-[11.5px] ${prefs.mode === 'global' ? 'bg-[var(--bg-overlay)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-tertiary)]'}`}>
          {t('graph.global')}
        </button>
        <button type="button" aria-pressed={prefs.mode === 'local'} disabled={!activeNoteId} onClick={() => changePref('mode', 'local')}
          className={`h-7 rounded-[var(--r-sm)] px-2.5 text-[11.5px] disabled:opacity-40 ${prefs.mode === 'local' ? 'bg-[var(--bg-overlay)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-tertiary)]'}`}>
          {t('graph.local')}
        </button>
      </div>
      <label className="flex h-8 min-w-[150px] flex-1 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2.5 md:max-w-[320px]">
        <Search size={13} className="shrink-0 text-[var(--text-quaternary)]"/>
        <span className="sr-only">{t('graph.search_notes')}</span>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('graph.search_notes')}
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--text-quaternary)]"/>
        {search && <button type="button" aria-label={t('common.clear')} onClick={() => setSearch('')}><X size={12}/></button>}
      </label>
      <div className="ml-auto flex items-center gap-1">
        <Tooltip label={t('common.zoom_out')}><IconButton label={t('common.zoom_out')} size="sm" disabled={!data?.nodes.length} onClick={() => {
          const state = stateRef.current; state.scale = Math.max(0.2, state.scale - 0.2); state.schedule?.()
        }}><Minus size={14}/></IconButton></Tooltip>
        <Tooltip label={t('graph.fit')}><IconButton label={t('graph.reset')} size="sm" disabled={!data?.nodes.length} onClick={fitGraph}><Maximize2 size={13}/></IconButton></Tooltip>
        <Tooltip label={t('common.zoom_in')}><IconButton label={t('common.zoom_in')} size="sm" disabled={!data?.nodes.length} onClick={() => {
          const state = stateRef.current; state.scale = Math.min(4, state.scale + 0.2); state.schedule?.()
        }}><Plus size={14}/></IconButton></Tooltip>
        <Tooltip label={t('graph.settings')}><IconButton label={t('graph.settings')} size="sm" aria-pressed={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={14}/></IconButton></Tooltip>
        <Tooltip label={t('common.close')} combo="escape" side="left"><IconButton label={t('common.close')} size="sm" onClick={onClose} className="ml-1"><X size={16}/></IconButton></Tooltip>
      </div>
    </header>

    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <main className="relative min-w-0 flex-1">
        {loadError ? <Empty art="notes" title={t('graph.could_not_load_graph')} description={loadError}
          action={<Button size="sm" variant="secondary" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>}/>
        : !data ? <LoadingBlock label={t('graph.building_graph')}/>
        : data.nodes.length === 0 ? <Empty art="notes" title={t('graph.nothing_to_graph_yet')} description={t('graph.connect_notes_with_wiki_links_and_their_graph_will_appear_here')}/>
        : <>
          <canvas ref={canvasRef} tabIndex={0} role="application" aria-label={t('graph.graph_canvas_accessible')}
            className="size-full touch-none cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] active:cursor-grabbing"
            onPointerDown={(event) => {
              if (event.button !== 0) return
              lastPointerEventAtRef.current = performance.now()
              event.currentTarget.setPointerCapture(event.pointerId)
              const state = stateRef.current
              state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
              if (state.pointers.size === 1) beginDrag(event.clientX, event.clientY, event.button)
              else if (state.pointers.size === 2) {
                const [a, b] = [...state.pointers.values()]
                state.dragging = null
                state.pinch = { distance: Math.hypot(b!.x - a!.x, b!.y - a!.y), scale: state.scale, centerX: (a!.x + b!.x) / 2, centerY: (a!.y + b!.y) / 2 }
              }
            }}
            onPointerMove={(event) => {
              lastPointerEventAtRef.current = performance.now()
              const state = stateRef.current
              if (state.pointers.has(event.pointerId)) state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
              if (state.pointers.size >= 2 && state.pinch) {
                const [a, b] = [...state.pointers.values()]
                const distance = Math.hypot(b!.x - a!.x, b!.y - a!.y)
                state.scale = Math.min(4, Math.max(0.2, state.pinch.scale * distance / Math.max(1, state.pinch.distance)))
                state.schedule?.(); return
              }
              moveDrag(event.clientX, event.clientY)
            }}
            onPointerUp={(event) => {
              lastPointerEventAtRef.current = performance.now()
              const state = stateRef.current
              state.pointers.delete(event.pointerId)
              if (!state.pinch) endDrag(event.clientX, event.clientY)
              if (state.pointers.size < 2) state.pinch = null
            }}
            onPointerCancel={(event) => {
              const state = stateRef.current; state.pointers.delete(event.pointerId); state.dragging = null; state.pinch = null
            }}
            onMouseDown={(event) => { if (performance.now() - lastPointerEventAtRef.current > 80) beginDrag(event.clientX, event.clientY, event.button) }}
            onMouseMove={(event) => { if (performance.now() - lastPointerEventAtRef.current > 80) moveDrag(event.clientX, event.clientY) }}
            onMouseUp={(event) => { if (performance.now() - lastPointerEventAtRef.current > 80) endDrag(event.clientX, event.clientY) }}
            onMouseLeave={() => {
              const state = stateRef.current; state.dragging = null
              hoverRef.current = null; setHover(null); state.schedule?.()
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              const point = toWorld(event.clientX, event.clientY)
              const node = nodeAt(point.x, point.y)
              if (node) { setSelectedId(node.id); setContext({ x: event.clientX, y: event.clientY, node }) }
            }}
            onWheel={(event) => {
              const state = stateRef.current
              const rect = event.currentTarget.getBoundingClientRect()
              const x = event.clientX - rect.left, y = event.clientY - rect.top
              const next = graphScaleAfterWheel(state.scale, event.deltaY)
              if (next === state.scale) return
              event.preventDefault()
              state.offsetX = x - (x - state.offsetX) / state.scale * next
              state.offsetY = y - (y - state.offsetY) / state.scale * next
              state.scale = next; state.schedule?.()
            }}
            onKeyDown={(event) => {
              const state = stateRef.current
              if (event.key === '+' || event.key === '=') state.scale = Math.min(4, state.scale + 0.2)
              else if (event.key === '-') state.scale = Math.max(0.2, state.scale - 0.2)
              else if (event.key === 'Home') fitGraph()
              else if (event.key === 'Enter' && selectedIdRef.current) {
                const selectedNode = state.nodes.find((node) => node.id === selectedIdRef.current)
                if (selectedNode?.kind === 'note') void openNote(selectedNode.id)
                else if (selectedNode) void createNote?.({ title: selectedNode.title, open: true })
                if (selectedNode) onClose()
              }
              else if (event.key.startsWith('Arrow')) {
                const current = Math.max(0, state.nodes.findIndex((node) => node.id === selectedIdRef.current))
                const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
                const next = state.nodes[(current + step + state.nodes.length) % state.nodes.length]
                if (next) setSelectedId(next.id)
              } else return
              event.preventDefault(); state.schedule?.()
            }}/>
          {data.meta.truncated && <div role="status" className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3 py-1 text-[11px] text-[var(--text-secondary)] shadow-sm">
            {t('graph.showing_limit', { shown: data.nodes.length, total: data.meta.totalNodes })}
          </div>}
          {(hover || selected) && <div className="pointer-events-none absolute bottom-4 left-1/2 max-w-[80vw] -translate-x-1/2 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3.5 py-1.5 text-[12px] shadow-[var(--shadow-pop)]">
            <span className="max-w-[50vw] truncate">{(hover ?? selected)!.title || t('common.untitled_note')}</span>
            <span className="ml-2 text-[var(--text-quaternary)]">{t('graph.direction_counts', { incoming: (hover ?? selected)!.inDegree, outgoing: (hover ?? selected)!.outDegree })}</span>
          </div>}
          <div className="pointer-events-none absolute top-3 left-4 hidden text-[11px] text-[var(--text-quaternary)] md:block">{t('graph.interaction_hint')}</div>
        </>}
      </main>

      {settingsOpen && <aside aria-label={t('graph.settings')} className="absolute inset-y-0 right-0 z-10 w-[min(88vw,300px)] overflow-y-auto border-l border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 shadow-[-8px_0_24px_rgba(0,0,0,.06)] md:static md:shadow-none">
        <div className="mb-4 flex items-center justify-between"><h3 className="text-[13px] font-semibold">{t('graph.settings')}</h3><Tooltip label={t('common.close')}><IconButton size="sm" label={t('common.close')} onClick={() => setSettingsOpen(false)}><X size={14}/></IconButton></Tooltip></div>
        <GraphSection icon={<Filter size={13}/>} title={t('graph.filters')}>
          <GraphSelect label={t('graph.folder')} value={prefs.folderId} onChange={(value) => changePref('folderId', value)} options={[['', t('graph.all_folders')], ...folders.map((folder) => [folder.id, folder.name] as [string, string])]}/>
          <GraphSelect label={t('graph.tag')} value={prefs.tag} onChange={(value) => changePref('tag', value)} options={[['', t('graph.all_tags')], ...tags.map((item) => [item.name, item.name] as [string, string])]}/>
          <GraphToggle label={t('graph.show_orphans')} checked={prefs.includeOrphans} onChange={(value) => changePref('includeOrphans', value)}/>
          <GraphToggle label={t('graph.show_unresolved')} checked={prefs.includeUnresolved} onChange={(value) => changePref('includeUnresolved', value)}/>
          {prefs.mode === 'local' && <GraphSelect label={t('graph.depth')} value={String(prefs.depth)} onChange={(value) => changePref('depth', Number(value))} options={[["1", '1'], ["2", '2'], ["3", '3']]}/>} 
        </GraphSection>
        <GraphSection icon={<Network size={13}/>} title={t('graph.appearance')}>
          <GraphSelect label={t('graph.group_by')} value={prefs.groupBy} onChange={(value) => changePref('groupBy', value as GroupBy)} options={[["none", t('graph.group_none')], ["folder", t('graph.folder')], ["tag", t('graph.tag')]]}/>
          <GraphToggle label={t('graph.show_arrows')} checked={prefs.arrows} onChange={(value) => changePref('arrows', value)}/>
          <GraphToggle label={t('graph.show_labels')} checked={prefs.labels} onChange={(value) => changePref('labels', value)}/>
        </GraphSection>
        <GraphSection icon={<ArrowRight size={13}/>} title={t('graph.forces')}>
          <GraphRange label={t('graph.repulsion')} min={300} max={1800} step={50} value={prefs.repulsion} onChange={(value) => changePref('repulsion', value)}/>
          <GraphRange label={t('graph.link_distance')} min={40} max={150} step={5} value={prefs.linkDistance} onChange={(value) => changePref('linkDistance', value)}/>
          <GraphRange label={t('graph.node_size')} min={0.7} max={1.8} step={0.1} value={prefs.nodeScale} onChange={(value) => changePref('nodeScale', value)}/>
          <button type="button" onClick={() => setPrefs((current) => ({ ...DEFAULT_PREFERENCES, mode: current.mode }))} className="mt-1 flex h-8 w-full items-center justify-center gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><ArrowDownToLine size={13}/>{t('graph.restore_defaults')}</button>
        </GraphSection>
      </aside>}
    </div>
    <Menu anchor={context ?? { x: 0, y: 0 }} open={Boolean(context)} onClose={() => setContext(null)} items={menuItems} label={t('graph.node_actions')}/>
  </div>, document.body)
}

function GraphSection({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <section className="mb-5"><h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-quaternary)]">{icon}{title}</h4><div className="space-y-2.5">{children}</div></section>
}

function GraphSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <label className="flex items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="h-8 max-w-[160px] rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 text-[11.5px] outline-none focus:border-[var(--accent)]">{options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}</select></label>
}

function GraphToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex cursor-pointer items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-[var(--accent)]"/></label>
}

function GraphRange({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (value: number) => void }) {
  return <label className="block text-[12px] text-[var(--text-secondary)]"><span className="mb-1 flex justify-between"><span>{label}</span><span className="tabular-nums text-[var(--text-quaternary)]">{value}</span></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="w-full accent-[var(--accent)]"/></label>
}
