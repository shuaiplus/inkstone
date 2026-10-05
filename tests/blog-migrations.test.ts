// @vitest-environment node
// Upgrade-path regression tests using real SQLite: fresh installs, the
// v13 production state (no blog tables), and the v15-era blog schema must
// all converge through initializeDatabase without throwing.
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

function wrap(sqlite: DatabaseSync): D1Database {
  const db = {
    prepare(sql: string) {
      // Lazily prepare like real D1: statements must be creatable before
      // the tables they reference exist (fresh-install batch path).
      let compiled: ReturnType<DatabaseSync['prepare']> | null = null
      let values: unknown[] = []
      const stmt = () => (compiled ??= sqlite.prepare(sql))
      const args = () => /\?\d+/.test(sql)
        ? [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
        : values
      const prepared = {
        bind(...bound: unknown[]) { values = bound; return prepared },
        async first() { return (stmt().get(...args() as never[]) as unknown) ?? null },
        async all() { return { results: stmt().all(...args() as never[]) as unknown[] } },
        async run() {
          const r = stmt().run(...args() as never[])
          return { success: true, meta: { changes: Number(r.changes) } }
        },
      }
      return prepared
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const s of statements) results.push(await s.run())
        sqlite.exec('COMMIT')
        return results
      } catch (e) { sqlite.exec('ROLLBACK'); throw e }
    },
  } as unknown as D1Database
  return db
}

function v13Database(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      login TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member', settings TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
  `)
  const now = Date.now()
  for (let v = 1; v <= 13; v++) {
    sqlite.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, now)
  }
  return { db: wrap(sqlite), sqlite }
}

function blogSettingsColumns(sqlite: DatabaseSync): string[] {
  return (sqlite.prepare('PRAGMA table_info(blog_settings)').all() as Array<{ name: string }>).map((c) => c.name)
}

describe('blog migration upgrade paths', () => {
  it('upgrades a v13 production database without throwing', async () => {
    const { initializeDatabase } = await import('../src/worker/db/schema')
    const { db, sqlite } = v13Database()
    const state = await initializeDatabase({ DB: db } as never)
    expect(state.ftsEnabled).toBe(true)
    const cols = blogSettingsColumns(sqlite)
    expect(cols).toContain('settings_json')
    expect(cols).not.toContain('public_tag')
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
    expect(tables).toContain('blog_posts')
    expect(tables).toContain('blog_sessions')
  }, 60000)

  it('migrates v15-era tag columns into settings_json', async () => {
    const { initializeDatabase } = await import('../src/worker/db/schema')
    const { db, sqlite } = v13Database()
    // Simulate an install that already applied v14/v15 with the old defs.
    sqlite.exec(`
      CREATE TABLE blog_settings (
        user_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
        public_tag TEXT NOT NULL DEFAULT 'blog-public',
        private_tag TEXT NOT NULL DEFAULT 'blog-private',
        moments_folder TEXT NOT NULL DEFAULT 'Moments',
        moments_public_tag TEXT NOT NULL DEFAULT 'moment-public',
        moments_private_tag TEXT NOT NULL DEFAULT 'moment-private',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO blog_settings VALUES ('u1', 'T', 'D', 'h', 'my-public', 'blog-private', 'Moments', 'mp', 'mq', 1, 2);
    `)
    await initializeDatabase({ DB: db } as never)
    const cols = blogSettingsColumns(sqlite)
    expect(cols).toContain('settings_json')
    expect(cols).not.toContain('public_tag')
    expect(cols).not.toContain('moments_folder')
    const row = sqlite.prepare('SELECT settings_json FROM blog_settings WHERE user_id = ?').get('u1') as { settings_json: string }
    expect(JSON.parse(row.settings_json)).toEqual({ publicTag: 'my-public', privateTag: 'blog-private', momentsTag: 'moment' })
  }, 60000)

  it('initializes a fresh database without throwing', async () => {
    const { initializeDatabase } = await import('../src/worker/db/schema')
    const sqlite = new DatabaseSync(':memory:')
    const before = await initializeDatabase({ DB: wrap(sqlite) } as never)
    expect(before.ftsEnabled).toBe(true)
    expect(blogSettingsColumns(sqlite)).toContain('settings_json')
  }, 60000)
})
