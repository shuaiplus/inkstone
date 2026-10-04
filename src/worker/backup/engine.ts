import { LIMITS, mergeSettings } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import type {
  BackupRun,
  BackupTarget,
  BackupTargetResult,
  S3Config,
  TestConnectionResult,
  WebdavConfig,
} from '@shared/types'
import type { Env } from '../env'
import { decryptSecret } from '../lib/crypto'
import { newId } from '../lib/id'
import { acquireLease } from '../lib/lease'
import { buildSnapshot, type Snapshot } from './snapshot'
import { friendlyError, isTransientBackupError } from './common'
import { forEachConcurrent } from './concurrency'
import { s3Deliver, s3DeleteArchive, s3Test, type S3Secret } from './s3'
import { webdavDeliver, webdavDeleteArchive, webdavTest, type WebdavSecret } from './webdav'
import { retainSuccessfulBackup } from './retention'

export interface TargetRow {
  id: string
  user_id: string
  type: 'webdav' | 's3'
  name: string
  enabled: number
  config: string
  secret: string | null
  last_run_at: number | null
  last_status: string | null
  last_error: string | null
  created_at: number
  updated_at: number
}

export function toBackupTarget(row: TargetRow): BackupTarget {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled === 1,
    config: safeParse(row.config),
    hasSecret: Boolean(row.secret),
    lastRunAt: row.last_run_at,
    lastStatus: (row.last_status as 'success' | 'failed' | null) ?? null,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function safeParse(raw: string): S3Config & WebdavConfig {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as S3Config & WebdavConfig)
      : ({} as S3Config & WebdavConfig)
  } catch {
    return {} as S3Config & WebdavConfig
  }
}

const TARGET_TIMEOUT_MIN_MS = 12 * 60_000
const TARGET_TIMEOUT_MAX_MS = 2 * 60 * 60_000
const BACKUP_LEASE_TTL_MS = 30 * 60_000
const BACKUP_LEASE_RENEW_MS = 5 * 60_000
const TEST_TIMEOUT_MS = 20_000

export interface RunOptions {
  trigger: 'manual' | 'cron'
  targetIds?: string[]
}


export async function runBackup(env: Env, userId: string, options: RunOptions): Promise<BackupRun> {
  const release = await acquireLease(
    env.DB,
    `snapshot_lock:${userId}`,
    BACKUP_LEASE_TTL_MS,
    'A backup or export is already running. Try again later',
  )

  const heartbeat = setInterval(() => {
    void release.renew().then((ok) => {
      if (!ok) console.error(`[inkstone] Backup lease was lost for ${userId}`)
    }).catch((error) => {
      console.warn('[inkstone] Backup lease renewal failed:', error instanceof Error ? error.message : error)
    })
  }, BACKUP_LEASE_RENEW_MS)
  try {
    return await runBackupUnlocked(env, userId, options)
  } finally {
    clearInterval(heartbeat)
    await release()
  }
}

async function runBackupUnlocked(
  env: Env,
  userId: string,
  options: RunOptions,
): Promise<BackupRun> {
  const startedAt = Date.now()
  const runId = newId()

  const targets = await loadTargets(env, userId, options.targetIds)
  if (!targets.length) {
    const empty: BackupRun = {
      id: runId,
      trigger: options.trigger,
      status: 'failed',
      startedAt,
      finishedAt: Date.now(),
      noteCount: 0,
      fileCount: 0,
      bytes: 0,
      results: [],
    }
    await persistRunSafely(env, userId, empty, 'No backup targets are enabled')
    return empty
  }

  let snapshot: Snapshot
  try {
    snapshot = await buildSnapshot(env, userId)
  } catch (error) {
    const message = friendlyError(error)
    const results: BackupTargetResult[] = targets.map((target) => ({
      targetId: target.id,
      targetName: target.name,
      targetType: target.type,
      ok: false,
      files: 0,
      bytes: 0,
      ms: Date.now() - startedAt,
      error: truncateText(message, 1000),
    }))
    const failed: BackupRun = {
      id: runId,
      trigger: options.trigger,
      status: 'failed',
      startedAt,
      finishedAt: Date.now(),
      noteCount: 0,
      fileCount: 0,
      bytes: 0,
      results,
    }
    await recordOutcomeSafely(env, userId, failed, targets)
    return failed
  }

  const user = await env.DB.prepare(`SELECT settings FROM users WHERE id = ?1`).bind(userId).first<{ settings: string }>()
  const retentionCount = mergeSettings(user ? safeParse(user.settings) : {}).backup.retentionCount
  const results = new Array<BackupTargetResult>(targets.length)
  await forEachConcurrent(targets, 2, async (target, index) => {
    results[index] = await deliverToTarget(env, target, snapshot, retentionCount)
  })

  const okCount = results.filter((r) => r.ok).length
  const run: BackupRun = {
    id: runId,
    trigger: options.trigger,
    status: okCount === results.length ? 'success' : okCount === 0 ? 'failed' : 'partial',
    startedAt,
    finishedAt: Date.now(),
    noteCount: snapshot.noteCount,
    fileCount: results.reduce((sum, r) => sum + r.files, 0),
    bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    results,
  }

  await recordOutcomeSafely(env, userId, run, targets)
  return run
}

async function deliverToTarget(
  env: Env,
  target: TargetRow,
  snapshot: Snapshot,
  retentionCount: number,
): Promise<BackupTargetResult> {
  const started = Date.now()
  const base: Omit<BackupTargetResult, 'ok' | 'files' | 'bytes' | 'ms' | 'error'> = {
    targetId: target.id,
    targetName: target.name,
    targetType: target.type,
  }

  try {
    const config = safeParse(target.config)
    const secret = target.secret
      ? await decryptSecret<S3Secret & WebdavSecret>(env, target.id, target.secret)
      : null
    if (!secret) {
      throw new Error('Backup credentials could not be decrypted. Enter them again in Settings')
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), targetTimeoutMs(snapshot))
      try {
        const outcome =
          target.type === 's3'
            ? await s3Deliver(config, secret, snapshot, controller.signal)
            : await webdavDeliver(config, secret, snapshot, controller.signal)
        let warning: string | undefined
        try {
          const cleanupSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
          await retainSuccessfulBackup(env.DB, target, snapshot, retentionCount, (path) => {
            const signal = AbortSignal.any([cleanupSignal, AbortSignal.timeout(10_000)])
            return target.type === 's3'
              ? s3DeleteArchive(config, secret, path, signal)
              : webdavDeleteArchive(config, secret, path, signal)
          })
        } catch (error) {
          warning = truncateText(friendlyError(error), 1000)
        }
        return { ...base, ok: true, files: outcome.files, bytes: outcome.bytes, ms: Date.now() - started, error: null, ...(warning ? { warning } : {}) }
      } catch (error) {
        if (attempt > 0 || !isTransientBackupError(error)) throw error
      } finally {
        clearTimeout(timer)
      }
    }
    throw new Error('Backup transfer did not complete')
  } catch (err) {
    return {
      ...base,
      ok: false,
      files: 0,
      bytes: 0,
      ms: Date.now() - started,
      error: truncateText(friendlyError(err), 1000),
    }
  }
}

function targetTimeoutMs(snapshot: Snapshot): number {
  const transferBudget = snapshot.bytes / (128 * 1024) * 1000
  const requestBudget = (snapshot.payloadFiles.length + 2) * 500
  return Math.min(
    TARGET_TIMEOUT_MAX_MS,
    Math.max(TARGET_TIMEOUT_MIN_MS, 5 * 60_000 + transferBudget + requestBudget),
  )
}

async function loadTargets(env: Env, userId: string, ids?: string[]): Promise<TargetRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM backup_targets WHERE user_id = ?1 AND enabled = 1 ORDER BY created_at ASC`,
  )
    .bind(userId)
    .all<TargetRow>()
  if (!ids?.length) return results
  const wanted = new Set(ids)
  return results.filter((t) => wanted.has(t.id))
}

async function persistRun(env: Env, userId: string, run: BackupRun, note?: string): Promise<void> {
  const detail = JSON.stringify(note ? [{ error: note }, ...run.results] : run.results)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO backup_runs (id, user_id, trigger, status, started_at, finished_at,
         note_count, file_count, bytes, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(
      run.id,
      userId,
      run.trigger,
      run.status,
      run.startedAt,
      run.finishedAt,
      run.noteCount,
      run.fileCount,
      run.bytes,
      detail,
    ),
    env.DB.prepare(
      `DELETE FROM backup_runs WHERE id IN (
         SELECT id FROM backup_runs WHERE user_id = ?1 ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?2
       )`,
    ).bind(userId, LIMITS.backupRunsKept),
  ])
}

async function persistRunSafely(
  env: Env,
  userId: string,
  run: BackupRun,
  note?: string,
): Promise<void> {
  try {
    await persistRun(env, userId, run, note)
  } catch (error) {
    console.error(`[inkstone] Backup completed, but writing the run record failed (${run.id}):`, error)
  }
}

async function recordOutcomeSafely(
  env: Env,
  userId: string,
  run: BackupRun,
  targets: readonly TargetRow[],
): Promise<void> {
  await persistRunSafely(env, userId, run)
  try {
    await updateTargetStates(env, userId, run.results, targets)
  } catch (error) {
    console.error(`[inkstone] Backup completed, but writing target state failed (${run.id}):`, error)
  }
}

async function updateTargetStates(
  env: Env,
  userId: string,
  results: BackupTargetResult[],
  targets: readonly TargetRow[],
): Promise<void> {
  const now = Date.now()
  if (!results.length) return
  const targetVersions = new Map(targets.map((target) => [target.id, target.updated_at]))
  await env.DB.batch(
    results.flatMap((result) => {
      const targetVersion = targetVersions.get(result.targetId)
      return targetVersion === undefined ? [] : [
        env.DB.prepare(
          `UPDATE backup_targets SET last_run_at = ?1, last_status = ?2, last_error = ?3, updated_at = ?1
             WHERE id = ?4 AND user_id = ?5 AND updated_at = ?6`,
        ).bind(now, result.ok ? 'success' : 'failed', result.error, result.targetId, userId, targetVersion),
      ]
    }),
  )
}

export async function testTarget(
  env: Env,
  target: TargetRow,
  overrideSecret?: S3Secret & WebdavSecret,
): Promise<TestConnectionResult> {
  const config = safeParse(target.config)
  const secret =
    overrideSecret ??
    (target.secret ? await decryptSecret<S3Secret & WebdavSecret>(env, target.id, target.secret) : null)

  if (!secret) {
    return { ok: false, message: 'Enter credentials before testing' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    return target.type === 's3'
      ? await s3Test(config, secret, controller.signal)
      : await webdavTest(config, secret, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}
