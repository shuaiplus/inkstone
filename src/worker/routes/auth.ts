import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { isBitmapAvatarDataUrl, PROFILE_NAME_MAX_LENGTH } from '@shared/avatar'
import type { AppLocale, SessionInfo, UserSettings } from '@shared/types'
import type { AppBindings, Env } from '../env'
import { drainAttachmentCleanup } from '../attachments/cleanup'
import { attachmentCleanupTarget } from '../attachments/keys'
import {
  discardStoredAvatar,
  normalizeAvatarPreference,
  persistUploadedAvatar,
  storedAvatarCleanup,
  type StoredAvatarObject,
} from '../avatars/storage'
import { seedWorkspace } from '../db/seed'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { getAllowRegistration } from '../lib/instance-settings'
import { buildSiteInfo, loadUser, publicUser, sessionInfo } from '../lib/session-info'
import {
  dummyVerify,
  hashPassword,
  isPasswordHash,
  normalizeUsername,
  PASSWORD_MAX_LENGTH,
  USERNAME_PATTERN,
  validateNewPassword,
  verifyPassword,
} from '../lib/password'
import { requireCurrentPassword } from '../lib/reauth'
import { JSON_BODY_LIMITS, readJson, requestClientIp } from '../lib/request'
import { commitChange } from '../lib/notify'
import { createSession, destroyOtherSessions, destroySession } from '../lib/session-store'
import { createTotpLoginChallenge, hasEnabledTotp } from '../lib/totp-service'
import {
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
  type ThrottleTarget,
  ThrottleError,
} from '../lib/throttle'
import {
  clearSessionCookie,
  requireAuth,
  rowToUser,
  sessionCookieNames,
  USER_COLUMNS,
  writeSessionCookie,
} from '../middleware/auth'

export const authRoutes = new Hono<AppBindings>()

export { normalizeAvatarPreference } from '../avatars/storage'

export function loginThrottleTargets(username: string, ip: string): ThrottleTarget[] {
  const identity = throttleIdentity(username)
  return [
    { key: `login:${ip}:${identity}`, freeFails: 5 },
    { key: `login-ip:${ip}`, freeFails: 25 },
    // Account-wide cap so a distributed botnet cannot retry one account
    // from many IPs forever; cleared on every successful sign-in, so a
    // normal user only ever notices it after 30 failed attempts per hour.
    { key: `login-account:${identity}`, freeFails: 30 },
  ]
}

export function loginWorkTargets(username: string, ip: string) {
  const identity = throttleIdentity(username)
  const windowMs = 10 * 60 * 1000
  return [
    { key: `login-work:${ip}:${identity}`, maxAttempts: 8, windowMs },
    { key: `login-work-ip:${ip}`, maxAttempts: 30, windowMs },
  ]
}

function throttleIdentity(username: string): string {
  return USERNAME_PATTERN.test(username) ? username : '_invalid'
}

async function rotateSession(c: Context<AppBindings>, userId: string): Promise<string> {
  await destroyPresentedSessions(c)
  return createSession(c.env.DB, userId)
}

async function destroyPresentedSessions(c: Context<AppBindings>): Promise<void> {
  const tokens = new Set(
    sessionCookieNames(c.req.url)
      .map((name) => getCookie(c, name))
      .filter((token): token is string => Boolean(token)),
  )
  await Promise.all([...tokens].map((token) => destroySession(c.env.DB, token)))
}

authRoutes.get('/session', async (c) => {
  const user = c.get('user')
  if (user) return c.json(await sessionInfo(c.env, user))
  const body: SessionInfo = { user: null, site: await buildSiteInfo(c.env), settings: null }
  return c.json(body)
})


type RegistrationDecision =
  | { ok: true; role: 'owner' | 'member' }
  | { ok: false; reason: 'registration_closed' }

export function decideRegistration(input: {
  userCount: number
  registrationOpen: boolean
}): RegistrationDecision {
  if (input.userCount === 0) return { ok: true, role: 'owner' }
  if (input.registrationOpen) return { ok: true, role: 'member' }
  return { ok: false, reason: 'registration_closed' }
}

async function gate(env: Env): Promise<RegistrationDecision> {
  const countRow = await env.DB.prepare(`SELECT 1 AS n FROM users LIMIT 1`).first<{ n: number }>()
  return decideRegistration({
    userCount: countRow?.n ?? 0,
    registrationOpen: await getAllowRegistration(env.DB),
  })
}


authRoutes.post('/register', async (c) => {
  const body = await readJson<{ username?: string; password?: string; locale?: string }>(c, 4096)
  const locale = normalizeLocale(body.locale ?? c.req.header('Accept-Language'))
  const rawUsername = typeof body.username === 'string' ? body.username.slice(0, 128) : ''
  const username = normalizeUsername(rawUsername)
  if (!USERNAME_PATTERN.test(username)) {
    throw new ApiError(400, 'invalid_username', 'Username must contain 3-32 lowercase letters, numbers, underscores, or hyphens')
  }
  const weak = validateNewPassword(body.password)
  if (weak) throw new ApiError(400, 'weak_password', weak)

  if (!(await gate(c.env)).ok) {
    throw new ApiError(403, 'registration_closed', 'Registration is closed on this instance')
  }

  await enforceAttemptBudget(c.env.DB, [
    {
      key: `register-work:${requestClientIp(c)}`,
      maxAttempts: 12,
      windowMs: 10 * 60 * 1000,
    },
  ])

  const db = c.env.DB
  const id = newId()
  const now = Date.now()
  const result = await db
    .prepare(
      `INSERT INTO users
         (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       SELECT ?1, ?2, ?3, ?2, ?2, '',
              CASE WHEN NOT EXISTS (SELECT 1 FROM users) THEN 'owner' ELSE 'member' END,
              ?4, ?5, ?5
        WHERE NOT EXISTS (SELECT 1 FROM users)
           OR COALESCE((SELECT value FROM app_meta WHERE key = 'setting:allow_registration'), '0') = '1'
       ON CONFLICT(username) DO NOTHING`,
    )
    .bind(id, username, await hashPassword(body.password!), JSON.stringify(settingsFor(locale)), now)
    .run()

  if (!result.meta.changes) {
    const taken = await db.prepare(`SELECT id FROM users WHERE username = ?1`).bind(username).first()
    if (taken) throw new ApiError(409, 'username_taken', "That username is already in use")
    throw new ApiError(403, 'registration_closed', 'Registration is closed on this instance')
  }

  await seedWorkspace(c.env, id, locale).catch((err) => {
    console.warn('[inkstone] Failed to initialize sample content; the account remains usable:', err)
  })
  const token = await rotateSession(c, id)
  writeSessionCookie(c, token)
  const user = await loadUser(c.env, id)
  if (!user) throw new Error('created_user_missing')
  return c.json(await sessionInfo(c.env, user), 201)
})

authRoutes.post('/login', async (c) => {
  const body = await readJson<{ username?: string; password?: string }>(c, 4096)
  const rawUsername = typeof body.username === 'string' ? body.username.slice(0, 128) : ''
  const username = normalizeUsername(rawUsername)
  const password = typeof body.password === 'string' ? body.password : ''
  const db = c.env.DB
  const throttleTargets = loginThrottleTargets(username, requestClientIp(c))
  const workTargets = loginWorkTargets(username, requestClientIp(c))

  try {
    await assertNotLocked(db, throttleTargets)
    await consumeAttemptBudget(db, workTargets)
  } catch (err) {
    if (err instanceof ThrottleError) {
      throw new ApiError(429, 'too_many_attempts', `Too many attempts. Try again in ${err.retryAfterSec} seconds`, {
        retryAfter: err.retryAfterSec,
      })
    }
    throw err
  }

  const row = USERNAME_PATTERN.test(username)
    ? await db
        .prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = ?1`)
        .bind(username)
        .first<Parameters<typeof rowToUser>[0] & { password_hash: string }>()
    : null

  let valid = false
  if (
    row?.password_hash &&
    password.length <= PASSWORD_MAX_LENGTH &&
    isPasswordHash(row.password_hash)
  ) {
    valid = await verifyPassword(password, row.password_hash)
  } else {
    await dummyVerify()
  }

  if (!valid || !row) {
    await recordLoginFailure(db, throttleTargets)
    throw new ApiError(401, 'invalid_credentials', "Incorrect username or password")
  }

  // A successful sign-in proves this identity and IP are legitimate:
  // clear every throttling key (identity, IP, and account level) so a
  // shared IP / NAT is never locked out by a full window of attempts.
  await clearLoginFailures(db, [
    ...throttleTargets.map((target) => target.key),
    ...workTargets.map((target) => target.key),
  ])

  if (await hasEnabledTotp(db, row.id)) {
    return c.json(await createTotpLoginChallenge(db, row.id, row.password_hash))
  }

  const token = await rotateSession(c, row.id)
  writeSessionCookie(c, token)
  return c.json(await sessionInfo(c.env, rowToUser(row)))
})


authRoutes.put('/profile', requireAuth, async (c) => {
  const current = c.get('user')
  const body = await readJson<{ name?: unknown; avatarUrl?: unknown }>(
    c,
    JSON_BODY_LIMITS.profile,
  )
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name')
  const hasAvatar = Object.prototype.hasOwnProperty.call(body, 'avatarUrl')
  if (!hasName && !hasAvatar) {
    throw ApiError.badRequest('Provide a display name or avatar')
  }

  const name = hasName ? normalizeDisplayName(body.name) : current.name
  if (name === null) {
    throw new ApiError(
      400,
      'invalid_profile_name',
      `Display name must contain 1-${PROFILE_NAME_MAX_LENGTH} characters`,
    )
  }
  let avatarUrl = hasAvatar ? normalizeAvatarPreference(body.avatarUrl) : current.avatarUrl
  if (avatarUrl === null) {
    throw new ApiError(400, 'invalid_avatar', 'Choose a generated avatar or upload a supported image')
  }

  if (name === current.name && avatarUrl === current.avatarUrl) {
    return c.json(publicUser(current))
  }

  let storedAvatar: StoredAvatarObject | null = null
  if (hasAvatar && isBitmapAvatarDataUrl(avatarUrl)) {
    storedAvatar = await persistUploadedAvatar(c.env, current.id, avatarUrl)
    avatarUrl = storedAvatar.preference
  }

  const statements: D1PreparedStatement[] = []
  const previousAvatar = hasAvatar ? storedAvatarCleanup(current.avatarUrl) : null
  if (previousAvatar) {
    statements.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
         SELECT ?1, id, ?2 FROM users WHERE id = ?3 AND avatar_url = ?4`,
      ).bind(
        attachmentCleanupTarget(previousAvatar.storage, previousAvatar.key),
        Date.now(),
        current.id,
        current.avatarUrl,
      ),
    )
  }
  statements.push(
    c.env.DB.prepare(
      `UPDATE users SET
         name = CASE WHEN ?1 = 1 THEN ?2 ELSE name END,
         avatar_url = CASE WHEN ?3 = 1 THEN ?4 ELSE avatar_url END
       WHERE id = ?5 AND (?3 = 0 OR avatar_url = ?6)`,
    ).bind(
      hasName ? 1 : 0,
      name,
      hasAvatar ? 1 : 0,
      avatarUrl,
      current.id,
      current.avatarUrl,
    ),
  )

  let results: D1Result[]
  try {
    results = await c.env.DB.batch(statements)
  } catch (error) {
    if (storedAvatar) await discardStoredAvatar(c.env, storedAvatar)
    throw error
  }
  const updated = results.at(-1)
  if (!updated?.meta.changes) {
    if (storedAvatar) await discardStoredAvatar(c.env, storedAvatar)
    throw ApiError.conflict('The profile changed elsewhere. Refresh and try again')
  }

  if (previousAvatar) {
    await drainAttachmentCleanup(c.env, current.id).catch((error) => {
      console.warn('[inkstone] Replaced avatar cleanup will retry later:', error)
    })
  }

  await commitChange(c, 'profile', current.id, 'upsert')
  const user = await loadUser(c.env, current.id)
  if (!user) throw ApiError.unauthenticated()
  return c.json(publicUser(user))
})


authRoutes.post('/password', async (c) => {
  const user = c.get('user')
  if (!user) throw ApiError.unauthenticated()
  const body = await readJson<{ currentPassword?: string; newPassword?: string }>(c, 4096)
  const weak = validateNewPassword(body.newPassword)
  if (weak) throw new ApiError(400, 'weak_password', weak)

  const db = c.env.DB
  const expectedHash = await requireCurrentPassword(db, user.id, body.currentPassword)
  const newHash = await hashPassword(body.newPassword!)
  const [update] = await db.batch([
    db.prepare(`UPDATE users SET password_hash = ?1 WHERE id = ?2 AND password_hash = ?3`)
      .bind(newHash, user.id, expectedHash),
    db.prepare(
      `DELETE FROM totp_login_challenges
        WHERE user_id = ?1
          AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND password_hash = ?2)`,
    ).bind(user.id, newHash),
  ])

  if (!update.meta.changes) {
    throw new ApiError(409, 'conflict', 'Account credentials changed elsewhere. Refresh and try again')
  }

  await destroyOtherSessions(db, user.id, c.get('sessionId'))
  const token = await rotateSession(c, user.id)
  writeSessionCookie(c, token)
  return c.json({ ok: true })
})

authRoutes.post('/logout', async (c) => {
  await destroyPresentedSessions(c)
  clearSessionCookie(c)
  return c.json({ ok: true })
})

async function enforceAttemptBudget(
  db: D1Database,
  targets: Parameters<typeof consumeAttemptBudget>[1],
): Promise<void> {
  try {
    await consumeAttemptBudget(db, targets)
  } catch (err) {
    if (err instanceof ThrottleError) {
      throw new ApiError(429, 'too_many_attempts', `Too many attempts. Try again in ${err.retryAfterSec} seconds`, {
        retryAfter: err.retryAfterSec,
      })
    }
    throw err
  }
}

function normalizeLocale(value: unknown): AppLocale {
  return typeof value === 'string' && value.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
}

export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (
    !normalized ||
    [...normalized].length > PROFILE_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    return null
  }
  return normalized
}

function settingsFor(locale: AppLocale): UserSettings {
  return {
    ...DEFAULT_SETTINGS,
    appearance: { ...DEFAULT_SETTINGS.appearance, language: locale },
    editor: { ...DEFAULT_SETTINGS.editor },
    preview: { ...DEFAULT_SETTINGS.preview },
    backup: { ...DEFAULT_SETTINGS.backup },
    sync: { ...DEFAULT_SETTINGS.sync },
  }
}
