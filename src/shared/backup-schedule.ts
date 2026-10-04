import { BACKUP_INTERVALS } from './constants'
import type { BackupSchedule } from './types'

export function backupIntervalMs(schedule: BackupSchedule, anchor: number): number {
  if (schedule !== 'monthly' && schedule !== 'yearly') return BACKUP_INTERVALS[schedule] ?? 0
  const date = new Date(anchor)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + (schedule === 'monthly' ? 1 : 12))
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, lastDay))
  return date.getTime() - anchor
}
