import { backupRunsResource, backupTargetsResource, mcpResource, statsResource, totpResource } from './resources'
import { useSession } from '../../store/session'

export type SettingsSection = 'appearance' | 'editor' | 'backup' | 'sync' | 'mcp' | 'account' | 'data' | 'shares' | 'blog' | 'about'

export const settingsLoaders = {
  editor: () => import('./EditorSettings').then((m) => ({ default: m.EditorSettings })),
  backup: () => import('./BackupSettings').then((m) => ({ default: m.BackupSettings })),
  sync: () => import('./SyncSettings').then((m) => ({ default: m.SyncSettings })),
  mcp: () => import('./McpSettings').then((m) => ({ default: m.McpSettings })),
  account: () => import('./AccountSettings').then((m) => ({ default: m.AccountSettings })),
  data: () => import('./DataSettings').then((m) => ({ default: m.DataSettings })),
  shares: () => import('./SharedNotes').then((m) => ({ default: m.SharedNotes })),
  blog: () => import('./BlogSettings').then((m) => ({ default: m.BlogSettings })),
  about: () => import('./AboutSettings').then((m) => ({ default: m.AboutSettings })),
}

export function warmSettingsSection(section: SettingsSection): void {
  if (section !== 'appearance') void settingsLoaders[section]().catch(() => {})
  if (useSession.getState().status !== 'authed') return
  const resources = section === 'backup' ? [backupTargetsResource, backupRunsResource]
    : section === 'mcp' ? [mcpResource]
    : section === 'data' ? [statsResource]
    : section === 'account' ? [totpResource] : []
  resources.forEach((resource) => { void resource.load().catch(() => {}) })
}

export function scheduleSettingsWarmup(delay = 1200): () => void {
  const queue = Object.keys(settingsLoaders) as Array<keyof typeof settingsLoaders>
  let timer: number
  const next = () => {
    const section = queue.shift()
    if (!section) return
    void settingsLoaders[section]().catch(() => {})
    timer = window.setTimeout(next, 150)
  }
  timer = window.setTimeout(next, delay)
  return () => window.clearTimeout(timer)
}
