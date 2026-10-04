import { LIMITS, mergeSettings } from '@shared/constants'
import { backupIntervalMs } from '@shared/backup-schedule'
import type { Env } from '../env'
import { initializeDatabase } from '../db/schema'
import { getMeta, setMeta } from '../db/metadata'
import { ApiError } from '../lib/errors'
import { acquireLease } from '../lib/lease'
import { forEachConcurrent } from './concurrency'
import { runBackup } from './engine'

const USER_PAGE_SIZE = 100
const BACKUP_SCHEDULE_EARLY_TOLERANCE_MS = 5 * 60 * 1000
const BACKUP_RETRY_INTERVAL_MS = 60 * 60 * 1000
const CHANGE_LOG_TRIM_INTERVAL_MS = 24 * 60 * 60 * 1000
const CHANGE_LOG_TRIM_META_KEY = 'change-log-trim-last-success-v1'
const CHANGE_LOG_TRIM_LEASE_KEY = 'change-log-trim-lease-v1'


export async function runScheduledBackups(env: Env): Promise<void> {
  try {
    await initializeDatabase(env)
  } catch (err) {
    console.error('[inkstone] Scheduled task: database is not ready', err)
    return
  }

  const now = Date.now()


  let afterUserId = ''
  while (true) {
    const { results: users } = await env.DB.prepare(
      `SELECT u.id, u.settings,
              (SELECT MAX(br.started_at) FROM backup_runs br
                WHERE br.user_id = u.id) AS last_attempt_at,
              (SELECT MAX(br.started_at) FROM backup_runs br
                WHERE br.user_id = u.id AND br.status = 'success') AS last_success_at
         FROM users u
        WHERE u.id > ?1
          AND EXISTS (
            SELECT 1 FROM backup_targets bt WHERE bt.user_id = u.id AND bt.enabled = 1
          )
        ORDER BY u.id LIMIT ?2`,
    )
      .bind(afterUserId, USER_PAGE_SIZE)
      .all<{
        id: string
        settings: string
        last_attempt_at: number | null
        last_success_at: number | null
      }>()
    if (users.length === 0) break

    await forEachConcurrent(users, 2, async (user) => {
      try {
        const settings = mergeSettings(parse(user.settings))
        const interval = backupIntervalMs(settings.backup.schedule, user.last_success_at ?? now)
        if (!interval) return


        if (!isScheduledBackupDue(
          interval,
          user.last_success_at,
          user.last_attempt_at,
          now,
        )) return

        const run = await runBackup(env, user.id, { trigger: 'cron' })
        console.log(
          `[inkstone] Scheduled backup ${user.id}: ${run.status}, ${run.results.length} targets, ${run.bytes} bytes`,
        )
      } catch (err) {
        console.error(`[inkstone] User ${user.id} scheduled backup failed:`, err)
      }
    })

    afterUserId = users[users.length - 1]!.id
    if (users.length < USER_PAGE_SIZE) break
  }

  try {
    await trimChangeLogIfDue(env, now)
  } catch (error) {
    console.warn('[inkstone] Failed to trim the change log:', error)
  }
}

function isScheduledBackupDue(
  interval: number,
  lastSuccessAt: number | null,
  lastAttemptAt: number | null,
  now: number,
): boolean {
  if (interval <= 0) return false
  const successDelay = Math.max(0, interval - BACKUP_SCHEDULE_EARLY_TOLERANCE_MS)
  if (lastSuccessAt !== null && now - lastSuccessAt < successDelay) return false
  const retryDelay = Math.min(successDelay, BACKUP_RETRY_INTERVAL_MS)
  return lastAttemptAt === null || now - lastAttemptAt >= retryDelay
}

async function trimChangeLogIfDue(env: Env, now: number): Promise<void> {
  if (!isChangeLogTrimDue(await getMeta(env.DB, CHANGE_LOG_TRIM_META_KEY), now)) return

  let release: (() => Promise<void>) | null = null
  try {
    release = await acquireLease(
      env.DB,
      CHANGE_LOG_TRIM_LEASE_KEY,
      30 * 60 * 1000,
      'Change-log maintenance is already running',
    )
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return
    throw error
  }

  try {
    if (!isChangeLogTrimDue(await getMeta(env.DB, CHANGE_LOG_TRIM_META_KEY), now)) return
    await trimChangeLog(env)
    await setMeta(env.DB, CHANGE_LOG_TRIM_META_KEY, String(now))
  } finally {
    await release()
  }
}

export function isChangeLogTrimDue(lastSuccess: string | null, now: number): boolean {
  const last = Number(lastSuccess)
  return !Number.isFinite(last) || last < 0 || now - last >= CHANGE_LOG_TRIM_INTERVAL_MS
}

async function trimChangeLog(env: Env): Promise<void> {
  let afterUserId = ''
  while (true) {
    const { results } = await env.DB.prepare(
      `SELECT id AS user_id FROM users WHERE id > ?1 ORDER BY id LIMIT ?2`,
    )
      .bind(afterUserId, USER_PAGE_SIZE)
      .all<{ user_id: string }>()
    if (results.length === 0) break
    for (const row of results) {
      await env.DB.prepare(
        `DELETE FROM changes WHERE seq IN (
           SELECT seq FROM changes WHERE user_id = ?1 AND seq < (
             SELECT MIN(seq) FROM (
               SELECT seq FROM changes WHERE user_id = ?1 ORDER BY seq DESC LIMIT ?2
             )
           ) ORDER BY seq LIMIT 1000
         )`,
      )
        .bind(row.user_id, LIMITS.changeLogKept)
        .run()
    }
    afterUserId = results[results.length - 1]!.user_id
    if (results.length < USER_PAGE_SIZE) break
  }
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
