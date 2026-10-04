// @vitest-environment node
import { webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authRoutes } from '../src/worker/routes/auth'
import type { Env } from '../src/worker/env'
import { hashToken } from '../src/worker/lib/session-store'
import { completeTotpLogin, createTotpLoginChallenge } from '../src/worker/lib/totp-service'

vi.mock('../src/worker/lib/reauth', () => ({
  requireCurrentPassword: vi.fn(async () => 'old-hash'),
}))
vi.mock('../src/worker/lib/password', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/worker/lib/password')>(),
  hashPassword: vi.fn(async () => 'new-hash'),
  validateNewPassword: vi.fn(() => null),
}))
vi.mock('../src/worker/lib/throttle', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/worker/lib/throttle')>(),
  assertNotLocked: vi.fn(async () => {}),
  consumeAttemptBudget: vi.fn(async () => {}),
}))

let sqlite: DatabaseSync
let db: D1Database
const sessionToken = 'a'.repeat(64)

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER, created_at INTEGER);
    CREATE TABLE totp_login_challenges (
      id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER, created_at INTEGER, claimed_by TEXT
    );
    CREATE TABLE totp_credentials (
      user_id TEXT PRIMARY KEY, enabled_at INTEGER, secret_ciphertext TEXT,
      recovery_generation TEXT, last_used_step INTEGER
    );
    INSERT INTO users VALUES ('user', 'old-hash');
    INSERT INTO totp_credentials VALUES ('user', 1, 'encrypted', 'generation', NULL);
  `)
  sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)')
    .run(await hashToken(sessionToken), 'user', Date.now() + 60_000, Date.now())

  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql)
      let values: unknown[] = []
      const args = () => /\?\d+/.test(sql)
        ? [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
        : values
      const prepared = {
        bind(...bound: unknown[]) { values = bound; return prepared },
        async first() { return statement.get(...args() as never[]) ?? null },
        async run() {
          return { meta: { changes: Number(statement.run(...args() as never[]).changes) } }
        },
      }
      return prepared
    },
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
})

afterEach(() => {
  sqlite.close()
  vi.unstubAllGlobals()
})

async function changePassword() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('user', { id: 'user' })
    c.set('sessionId', await hashToken(sessionToken))
    await next()
  })
  app.route('/auth', authRoutes)
  return app.request('/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `inkstone_session=${sessionToken}` },
    body: JSON.stringify({ currentPassword: 'old password', newPassword: 'new password' }),
  }, { DB: db })
}

it('revokes outstanding two-factor login challenges when the password changes', async () => {
  const challenge = await createTotpLoginChallenge(db, 'user', 'old-hash')
  expect((await changePassword()).status).toBe(200)
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM totp_login_challenges').get()?.n).toBe(0)
  await expect(completeTotpLogin({
    env: { DB: db } as Env,
    challengeToken: challenge.challengeToken,
    code: '123456',
  })).rejects.toMatchObject({ code: 'two_factor_challenge_expired' })
})

it('rejects challenge issuance with a password hash verified before a password change', async () => {
  expect((await changePassword()).status).toBe(200)
  await expect(createTotpLoginChallenge(db, 'user', 'old-hash'))
    .rejects.toMatchObject({ code: 'unauthenticated' })
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM totp_login_challenges').get()?.n).toBe(0)
  await expect(createTotpLoginChallenge(db, 'user', 'new-hash'))
    .resolves.toMatchObject({ twoFactorRequired: true })
})
