


export interface Hotkey {
  id: string

  combo: string
  description: string | (() => string)
  group: string | (() => string)
  handler: (event: KeyboardEvent) => void

  allowInInput?: boolean
  allowInOverlay?: boolean
  enabled?: () => boolean

  hidden?: boolean
}

const registry = new Map<string, Hotkey>()
let bound = false

export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

export function register(hotkey: Hotkey): () => void {
  registry.set(hotkey.id, hotkey)
  ensureBound()
  return () => {
    if (registry.get(hotkey.id) === hotkey) registry.delete(hotkey.id)
  }
}

export function registerAll(hotkeys: Hotkey[]): () => void {
  const disposers = hotkeys.map(register)
  return () => disposers.forEach((d) => d())
}

export function listHotkeys(): Hotkey[] {
  return [...registry.values()].filter((h) => !h.hidden)
}

export function hotkeyText(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value
}

function ensureBound(): void {
  if (bound || typeof window === 'undefined') return
  bound = true
  window.addEventListener('keydown', onKeyDown, { capture: true })
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.getModifierState('AltGraph')) return
  const inInput = isEditableTarget(event.target)
  const inOverlay = Boolean(document.querySelector('[role="dialog"], [role="menu"]'))

  for (const hotkey of registry.values()) {
    if (!matches(event, hotkey.combo)) continue
    if (inInput && !hotkey.allowInInput) continue
    if (inOverlay && !hotkey.allowInOverlay) continue
    if (hotkey.enabled && !hotkey.enabled()) continue
    event.preventDefault()
    event.stopPropagation()
    hotkey.handler(event)
    return
  }
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (el.isContentEditable || el.closest?.('[contenteditable]:not([contenteditable="false"])')) return true
  return Boolean(el.closest?.('.cm-editor'))
}

export function matches(event: KeyboardEvent, combo: string, isMac = IS_MAC): boolean {
  const parts = combo.toLowerCase().split('+')
  const key = parts[parts.length - 1]!

  const wantMod = parts.includes('mod')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')
  const wantCtrl = parts.includes('ctrl')
  const wantMeta = parts.includes('meta') || parts.includes('cmd')

  const expectedCtrl = wantCtrl || (!isMac && wantMod)
  const expectedMeta = wantMeta || (isMac && wantMod)
  if (event.ctrlKey !== expectedCtrl || event.metaKey !== expectedMeta) return false


  if (wantShift !== event.shiftKey) return false
  if (wantAlt !== event.altKey) return false

  const pressed = event.key.toLowerCase()
  if (pressed === key) return true

  if (key.length === 1 && event.code.toLowerCase() === `key${key}`) return true
  if (key.length === 1 && event.code.toLowerCase() === `digit${key}`) return true
  const punctuation: Record<string, string> = {
    '/': 'Slash', '\\': 'Backslash', ',': 'Comma', '.': 'Period',
    '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal',
    ';': 'Semicolon', "'": 'Quote', '`': 'Backquote',
  }
  if (punctuation[key] === event.code) return true
  if (key === 'esc' && pressed === 'escape') return true
  return false
}

export function prettyCombo(combo: string, isMac = IS_MAC): string[] {
  return combo.split('+').map((part) => {
    switch (part.toLowerCase()) {
      case 'mod':
        return isMac ? '⌘' : 'Ctrl'
      case 'shift':
        return isMac ? '⇧' : 'Shift'
      case 'alt':
        return isMac ? '⌥' : 'Alt'
      case 'ctrl':
        return isMac ? '⌃' : 'Ctrl'
      case 'meta':
      case 'cmd':
        return isMac ? '⌘' : 'Win'
      case 'escape':
      case 'esc':
        return 'Esc'
      case 'enter':
        return '↵'
      case 'tab':
        return 'Tab'
      case 'delete':
        return 'Delete'
      case 'home':
        return 'Home'
      case 'end':
        return 'End'
      case 'space':
        return 'Space'
      case 'backspace':
        return isMac ? '⌫' : 'Backspace'
      case 'arrowup':
        return '↑'
      case 'arrowdown':
        return '↓'
      case 'arrowleft':
        return '←'
      case 'arrowright':
        return '→'
      case ',':
        return ','
      default:
        return part.length === 1 ? part.toUpperCase() : part
    }
  })
}
