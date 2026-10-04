import { IS_MAC } from './hotkeys'

export const APP_SHORTCUTS = {
  command: 'mod+shift+p',
  search: 'mod+shift+f',
  newNote: IS_MAC ? 'mod+alt+shift+n' : 'mod+alt+n',
  settings: 'mod+,',
  toggleList: IS_MAC ? 'mod+alt+shift+b' : 'mod+alt+b',
  cycleLayout: 'mod+\\',
  shortcuts: 'mod+shift+/',
  save: 'mod+s',
  star: 'mod+alt+s',
  outline: 'mod+alt+o',
} as const

export const NOTE_LIST_SHORTCUTS = {
  delete: IS_MAC ? 'mod+backspace' : 'delete',
} as const

export function codeMirrorKey(combo: string): string {
  const names: Record<string, string> = {
    mod: 'Mod', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift',
    enter: 'Enter', escape: 'Escape', tab: 'Tab',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
  }
  return combo.split('+').map((part) => names[part.toLowerCase()] ?? part).join('-')
}
