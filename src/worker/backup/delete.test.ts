import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { s3DeleteArchive } from './s3'
import { webdavDeleteArchive } from './webdav'
import type { S3Config, WebdavConfig } from '@shared/types'

const mocks = vi.hoisted(() => ({ awsFetch: vi.fn() }))
vi.mock('aws4fetch', () => ({ AwsClient: class { fetch = mocks.awsFetch } }))
const archive = 'backups/inkstone-backup-20261004-000000-000.zip'
const s3: S3Config = { endpoint: 'https://storage.example.com', bucket: 'notes', region: 'auto', prefix: 'inkstone', pathStyle: true, mode: 'archive' }
const dav: WebdavConfig = { url: 'https://dav.example.com/root/', username: 'user', prefix: 'inkstone', mode: 'archive' }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  mocks.awsFetch.mockReset()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

it('deletes the exact S3 archive under the configured prefix', async () => {
  mocks.awsFetch.mockResolvedValue(new Response(null, { status: 204 }))
  await s3DeleteArchive(s3, { accessKeyId: 'key', secretAccessKey: 'secret' }, archive)
  expect(mocks.awsFetch).toHaveBeenCalledWith(`https://storage.example.com/notes/inkstone/${archive}`, expect.objectContaining({ method: 'DELETE', redirect: 'manual' }))
})
it('deletes the exact WebDAV archive under the configured prefix', async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
  await webdavDeleteArchive(dav, { password: 'secret' }, archive)
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://dav.example.com/root/inkstone/${archive}`)
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE', redirect: 'manual', headers: { Authorization: expect.stringMatching(/^Basic /) } })
})
it.each(['s3', 'webdav'])('treats an already missing %s archive as cleaned up', async type => {
  mocks.awsFetch.mockResolvedValue(new Response(null, { status: 404 }))
  fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
  if (type === 's3') await s3DeleteArchive(s3, { accessKeyId: 'key', secretAccessKey: 'secret' }, archive)
  else await webdavDeleteArchive(dav, { password: 'secret' }, archive)
})
it.each(['s3', 'webdav'])('reports denied deletion of a %s archive', async type => {
  mocks.awsFetch.mockResolvedValue(new Response(null, { status: 403 }))
  fetchMock.mockResolvedValue(new Response(null, { status: 403 }))
  const remove = type === 's3'
    ? s3DeleteArchive(s3, { accessKeyId: 'key', secretAccessKey: 'secret' }, archive)
    : webdavDeleteArchive(dav, { password: 'secret' }, archive)
  await expect(remove).rejects.toThrow('HTTP 403')
})
it('blocks WebDAV deletion redirects to a different origin', async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://other.example.com/archive.zip' } }))
  await expect(webdavDeleteArchive(dav, { password: 'secret' }, archive)).rejects.toThrow('another origin')
  expect(fetchMock).toHaveBeenCalledOnce()
})
