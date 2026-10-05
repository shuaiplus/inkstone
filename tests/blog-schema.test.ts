import { describe, expect, it } from 'vitest'
import { SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'

const statements = SCHEMA_STATEMENTS.join('\n')
const migrationSource = SCHEMA_MIGRATIONS.map((m) => m.statements.join('\n')).join('\n')

describe('blog independent tables (migration 14)', () => {
  it('creates blog_settings with flexible JSON tag config', () => {
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS blog_settings')
    expect(statements).toContain('settings_json')
    expect(statements).not.toContain('public_tag')
  })

  it('creates blog_posts keyed by (user_id, note_id) with per-user slug', () => {
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS blog_posts')
    expect(statements).toContain('PRIMARY KEY (user_id, note_id)')
    expect(statements).toContain('idx_blog_posts_slug')
    expect(statements).toContain('ON blog_posts(user_id, slug)')
  })

  it('creates blog_sessions for expiry cleanup', () => {
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS blog_sessions')
    expect(statements).toContain('idx_blog_sessions_user')
  })
})

describe('blog settings JSON (migration 16)', () => {
  it('adds and backfills settings_json without destructive DDL', () => {
    expect(migrationSource).toContain('ADD COLUMN settings_json')
    expect(migrationSource).toContain('json_object')
    // Column drops are conditional code (dropLegacyBlogColumns), never
    // static migration statements, so skipped migrations can't strand them.
    expect(migrationSource).not.toContain('DROP COLUMN')
  })
})
