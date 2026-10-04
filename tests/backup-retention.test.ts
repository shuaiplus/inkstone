import { webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { TargetRow } from '../src/worker/backup/engine'
import { retainSuccessfulBackup } from '../src/worker/backup/retention'

let sqlite: DatabaseSync
let db: D1Database
const target = { id: 'target', user_id: 'user', type: 'webdav', config: '{"url":"https://dav.example.com/","prefix":"notes"}' } as TargetRow
const snapshot = (day: number) => ({ stamp: `202610${String(day).padStart(2, '0')}-000000-000`, createdAt: new Date(Date.UTC(2026, 9, day)) })
const path = (day: number) => `backups/inkstone-backup-${snapshot(day).stamp}.zip`

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.prepare('INSERT INTO backup_targets (id, user_id, type, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)')
    .run(target.id, target.user_id, target.type, 'Test', target.config)
  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql)
      let values: unknown[] = []
      const args = () => [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
      const prepared = {
        bind(...bound: unknown[]) { values = bound; return prepared },
        async first() { return statement.get(...args() as never[]) ?? null },
        async all() { return { results: statement.all(...args() as never[]) } },
        async run() { return { meta: { changes: Number(statement.run(...args() as never[]).changes) } } },
      }
      return prepared
    },
  } as unknown as D1Database
})
afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })

async function seed() {
  for (let day = 1; day <= 3; day++) await retainSuccessfulBackup(db, target, snapshot(day), 100, vi.fn())
}
const rows = () => sqlite.prepare('SELECT archive_path FROM backup_archives ORDER BY created_at').all().map(row => row.archive_path)

describe('successful backup retention', () => {
  it('migrates an existing database additively and idempotently', () => {
    const statements = SCHEMA_STATEMENTS.filter(statement => statement.includes('backup_archives'))
    sqlite.exec('DROP TABLE backup_archives')
    sqlite.exec(statements.join(';'))
    sqlite.exec(statements.join(';'))
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM backup_targets').get()?.count).toBe(1)
    expect(rows()).toEqual([])
  })
  it('keeps unlimited backups without adding records or making delete requests', async () => {
    const remove = vi.fn()
    await seed()
    await retainSuccessfulBackup(db, target, snapshot(4), 0, remove)
    expect(remove).not.toHaveBeenCalled()
    expect(rows()).toEqual([path(1), path(2), path(3)])
  })
  it('keeps the latest successful copies and deletes only tracked excess archives', async () => {
    await seed()
    const remove = vi.fn(async (_path: string) => {})
    await retainSuccessfulBackup(db, target, snapshot(4), 2, remove)
    expect(remove.mock.calls.map(call => call[0])).toEqual([path(2), path(1)])
    expect(rows()).toEqual([path(3), path(4)])
    await retainSuccessfulBackup(db, target, snapshot(4), 2, remove)
    expect(remove).toHaveBeenCalledTimes(2)
  })
  it('preserves failed deletions for retry and never deletes the new successful archive', async () => {
    await seed()
    await expect(retainSuccessfulBackup(db, target, snapshot(4), 1, vi.fn(async () => { throw Error('HTTP 403') }))).rejects.toThrow('HTTP 403')
    expect(rows()).toEqual([path(1), path(2), path(3), path(4)])
    const remove = vi.fn(async (_path: string) => {})
    await retainSuccessfulBackup(db, target, snapshot(4), 1, remove)
    expect(rows()).toEqual([path(4)])
    expect(remove.mock.calls.map(call => call[0])).not.toContain(path(4))
  })
  it('isolates destinations after a target path changes', async () => {
    await seed()
    const changed = { ...target, config: '{"url":"https://dav.example.com/","prefix":"new"}' }
    sqlite.prepare('UPDATE backup_targets SET config = ?').run(changed.config)
    const remove = vi.fn(async (_path: string) => {})
    await retainSuccessfulBackup(db, changed, snapshot(4), 1, remove)
    expect(remove).not.toHaveBeenCalled()
    expect(rows()).toEqual([path(1), path(2), path(3), path(4)])
  })
  it('does not clean up a target removed or changed during upload', async () => {
    await seed()
    sqlite.exec('DELETE FROM backup_targets')
    const remove = vi.fn(async (_path: string) => {})
    await retainSuccessfulBackup(db, target, snapshot(4), 1, remove)
    expect(remove).not.toHaveBeenCalled()
  })
  it('isolates users and targets and rejects unrelated recorded paths', async () => {
    await seed()
    const destination = sqlite.prepare('SELECT destination FROM backup_archives LIMIT 1').get()!.destination
    const insert = sqlite.prepare('INSERT INTO backup_archives VALUES (?, ?, ?, ?, 1)')
    insert.run('other-user', target.id, destination, path(1))
    insert.run(target.user_id, 'other-target', destination, path(1))
    insert.run(target.user_id, target.id, destination, 'backups/personal.zip')
    const remove = vi.fn(async (_path: string) => {})
    await retainSuccessfulBackup(db, target, snapshot(4), 1, remove)
    expect(remove.mock.calls.map(call => call[0])).toEqual([path(3), path(2), path(1)])
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM backup_archives').get()?.count).toBe(4)
  })
  it('bounds a large cleanup and continues on the next successful backup', async () => {
    await seed()
    const destination = sqlite.prepare('SELECT destination FROM backup_archives LIMIT 1').get()!.destination
    const insert = sqlite.prepare('INSERT INTO backup_archives VALUES (?, ?, ?, ?, ?)')
    for (let number = 1; number <= 60; number++) {
      insert.run(target.user_id, target.id, destination, `backups/inkstone-backup-20250901-${String(number).padStart(6, '0')}-000.zip`, number)
    }
    const remove = vi.fn(async (_path: string) => {})
    await expect(retainSuccessfulBackup(db, target, snapshot(4), 1, remove)).rejects.toThrow('continue')
    expect(remove).toHaveBeenCalledTimes(50)
    await retainSuccessfulBackup(db, target, snapshot(5), 1, remove)
    expect(rows()).toEqual([path(5)])
  })
})
