import { Hono, type Context } from 'hono'
import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import type { BackupRun, BackupTargetInput, BackupTargetPatchInput, BackupTargetResult } from '@shared/types'
import type { AppBindings } from '../env'
import { runBackup, testTarget, toBackupTarget, type TargetRow } from '../backup/engine'
import {
  BackupConfigError,
  normalizeBackupPrefix,
  normalizeS3Region,
  parseBackupEndpoint,
  validateS3Bucket,
} from '../backup/validation'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson, readOptionalJson } from '../lib/request'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'

export const backupRoutes = new Hono<AppBindings>()

backupRoutes.use('*', requireAuth)


backupRoutes.get('/targets', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM backup_targets WHERE user_id = ?1 ORDER BY created_at ASC`,
  )
    .bind(c.get('userId'))
    .all<TargetRow>()
  return c.json({ targets: results.map(toBackupTarget) })
})

backupRoutes.post('/targets', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<BackupTargetInput>(c, JSON_BODY_LIMITS.backup)
  validateInput(body, true)

  const id = newId()
  const now = Date.now()
  const config = normalizeConfig(body)
  const secret = await encryptSecret(c.env, id, pickSecret(body))

  const inserted = await c.env.DB.prepare(
    `INSERT INTO backup_targets (id, user_id, type, name, enabled, config, secret, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
      WHERE (SELECT COUNT(*) FROM backup_targets WHERE user_id = ?2) < ?9`,
  )
    .bind(
      id,
      userId,
      body.type,
      truncateText(body.name.trim(), 120),
      body.enabled === false ? 0 : 1,
      JSON.stringify(config),
      secret,
      now,
      LIMITS.backupTargetsMax,
    )
    .run()
  if (!inserted.meta.changes) {
    throw ApiError.conflict(`Each account can configure at most ${LIMITS.backupTargetsMax} backup targets`)
  }

  return c.json(toBackupTarget(await loadTarget(c.env.DB, userId, id)), 201)
})

backupRoutes.patch('/targets/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const existing = await loadTarget(c.env.DB, userId, id)
  const body = await readJson<BackupTargetPatchInput>(c, JSON_BODY_LIMITS.backup)
  validateInputShape(body)
  if (
    body.expectedUpdatedAt !== undefined &&
    (!Number.isSafeInteger(body.expectedUpdatedAt) || body.expectedUpdatedAt < 0)
  ) {
    throw ApiError.badRequest('expectedUpdatedAt must be a non-negative integer')
  }

  const merged = mergeTargetInput(existing, body)
  validateInput(merged, false)

  const hasNewSecret = Boolean(
    body.secret && Object.values(body.secret).some((value) => typeof value === 'string' && value.trim()),
  )
  const changedType = merged.type !== existing.type
  let secret = existing.secret
  if (hasNewSecret || changedType) {
    const current = changedType ? {} : await currentSecret(c, existing)
    const nextSecret = mergeSecret(current, body.secret ?? {})
    assertRequiredSecret(merged.type, nextSecret)
    secret = await encryptSecret(c.env, id, nextSecret)
  }

  const updatedAt = Math.max(Date.now(), existing.updated_at + 1)
  const updated = await c.env.DB.prepare(
    `UPDATE backup_targets SET type = ?1, name = ?2, enabled = ?3, config = ?4, secret = ?5, updated_at = ?6
       WHERE id = ?7 AND user_id = ?8 AND updated_at = ?9`,
  )
    .bind(
      merged.type,
      truncateText(merged.name.trim(), 120),
      merged.enabled === false ? 0 : 1,
      JSON.stringify(normalizeConfig(merged)),
      secret,
      updatedAt,
      id,
      userId,
      body.expectedUpdatedAt ?? existing.updated_at,
    )
    .run()
  if (!updated.meta.changes) {
    throw ApiError.conflict('The backup target changed elsewhere. Refresh and try again')
  }

  return c.json(toBackupTarget(await loadTarget(c.env.DB, userId, id)))
})

backupRoutes.delete('/targets/:id', async (c) => {
  const id = c.req.param('id')
  const userId = c.get('userId')
  const [res] = await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM backup_targets WHERE id = ?1 AND user_id = ?2`).bind(id, userId),
    c.env.DB.prepare(`DELETE FROM backup_archives WHERE target_id = ?1 AND user_id = ?2`).bind(id, userId),
  ])
  if (!res?.meta.changes) throw ApiError.notFound('Backup target not found')
  return c.json({ ok: true })
})


backupRoutes.post('/targets/:id/test', async (c) => {
  await enforceOutboundBudget(c, 'test')
  const target = await loadTarget(c.env.DB, c.get('userId'), c.req.param('id'))
  const override = await readJson<Partial<BackupTargetInput>>(c, JSON_BODY_LIMITS.backup)
  validateInputShape(override)
  const merged = mergeTargetInput(target, override)
  validateInput(merged, false)

  const draft: TargetRow = {
    ...target,
    type: merged.type,
    name: merged.name,
    enabled: merged.enabled === false ? 0 : 1,
    config: JSON.stringify(normalizeConfig(merged)),
  }
  const current = merged.type === target.type ? await currentSecret(c, target) : {}
  const secret = mergeSecret(current, override.secret ?? {})
  assertRequiredSecret(merged.type, secret)
  const result = await testTarget(c.env, draft, secret)
  return c.json(result)
})

backupRoutes.post('/test', async (c) => {
  await enforceOutboundBudget(c, 'test')
  const body = await readJson<BackupTargetInput>(c, JSON_BODY_LIMITS.backup)
  validateInput(body, true)
  const draft: TargetRow = {
    id: 'draft',
    user_id: c.get('userId'),
    type: body.type,
    name: body.name || 'Untitled',
    enabled: 1,
    config: JSON.stringify(normalizeConfig(body)),
    secret: null,
    last_run_at: null,
    last_status: null,
    last_error: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  }
  const result = await testTarget(c.env, draft, pickSecret(body))
  return c.json(result)
})


backupRoutes.post('/run', async (c) => {
  await enforceOutboundBudget(c, 'run')
  const userId = c.get('userId')
  const body = await readOptionalJson<{ targetIds?: string[] }>(
    c,
    JSON_BODY_LIMITS.small,
    {},
  )
  if (
    body.targetIds !== undefined &&
    (!Array.isArray(body.targetIds) || body.targetIds.some((id) => !isValidId(id)))
  ) {
    throw ApiError.badRequest('targetIds must be an array of valid backup target IDs')
  }
  if (body.targetIds && !body.targetIds.length) throw ApiError.badRequest('Select at least one backup target')
  const targetIds = body.targetIds
    ? [...new Set(body.targetIds)]
    : undefined
  if ((targetIds?.length ?? 0) > LIMITS.backupTargetsMax) {
    throw ApiError.badRequest(`Select at most ${LIMITS.backupTargetsMax} backup targets`)
  }
  const run = await runBackup(c.env, userId, { trigger: 'manual', targetIds })
  return c.json(run)
})

backupRoutes.get('/runs', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, trigger, status, started_at, finished_at, note_count, file_count, bytes, detail
       FROM backup_runs WHERE user_id = ?1 ORDER BY started_at DESC LIMIT 50`,
  )
    .bind(c.get('userId'))
    .all<{
      id: string
      trigger: string
      status: string
      started_at: number
      finished_at: number | null
      note_count: number
      file_count: number
      bytes: number
      detail: string
    }>()

  const runs: BackupRun[] = results.map((row) => ({
    id: row.id,
    trigger: row.trigger as BackupRun['trigger'],
    status: row.status as BackupRun['status'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    noteCount: row.note_count,
    fileCount: row.file_count,
    bytes: row.bytes,
    results: parseResults(row.detail),
  }))
  return c.json({ runs })
})


const OUTBOUND_BUDGETS = {
  test: { maxAttempts: 20, windowMs: 10 * 60 * 1000, lockMs: 10 * 60 * 1000 },
  run: { maxAttempts: 30, windowMs: 60 * 60 * 1000, lockMs: 60 * 60 * 1000 },
} as const

async function enforceOutboundBudget(
  c: Context<AppBindings>,
  kind: keyof typeof OUTBOUND_BUDGETS,
): Promise<void> {
  const budget = OUTBOUND_BUDGETS[kind]
  try {
    await consumeAttemptBudget(c.env.DB, [{ key: `backup-${kind}:${c.get('userId')}`, ...budget }])
  } catch (error) {
    if (error instanceof ThrottleError) {
      throw new ApiError(
        429,
        'too_many_attempts',
        `Too many backup requests. Try again in ${error.retryAfterSec} seconds`,
        { retryAfter: error.retryAfterSec },
      )
    }
    throw error
  }
}

async function loadTarget(db: D1Database, userId: string, id: string): Promise<TargetRow> {
  const row = await db
    .prepare(`SELECT * FROM backup_targets WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<TargetRow>()
  if (!row) throw ApiError.notFound('Backup target not found')
  return row
}

async function currentSecret(
  c: { env: AppBindings['Bindings'] },
  target: TargetRow,
): Promise<Record<string, string>> {
  if (!target.secret) return {}
  return (await decryptSecret<Record<string, string>>(c.env, target.id, target.secret)) ?? {}
}

function mergeTargetInput(
  existing: TargetRow,
  incoming: Partial<BackupTargetInput>,
): BackupTargetInput {
  const config =
    incoming.config && typeof incoming.config === 'object' && !Array.isArray(incoming.config)
      ? incoming.config
      : {}
  const secret =
    incoming.secret && typeof incoming.secret === 'object' && !Array.isArray(incoming.secret)
      ? incoming.secret
      : undefined
  return {
    type: (incoming.type ?? existing.type) as BackupTargetInput['type'],
    name: incoming.name ?? existing.name,
    enabled: incoming.enabled ?? existing.enabled === 1,
    config: { ...safeObject(existing.config), ...config },
    ...(secret ? { secret } : {}),
  }
}

function safeObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function mergeSecret(
  current: Record<string, string>,
  incoming: NonNullable<BackupTargetInput['secret']>,
): Record<string, string> {
  const out = { ...current }
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof v === 'string' && v.trim()) out[k] = v
  }
  return out
}

function pickSecret(body: BackupTargetInput): Record<string, string> {
  const out: Record<string, string> = {}
  const keys = body.type === 's3' ? ['accessKeyId', 'secretAccessKey'] : ['password']
  for (const k of keys) {
    const v = body.secret?.[k as keyof NonNullable<BackupTargetInput['secret']>]
    if (typeof v === 'string' && v.trim()) out[k] = v
  }
  return out
}

function normalizeConfig(body: BackupTargetInput): Record<string, unknown> {
  const c = body.config ?? {}
  const mode = 'archive'
  if (body.type === 's3') {
    return {
      endpoint: str(c.endpoint),
      region: normalizeS3Region(str(c.region)),
      bucket: str(c.bucket),
      prefix: normalizeBackupPrefix(str(c.prefix)),
      pathStyle: c.pathStyle !== false,
      mode,
    }
  }
  return {
    url: str(c.url),
    username: str(c.username),
    prefix: normalizeBackupPrefix(str(c.prefix)),
    mode,
  }
}

function validateInput(body: BackupTargetInput, requireSecret: boolean): void {
  validateInputShape(body)
  if (body.type !== 's3' && body.type !== 'webdav') throw ApiError.badRequest('type must be s3 or webdav')
  if (typeof body.name !== 'string' || !body.name.trim()) throw ApiError.badRequest('Enter a name')
  if (body.name.trim().length > 120) throw ApiError.badRequest('The name must not exceed 120 characters')

  const c = body.config ?? {}
  if (body.type === 's3') {
    assertConfigString(c.endpoint, 'Endpoint', 2048)
    assertConfigString(c.region, 'Region', 64)
    assertConfigString(c.bucket, 'Bucket', 255)
    assertConfigString(c.prefix, 'Path prefix', 1024)
    if (c.pathStyle !== undefined && typeof c.pathStyle !== 'boolean') {
      throw ApiError.badRequest('pathStyle must be a boolean')
    }
    if (!str(c.bucket)) throw ApiError.badRequest('Enter a bucket name')
    validateBackupConfig(() => normalizeS3Region(str(c.region)))
    validateBackupConfig(() => validateS3Bucket(str(c.bucket), c.pathStyle !== false))
    validateBackupConfig(() => normalizeBackupPrefix(str(c.prefix)))
    if (str(c.endpoint)) {
      validateBackupConfig(() => parseBackupEndpoint(str(c.endpoint), 'Endpoint'))
    }
    if (requireSecret) assertRequiredSecret('s3', pickSecret(body))
  } else {
    assertConfigString(c.url, "WebDAV address", 2048)
    assertConfigString(c.username, "Username", 256)
    assertConfigString(c.prefix, 'Path prefix', 1024)
    const url = str(c.url)
    if (!url) throw ApiError.badRequest('Enter a WebDAV URL')
    validateBackupConfig(() => parseBackupEndpoint(url, "WebDAV address"))
    validateBackupConfig(() => normalizeBackupPrefix(str(c.prefix)))
    if (!str(c.username)) throw ApiError.badRequest('Enter a username')
    if (requireSecret) assertRequiredSecret('webdav', pickSecret(body))
  }
}

function validateInputShape(body: Partial<BackupTargetInput>): void {
  if (body.type !== undefined && body.type !== 's3' && body.type !== 'webdav') {
    throw ApiError.badRequest('type must be s3 or webdav')
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw ApiError.badRequest('name must be a string')
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw ApiError.badRequest('enabled must be a boolean')
  }
  if (
    body.config !== undefined &&
    (!body.config || typeof body.config !== 'object' || Array.isArray(body.config))
  ) {
    throw ApiError.badRequest('config must be an object')
  }
  if (
    body.secret !== undefined &&
    (!body.secret || typeof body.secret !== 'object' || Array.isArray(body.secret))
  ) {
    throw ApiError.badRequest('secret must be an object')
  }
  if (body.config?.mode !== undefined && body.config.mode !== 'archive' && body.config.mode !== 'mirror') {
    throw ApiError.badRequest('mode must be archive or mirror')
  }
  for (const [key, value] of Object.entries(body.secret ?? {})) {
    if (!['password', 'accessKeyId', 'secretAccessKey'].includes(key)) {
      throw ApiError.badRequest(`Unknown credential field: ${key}`)
    }
    if (value !== undefined && typeof value !== 'string') {
      throw ApiError.badRequest(`${key} must be a string`)
    }
    if (typeof value === 'string' && value.length > 4096) {
      throw ApiError.badRequest(`${key} is too long`)
    }
  }
}

function assertRequiredSecret(
  type: BackupTargetInput['type'],
  secret: Record<string, string>,
): void {
  if (type === 's3') {
    if (!secret.accessKeyId?.trim() || !secret.secretAccessKey?.trim()) {
      throw ApiError.badRequest('Enter an Access Key and Secret Key')
    }
    return
  }
  if (!secret.password?.trim()) throw ApiError.badRequest('Enter a password')
}

function assertConfigString(value: unknown, label: string, maxLength: number): void {
  if (value !== undefined && typeof value !== 'string') {
    throw ApiError.badRequest(`${label} must be a string`)
  }
  if (typeof value === 'string' && value.length > maxLength) {
    throw ApiError.badRequest(`${label} is too long`)
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validateBackupConfig(run: () => unknown): void {
  try {
    run()
  } catch (error) {
    if (error instanceof BackupConfigError) throw ApiError.badRequest(error.message)
    throw error
  }
}

function parseResults(raw: string): BackupTargetResult[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed.filter((r) => r && r.targetId) as BackupTargetResult[]) : []
  } catch {
    return []
  }
}
