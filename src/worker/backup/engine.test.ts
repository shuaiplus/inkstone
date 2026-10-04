import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Env } from '../env'
import { runBackup, type TargetRow } from './engine'

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(), retain: vi.fn(), release: Object.assign(vi.fn(async () => {}), { renew: vi.fn(async () => true) }),
}))
vi.mock('../lib/lease', () => ({ acquireLease: vi.fn(async () => mocks.release) }))
vi.mock('../lib/crypto', () => ({ decryptSecret: vi.fn(async () => ({ password: 'password' })) }))
vi.mock('./snapshot', () => ({ buildSnapshot: vi.fn(async () => ({ noteCount: 1, bytes: 10, payloadFiles: [], stamp: '20261004-000000-000', createdAt: new Date() })) }))
vi.mock('./webdav', () => ({ webdavDeliver: mocks.deliver, webdavDeleteArchive: vi.fn(), webdavTest: vi.fn() }))
vi.mock('./retention', () => ({ retainSuccessfulBackup: mocks.retain }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.deliver.mockResolvedValue({ files: 1, bytes: 10 })
  mocks.retain.mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

const target = { id: 'target', user_id: 'user', type: 'webdav', name: 'Backup', config: '{}', secret: 'encrypted', updated_at: 1 } as TargetRow
function environment(): Env {
  return { DB: {
    prepare(sql: string) {
      return {
        bind() { return this },
        async all() { return { results: sql.includes('backup_targets') ? [target] : [] } },
        async first() { return { settings: '{"backup":{"retentionCount":7}}' } },
      }
    },
    async batch() { return [] },
  } } as unknown as Env
}

it('runs retention only after delivery succeeds', async () => {
  mocks.deliver.mockRejectedValueOnce(Error('HTTP 403'))
  const run = await runBackup(environment(), 'user', { trigger: 'cron' })
  expect(run.status).toBe('failed')
  expect(mocks.retain).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledOnce()
})

it.each(['manual', 'cron'] as const)('passes configured retention for a successful %s backup', async trigger => {
  const run = await runBackup(environment(), 'user', { trigger })
  expect(run.status).toBe('success')
  expect(mocks.retain).toHaveBeenCalledWith(expect.anything(), target, expect.anything(), 7, expect.any(Function))
  expect(run.results[0]?.warning).toBeUndefined()
})

it('reports cleanup failure separately while preserving successful backup status', async () => {
  mocks.retain.mockRejectedValueOnce(Error('Delete denied: HTTP 403'))
  const run = await runBackup(environment(), 'user', { trigger: 'manual' })
  expect(run.status).toBe('success')
  expect(run.results[0]).toMatchObject({ ok: true, files: 1, bytes: 10, error: null, warning: 'Delete denied: HTTP 403' })
  expect(mocks.deliver).toHaveBeenCalledOnce()
})
