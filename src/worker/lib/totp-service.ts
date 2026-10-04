import { SESSION_TTL_MS } from '@shared/constants'
import type {
  TotpLoginChallenge,
  TotpRecoveryCodesResult,
  TotpSetupInfo,
  TotpStatus,
} from '@shared/types'
import type { Env } from '../env'
import { decryptTotpSecret, encryptTotpSecret } from './crypto'
import { timingSafeEqual } from './encoding'
import { ApiError } from './errors'
import { newId } from './id'
import { hashToken, newSessionToken } from './session-store'
import {
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
  ThrottleError,
} from './throttle'
import {
  buildTotpUri,
  generateOpaqueToken,
  generateRecoveryCodes,
  generateTotpSecret,
  hashOpaqueToken,
  hashRecoveryCode,
  isOpaqueToken,
  matchTotpCode,
  normalizeRecoveryCode,
  TOTP_LOGIN_TTL_MS,
  TOTP_SETUP_TTL_MS,
} from './totp'

interface TotpCredentialRow {
  secret_ciphertext: string
  enabled_at: number | null
  pending_token_hash: string | null
  pending_session_id: string | null
  pending_expires_at: number | null
  recovery_generation: string
  last_used_step: number | null
}

interface TotpLoginRow {
  user_id: string
  expires_at: number
  secret_ciphertext: string
  recovery_generation: string
  last_used_step: number | null
}

export interface CompletedTotpLogin {
  userId: string
  sessionToken: string
  recoveryCodeUsed: boolean
  recoveryCodesRemaining: number | null
}

export async function hasEnabledTotp(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS present FROM totp_credentials
      WHERE user_id = ?1 AND enabled_at IS NOT NULL`,
  ).bind(userId).first<{ present: number }>()
  return Boolean(row?.present)
}

export async function createTotpLoginChallenge(
  db: D1Database,
  userId: string,
  expectedPasswordHash: string,
  now = Date.now(),
): Promise<TotpLoginChallenge> {
  const challengeToken = generateOpaqueToken()
  const challengeHash = await hashOpaqueToken(challengeToken)
  const expiresAt = now + TOTP_LOGIN_TTL_MS
  const result = await db.prepare(
    `INSERT INTO totp_login_challenges (id, user_id, expires_at, created_at)
     SELECT ?1, ?2, ?3, ?4
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2 AND password_hash = ?5)`,
  ).bind(challengeHash, userId, expiresAt, now, expectedPasswordHash).run()
  if (!result.meta.changes) {
    throw ApiError.unauthenticated('Account credentials changed. Sign in again')
  }
  return { twoFactorRequired: true, challengeToken, expiresAt }
}

export async function getTotpStatus(env: Env, userId: string): Promise<TotpStatus> {
  const row = await env.DB.prepare(
    `SELECT c.enabled_at, COUNT(r.code_hash) AS recovery_codes
       FROM totp_credentials c
       LEFT JOIN totp_recovery_codes r
         ON r.user_id = c.user_id
        AND r.generation = c.recovery_generation
        AND r.used_at IS NULL
      WHERE c.user_id = ?1
      GROUP BY c.user_id, c.enabled_at`,
  ).bind(userId).first<{ enabled_at: number | null; recovery_codes: number }>()
  return {
    available: Boolean(env.CREDENTIAL_VAULT),
    enabled: row?.enabled_at != null,
    enabledAt: row?.enabled_at ?? null,
    recoveryCodesRemaining: row?.enabled_at == null ? 0 : Number(row.recovery_codes || 0),
  }
}

export async function startTotpSetup(input: {
  env: Env
  userId: string
  sessionId: string
  issuer: string
  account: string
  now?: number
}): Promise<TotpSetupInfo> {
  const now = input.now ?? Date.now()
  const secret = generateTotpSecret()
  const secretCiphertext = await encryptTotpSecret(input.env, input.userId, secret)
  const setupToken = generateOpaqueToken()
  const setupTokenHash = await hashOpaqueToken(setupToken)
  const expiresAt = now + TOTP_SETUP_TTL_MS
  const results = await input.env.DB.batch([
    input.env.DB.prepare(
      `INSERT INTO totp_credentials (
         user_id, secret_ciphertext, enabled_at,
         pending_token_hash, pending_session_id, pending_expires_at,
         recovery_generation, last_used_step, last_used_by, created_at, updated_at
       ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, '', NULL, NULL, ?6, ?6)
       ON CONFLICT(user_id) DO UPDATE SET
         secret_ciphertext = excluded.secret_ciphertext,
         pending_token_hash = excluded.pending_token_hash,
         pending_session_id = excluded.pending_session_id,
         pending_expires_at = excluded.pending_expires_at,
         recovery_generation = '',
         last_used_step = NULL,
         last_used_by = NULL,
         updated_at = excluded.updated_at
       WHERE totp_credentials.enabled_at IS NULL`,
    ).bind(
      input.userId,
      secretCiphertext,
      setupTokenHash,
      input.sessionId,
      expiresAt,
      now,
    ),
    input.env.DB.prepare(
      `DELETE FROM totp_recovery_codes
        WHERE user_id = ?1
          AND NOT EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND enabled_at IS NOT NULL
          )`,
    ).bind(input.userId),
  ])
  if (!changed(results[0])) {
    throw new ApiError(409, 'two_factor_already_enabled', 'Two-step verification is already enabled')
  }
  return {
    setupToken,
    secret,
    uri: buildTotpUri({ secret, issuer: input.issuer, account: input.account }),
    expiresAt,
  }
}

export async function cancelTotpSetup(input: {
  db: D1Database
  userId: string
  sessionId: string
  setupToken: unknown
}): Promise<void> {
  if (!isOpaqueToken(input.setupToken)) return
  const setupTokenHash = await hashOpaqueToken(input.setupToken)
  await input.db.prepare(
    `DELETE FROM totp_credentials
      WHERE user_id = ?1
        AND enabled_at IS NULL
        AND pending_token_hash = ?2
        AND pending_session_id = ?3`,
  ).bind(input.userId, setupTokenHash, input.sessionId).run()
}

export async function confirmTotpSetup(input: {
  env: Env
  userId: string
  sessionId: string
  setupToken: unknown
  code: unknown
  now?: number
}): Promise<TotpRecoveryCodesResult & { enabledAt: number }> {
  const now = input.now ?? Date.now()
  const throttle = factorThrottle(input.userId, 'setup')
  await beginFactorAttempt(input.env.DB, throttle)
  if (!isOpaqueToken(input.setupToken)) {
    await rejectFactor(input.env.DB, throttle, 'setup')
  }
  const setupTokenHash = await hashOpaqueToken(input.setupToken as string)
  const credential = await loadCredential(input.env.DB, input.userId)
  if (
    !credential ||
    credential.enabled_at != null ||
    !credential.pending_token_hash ||
    !credential.pending_session_id ||
    !credential.pending_expires_at ||
    credential.pending_expires_at <= now ||
    credential.pending_session_id !== input.sessionId ||
    !timingSafeEqual(credential.pending_token_hash, setupTokenHash)
  ) {
    await rejectFactor(input.env.DB, throttle, 'setup')
  }

  const secret = await decryptTotpSecret(input.env, input.userId, credential!.secret_ciphertext)
  if (!secret) throw setupExpired()
  const step = await matchTotpCode(secret, input.code, now)
  if (step == null) await rejectFactor(input.env.DB, throttle, 'code')

  const recoveryCodes = generateRecoveryCodes()
  const recoveryGeneration = newId()
  const hashes = await Promise.all(
    recoveryCodes.map((code) => hashRecoveryCode(input.userId, normalizeRecoveryCode(code)!)),
  )
  const statements: D1PreparedStatement[] = [
    input.env.DB.prepare(
      `UPDATE totp_credentials SET
         enabled_at = ?1,
         pending_token_hash = NULL,
         pending_session_id = NULL,
         pending_expires_at = NULL,
         recovery_generation = ?2,
         last_used_step = NULL,
         last_used_by = NULL,
         updated_at = ?1
       WHERE user_id = ?3
         AND enabled_at IS NULL
         AND pending_token_hash = ?4
         AND pending_session_id = ?5
         AND pending_expires_at > ?1`,
    ).bind(now, recoveryGeneration, input.userId, setupTokenHash, input.sessionId),
    input.env.DB.prepare(
      `DELETE FROM sessions
        WHERE user_id = ?1 AND id != ?2
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?3 AND enabled_at = ?4
          )`,
    ).bind(input.userId, input.sessionId, recoveryGeneration, now),
    input.env.DB.prepare(
      `DELETE FROM totp_recovery_codes
        WHERE user_id = ?1
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?2 AND enabled_at = ?3
          )`,
    ).bind(input.userId, recoveryGeneration, now),
  ]
  for (const hash of hashes) {
    statements.push(
      input.env.DB.prepare(
        `INSERT INTO totp_recovery_codes
           (user_id, code_hash, generation, created_at, used_at, used_by)
         SELECT ?1, ?2, ?3, ?4, NULL, NULL
          WHERE EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?3 AND enabled_at = ?4
          )`,
      ).bind(input.userId, hash, recoveryGeneration, now),
    )
  }
  const results = await input.env.DB.batch(statements)
  if (!changed(results[0])) throw setupExpired()
  await clearFactorAttempts(input.env.DB, throttle)
  return {
    recoveryCodes,
    recoveryCodesRemaining: recoveryCodes.length,
    generatedAt: now,
    enabledAt: now,
  }
}

export async function regenerateRecoveryCodes(input: {
  env: Env
  userId: string
  code: unknown
  now?: number
}): Promise<TotpRecoveryCodesResult> {
  const now = input.now ?? Date.now()
  const throttle = factorThrottle(input.userId, 'recovery')
  await beginFactorAttempt(input.env.DB, throttle)
  const credential = await requireEnabledCredential(input.env, input.userId)
  const secret = await decryptTotpSecret(input.env, input.userId, credential.secret_ciphertext)
  if (!secret) throw factorUnavailable()
  const step = await matchTotpCode(secret, input.code, now)
  if (step == null) await rejectFactor(input.env.DB, throttle, 'code')

  const recoveryCodes = generateRecoveryCodes()
  const recoveryGeneration = newId()
  const operationId = newId()
  const hashes = await Promise.all(
    recoveryCodes.map((code) => hashRecoveryCode(input.userId, normalizeRecoveryCode(code)!)),
  )
  const statements: D1PreparedStatement[] = [
    input.env.DB.prepare(
      `UPDATE totp_credentials SET
         recovery_generation = ?1,
         last_used_step = ?2,
         last_used_by = ?3,
         updated_at = ?4
       WHERE user_id = ?5
         AND enabled_at IS NOT NULL
         AND recovery_generation = ?6
         AND (last_used_step IS NULL OR last_used_step < ?2)`,
    ).bind(
      recoveryGeneration,
      step,
      operationId,
      now,
      input.userId,
      credential.recovery_generation,
    ),
    input.env.DB.prepare(
      `DELETE FROM totp_recovery_codes
        WHERE user_id = ?1
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1
               AND recovery_generation = ?2
               AND last_used_by = ?3
          )`,
    ).bind(input.userId, recoveryGeneration, operationId),
  ]
  for (const hash of hashes) {
    statements.push(
      input.env.DB.prepare(
        `INSERT INTO totp_recovery_codes
           (user_id, code_hash, generation, created_at, used_at, used_by)
         SELECT ?1, ?2, ?3, ?4, NULL, NULL
          WHERE EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1
               AND recovery_generation = ?3
               AND last_used_by = ?5
          )`,
      ).bind(input.userId, hash, recoveryGeneration, now, operationId),
    )
  }
  const results = await input.env.DB.batch(statements)
  if (!changed(results[0])) await rejectFactor(input.env.DB, throttle, 'code')
  await clearFactorAttempts(input.env.DB, throttle)
  return {
    recoveryCodes,
    recoveryCodesRemaining: recoveryCodes.length,
    generatedAt: now,
  }
}

export async function disableTotp(input: {
  env: Env
  userId: string
  sessionId: string
  code: unknown
  now?: number
}): Promise<void> {
  const now = input.now ?? Date.now()
  const throttle = factorThrottle(input.userId, 'disable')
  await beginFactorAttempt(input.env.DB, throttle)
  const credential = await requireEnabledCredential(input.env, input.userId)
  const recoveryCode = normalizeRecoveryCode(input.code)
  const operationId = newId()
  let statements: D1PreparedStatement[]

  if (recoveryCode) {
    const codeHash = await hashRecoveryCode(input.userId, recoveryCode)
    statements = [
      input.env.DB.prepare(
        `UPDATE totp_recovery_codes SET used_at = ?1, used_by = ?2
          WHERE user_id = ?3
            AND code_hash = ?4
            AND generation = ?5
            AND used_at IS NULL`,
      ).bind(now, operationId, input.userId, codeHash, credential.recovery_generation),
      input.env.DB.prepare(
        `UPDATE totp_credentials SET recovery_generation = ?1, updated_at = ?2
          WHERE user_id = ?3
            AND enabled_at IS NOT NULL
            AND recovery_generation = ?4
            AND EXISTS (
              SELECT 1 FROM totp_recovery_codes
               WHERE user_id = ?3 AND code_hash = ?5 AND used_by = ?1
            )`,
      ).bind(operationId, now, input.userId, credential.recovery_generation, codeHash),
    ]
  } else {
    const secret = await decryptTotpSecret(input.env, input.userId, credential.secret_ciphertext)
    if (!secret) throw factorUnavailable()
    const step = await matchTotpCode(secret, input.code, now)
    if (step == null) await rejectFactor(input.env.DB, throttle, 'code')
    statements = [
      input.env.DB.prepare(
        `UPDATE totp_credentials SET
           recovery_generation = ?1,
           last_used_step = ?2,
           last_used_by = ?1,
           updated_at = ?3
         WHERE user_id = ?4
           AND enabled_at IS NOT NULL
           AND recovery_generation = ?5
           AND (last_used_step IS NULL OR last_used_step < ?2)`,
      ).bind(operationId, step, now, input.userId, credential.recovery_generation),
    ]
  }

  statements.push(
    input.env.DB.prepare(
      `DELETE FROM sessions
        WHERE user_id = ?1 AND id != ?2
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?3
          )`,
    ).bind(input.userId, input.sessionId, operationId),
    input.env.DB.prepare(
      `DELETE FROM totp_login_challenges
        WHERE user_id = ?1
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?2
          )`,
    ).bind(input.userId, operationId),
    input.env.DB.prepare(
      `DELETE FROM totp_recovery_codes
        WHERE user_id = ?1
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?2
          )`,
    ).bind(input.userId, operationId),
    input.env.DB.prepare(
      `DELETE FROM totp_credentials
        WHERE user_id = ?1 AND recovery_generation = ?2`,
    ).bind(input.userId, operationId),
  )
  const results = await input.env.DB.batch(statements)
  const factorAccepted = recoveryCode
    ? changed(results[0]) && changed(results[1])
    : changed(results[0])
  if (!factorAccepted || !changed(results.at(-1))) {
    await rejectFactor(input.env.DB, throttle, 'code')
  }
  await clearFactorAttempts(input.env.DB, throttle)
}

export async function completeTotpLogin(input: {
  env: Env
  challengeToken: unknown
  code: unknown
  now?: number
}): Promise<CompletedTotpLogin> {
  const now = input.now ?? Date.now()
  if (!isOpaqueToken(input.challengeToken)) throw challengeExpired()
  const challengeHash = await hashOpaqueToken(input.challengeToken)
  const workKey = `totp-login-work:${challengeHash}`
  await consumeWorkBudget(input.env.DB, workKey)
  const row = await input.env.DB.prepare(
    `SELECT ch.user_id, ch.expires_at,
            c.secret_ciphertext, c.recovery_generation, c.last_used_step
       FROM totp_login_challenges ch
       JOIN totp_credentials c ON c.user_id = ch.user_id
      WHERE ch.id = ?1 AND c.enabled_at IS NOT NULL`,
  ).bind(challengeHash).first<TotpLoginRow>()
  if (!row || row.expires_at <= now) {
    await input.env.DB.prepare(`DELETE FROM totp_login_challenges WHERE id = ?1`)
      .bind(challengeHash).run()
    throw challengeExpired()
  }

  const throttle = factorThrottle(row.user_id, challengeHash)
  await assertFactorUnlocked(input.env.DB, throttle)
  const recoveryCode = normalizeRecoveryCode(input.code)
  const operationId = newId()
  const sessionToken = newSessionToken()
  const sessionHash = await hashToken(sessionToken)
  const expiresAt = now + SESSION_TTL_MS
  let results: D1Result[]
  let recoveryCodeUsed = false

  if (recoveryCode) {
    const codeHash = await hashRecoveryCode(row.user_id, recoveryCode)
    results = await input.env.DB.batch([
      input.env.DB.prepare(
        `UPDATE totp_recovery_codes SET used_at = ?1, used_by = ?2
          WHERE user_id = ?3
            AND code_hash = ?4
            AND generation = ?5
            AND used_at IS NULL
            AND EXISTS (
              SELECT 1 FROM totp_login_challenges
               WHERE id = ?6 AND user_id = ?3 AND expires_at > ?1 AND claimed_by IS NULL
            )`,
      ).bind(now, operationId, row.user_id, codeHash, row.recovery_generation, challengeHash),
      input.env.DB.prepare(
        `UPDATE totp_login_challenges SET claimed_by = ?1
          WHERE id = ?2 AND user_id = ?3 AND expires_at > ?4 AND claimed_by IS NULL
            AND EXISTS (
              SELECT 1 FROM totp_recovery_codes
               WHERE user_id = ?3 AND code_hash = ?5 AND used_by = ?1
            )`,
      ).bind(operationId, challengeHash, row.user_id, now, codeHash),
      input.env.DB.prepare(
        `INSERT INTO sessions (id, user_id, expires_at, created_at)
         SELECT ?1, ?2, ?3, ?4
          WHERE EXISTS (
            SELECT 1 FROM totp_recovery_codes
             WHERE user_id = ?2 AND code_hash = ?5 AND used_by = ?6
          )
            AND EXISTS (
              SELECT 1 FROM totp_login_challenges WHERE id = ?7 AND claimed_by = ?6
            )`,
      ).bind(sessionHash, row.user_id, expiresAt, now, codeHash, operationId, challengeHash),
      input.env.DB.prepare(
        `DELETE FROM totp_login_challenges WHERE id = ?1 AND claimed_by = ?2`,
      ).bind(challengeHash, operationId),
    ])
    recoveryCodeUsed = true
  } else {
    const secret = await decryptTotpSecret(input.env, row.user_id, row.secret_ciphertext)
    if (!secret) throw factorUnavailable()
    const step = await matchTotpCode(secret, input.code, now)
    if (step == null) await rejectFactor(input.env.DB, throttle, 'code', workKey)
    results = await input.env.DB.batch([
      input.env.DB.prepare(
        `UPDATE totp_credentials SET
           last_used_step = ?1,
           last_used_by = ?2,
           updated_at = ?3
         WHERE user_id = ?4
           AND enabled_at IS NOT NULL
           AND recovery_generation = ?5
           AND (last_used_step IS NULL OR last_used_step < ?1)
           AND EXISTS (
             SELECT 1 FROM totp_login_challenges
              WHERE id = ?6 AND user_id = ?4 AND expires_at > ?3 AND claimed_by IS NULL
           )`,
      ).bind(step, operationId, now, row.user_id, row.recovery_generation, challengeHash),
      input.env.DB.prepare(
        `UPDATE totp_login_challenges SET claimed_by = ?1
          WHERE id = ?2 AND user_id = ?3 AND expires_at > ?4 AND claimed_by IS NULL
            AND EXISTS (
              SELECT 1 FROM totp_credentials
               WHERE user_id = ?3 AND last_used_by = ?1
            )`,
      ).bind(operationId, challengeHash, row.user_id, now),
      input.env.DB.prepare(
        `INSERT INTO sessions (id, user_id, expires_at, created_at)
         SELECT ?1, ?2, ?3, ?4
          WHERE EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?2 AND last_used_by = ?5
          )
            AND EXISTS (
              SELECT 1 FROM totp_login_challenges WHERE id = ?6 AND claimed_by = ?5
            )`,
      ).bind(sessionHash, row.user_id, expiresAt, now, operationId, challengeHash),
      input.env.DB.prepare(
        `DELETE FROM totp_login_challenges WHERE id = ?1 AND claimed_by = ?2`,
      ).bind(challengeHash, operationId),
    ])
  }

  if (
    !changed(results[0]) ||
    !changed(results[1]) ||
    !changed(results[2]) ||
    !changed(results[3])
  ) {
    await rejectFactor(input.env.DB, throttle, 'code', workKey)
  }
  await clearFactorAttempts(input.env.DB, throttle, workKey)
  const remaining = recoveryCodeUsed
    ? await countRecoveryCodes(input.env.DB, row.user_id, row.recovery_generation)
    : null
  return {
    userId: row.user_id,
    sessionToken,
    recoveryCodeUsed,
    recoveryCodesRemaining: remaining,
  }
}

async function loadCredential(db: D1Database, userId: string): Promise<TotpCredentialRow | null> {
  return db.prepare(
    `SELECT secret_ciphertext, enabled_at,
            pending_token_hash, pending_session_id, pending_expires_at,
            recovery_generation, last_used_step
       FROM totp_credentials WHERE user_id = ?1`,
  ).bind(userId).first<TotpCredentialRow>()
}

async function requireEnabledCredential(env: Env, userId: string): Promise<TotpCredentialRow> {
  const credential = await loadCredential(env.DB, userId)
  if (!credential || credential.enabled_at == null) {
    throw new ApiError(409, 'two_factor_not_enabled', 'Two-step verification is not enabled')
  }
  return credential
}

async function countRecoveryCodes(
  db: D1Database,
  userId: string,
  generation: string,
): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM totp_recovery_codes
      WHERE user_id = ?1 AND generation = ?2 AND used_at IS NULL`,
  ).bind(userId, generation).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

function factorThrottle(userId: string, action: string): { failureKeys: string[]; workKey: string } {
  return {
    failureKeys: [`totp:${userId}`, `totp:${userId}:${action}`],
    workKey: `totp-work:${userId}:${action}`,
  }
}

async function beginFactorAttempt(
  db: D1Database,
  throttle: { failureKeys: string[]; workKey: string },
): Promise<void> {
  await consumeWorkBudget(db, throttle.workKey)
  await assertFactorUnlocked(db, throttle)
}

async function consumeWorkBudget(db: D1Database, workKey: string): Promise<void> {
  try {
    await consumeAttemptBudget(db, [{ key: workKey, maxAttempts: 8, windowMs: 10 * 60 * 1000 }])
  } catch (error) {
    if (error instanceof ThrottleError) throw tooManyAttempts(error)
    throw error
  }
}

async function assertFactorUnlocked(
  db: D1Database,
  throttle: { failureKeys: string[] },
): Promise<void> {
  try {
    await assertNotLocked(db, throttle.failureKeys)
  } catch (error) {
    if (error instanceof ThrottleError) throw tooManyAttempts(error)
    throw error
  }
}

async function rejectFactor(
  db: D1Database,
  throttle: { failureKeys: string[] },
  kind: 'code' | 'setup',
  workKey?: string,
): Promise<never> {
  await recordLoginFailure(db, throttle.failureKeys)
  if (workKey) {
    await assertFactorUnlocked(db, throttle)
  }
  if (kind === 'setup') throw setupExpired()
  throw new ApiError(401, 'invalid_two_factor_code', 'The verification code is incorrect or has already been used')
}

async function clearFactorAttempts(
  db: D1Database,
  throttle: { failureKeys: string[]; workKey?: string },
  extraWorkKey?: string,
): Promise<void> {
  const keys = [...throttle.failureKeys]
  if (throttle.workKey) keys.push(throttle.workKey)
  if (extraWorkKey) keys.push(extraWorkKey)
  await clearLoginFailures(db, keys)
}

function challengeExpired(): ApiError {
  return new ApiError(401, 'two_factor_challenge_expired', 'The sign-in verification expired. Enter your password again')
}

function setupExpired(): ApiError {
  return new ApiError(409, 'two_factor_setup_expired', 'The setup session expired. Start again')
}

function factorUnavailable(): ApiError {
  return new ApiError(
    503,
    'two_factor_unavailable',
    'The authenticator secret is unavailable. Use a recovery code to sign in or disable two-step verification',
  )
}

function tooManyAttempts(error: ThrottleError): ApiError {
  return new ApiError(
    429,
    'too_many_attempts',
    `Too many attempts. Try again in ${error.retryAfterSec} seconds`,
    { retryAfter: error.retryAfterSec },
  )
}

function changed(result: D1Result | undefined): boolean {
  return (result?.meta.changes ?? 0) > 0
}
