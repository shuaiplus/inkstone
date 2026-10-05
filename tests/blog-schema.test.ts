import { describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'

const statements = SCHEMA_STATEMENTS.join('\n')

describe('blog independent tables (migration 14)', () => {
  it('creates blog_settings with a customizable moments folder', () => {
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS blog_settings')
    expect(statements).toContain('moments_folder')
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
