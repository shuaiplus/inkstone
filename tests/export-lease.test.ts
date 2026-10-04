// @vitest-environment node
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppBindings } from '../src/worker/env'
import { transferRoutes } from '../src/worker/routes/transfer'

const mocks = vi.hoisted(() => ({
  release: Object.assign(vi.fn(async () => {}), { renew: vi.fn(async () => true) }),
  buildSnapshot: vi.fn(),
  createBackupArchive: vi.fn(),
  buildJsonExport: vi.fn(async () => '{}'),
}))
vi.mock('../src/worker/lib/lease', () => ({ acquireLease: vi.fn(async () => mocks.release) }))
vi.mock('../src/worker/backup/snapshot', () => ({
  buildSnapshot: mocks.buildSnapshot,
  buildJsonExport: mocks.buildJsonExport,
  assertBundleCanBeRestored: vi.fn(),
  formatStamp: vi.fn(() => 'stamp'),
}))
vi.mock('../src/worker/backup/archive', () => ({ createBackupArchive: mocks.createBackupArchive }))

let source: ReadableStreamDefaultController<Uint8Array>
let completed: Promise<unknown>[]

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.release.renew.mockResolvedValue(true)
  mocks.buildSnapshot.mockResolvedValue({})
  completed = []
  vi.stubGlobal('FixedLengthStream', class extends TransformStream {
    constructor(_length: bigint) { super() }
  })
  const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller } })
  mocks.createBackupArchive.mockReturnValue({ stream, byteLength: 1n, filename: 'export.zip' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function exportRequest(format = 'zip') {
  const app = new Hono<AppBindings>()
  app.use('*', async (c, next) => { c.set('userId', 'user'); await next() })
  app.route('/transfer', transferRoutes)
  return app.request(`/transfer/export?format=${format}`, {}, { DB: {} } as AppBindings['Bindings'], {
    waitUntil(promise: Promise<unknown>) { completed.push(promise) },
    passThroughOnException() {},
  } as ExecutionContext)
}

it('holds and renews the lease until the ZIP stream completes', async () => {
  const response = await exportRequest()
  expect(mocks.release).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(mocks.release.renew).toHaveBeenCalledOnce()
  const body = response.arrayBuffer()
  source.enqueue(new Uint8Array([1]))
  source.close()
  await body
  await Promise.all(completed)
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('releases the lease when the client cancels the stream', async () => {
  const response = await exportRequest()
  await response.body!.cancel()
  await Promise.all(completed)
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('releases the lease when the ZIP source fails during streaming', async () => {
  const response = await exportRequest()
  source.error(new Error('source failed'))
  await expect(response.arrayBuffer()).rejects.toThrow('source failed')
  await Promise.all(completed)
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('aborts and releases the stream when lease renewal fails', async () => {
  const response = await exportRequest()
  mocks.release.renew.mockResolvedValueOnce(false)
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  await expect(response.arrayBuffer()).rejects.toThrow('The export lease was lost')
  await Promise.all(completed)
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('releases the lease if snapshot construction fails', async () => {
  mocks.buildSnapshot.mockRejectedValueOnce(new Error('snapshot failed'))
  expect((await exportRequest()).status).toBe(500)
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('releases the lease after the non-streaming JSON export is built', async () => {
  const response = await exportRequest('json')
  expect(await response.text()).toBe('{}')
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
