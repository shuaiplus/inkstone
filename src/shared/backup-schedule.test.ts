import { describe, expect, it } from 'vitest'
import { backupIntervalMs } from './backup-schedule'
import { mergeSettings, mergeSettingsPatch } from './constants'

describe('backup policies', () => {
  it('preserves old defaults and accepts longer schedules and retention independently', () => {
    expect(mergeSettings({}).backup).toEqual({ schedule: 'sixHourly', retentionCount: 0 })
    for (const schedule of ['weekly', 'monthly', 'yearly']) {
      const settings = mergeSettings({ backup: { schedule, retentionCount: 14 } })
      expect(settings.backup).toEqual({ schedule, retentionCount: 14 })
      expect(mergeSettingsPatch(settings, { editor: { fontSize: 17 } }).backup).toEqual(settings.backup)
      expect(mergeSettingsPatch(settings, { backup: { schedule: 'off' } }).backup.retentionCount).toBe(14)
    }
    expect(mergeSettings({ backup: { retentionCount: '7' } }).backup.retentionCount).toBe(0)
    expect(mergeSettings({ backup: { retentionCount: -10 } }).backup.retentionCount).toBe(0)
    expect(mergeSettings({ backup: { retentionCount: 5000 } }).backup.retentionCount).toBe(1000)
  })

  it.each([
    ['weekly', '2026-01-31T12:34:56Z', '2026-02-07T12:34:56Z'],
    ['monthly', '2026-01-31T12:34:56Z', '2026-02-28T12:34:56Z'],
    ['monthly', '2024-01-31T12:34:56Z', '2024-02-29T12:34:56Z'],
    ['monthly', '2026-12-15T12:34:56Z', '2027-01-15T12:34:56Z'],
    ['yearly', '2024-02-29T12:34:56Z', '2025-02-28T12:34:56Z'],
    ['yearly', '2023-03-01T12:34:56Z', '2024-03-01T12:34:56Z'],
  ] as const)('uses calendar dates for %s from %s', (schedule, start, end) => {
    const anchor = Date.parse(start)
    expect(anchor + backupIntervalMs(schedule, anchor)).toBe(Date.parse(end))
  })
  it('disables automatic scheduling without disabling retention for manual backups', () => {
    expect(backupIntervalMs('off', Date.now())).toBe(0)
    expect(mergeSettings({ backup: { schedule: 'off', retentionCount: 7 } }).backup.retentionCount).toBe(7)
  })
})
