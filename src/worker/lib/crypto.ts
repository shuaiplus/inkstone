import type { Env } from '../env'
import { ApiError } from './errors'
import { isValidId } from './id'


const VAULT_NAME = 'primary'
const VAULT_ORIGIN = 'https://credential-vault.internal'

export class CryptoUnavailableError extends ApiError {
  constructor() {
    super(
      503,
      'server_misconfigured',
      'The server is missing the CREDENTIAL_VAULT Durable Object binding and cannot store backup credentials safely',
    )
    this.name = 'CryptoUnavailableError'
  }
}

export async function encryptSecret(env: Env, info: string, value: unknown): Promise<string> {
  if (!isValidId(info)) throw new Error('invalid_credential_scope')
  const response = await vaultRequest(env, '/encrypt', { scope: `backup:${info}`, value })
  if (!response.ok) throw new CryptoUnavailableError()
  const body: unknown = await response.json().catch(() => null)
  const ciphertext = readStringField(body, 'ciphertext')
  if (!ciphertext || ciphertext.length > 24 * 1024) throw new CryptoUnavailableError()
  return ciphertext
}

export async function decryptSecret<T>(env: Env, info: string, stored: string): Promise<T | null> {
  if (!isValidId(info) || stored.length > 24 * 1024) return null
  try {
    const response = await vaultRequest(env, '/decrypt', {
      scope: `backup:${info}`,
      ciphertext: stored,
    })
    if (response.status === 422) return null
    if (!response.ok) throw new CryptoUnavailableError()
    const body: unknown = await response.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('value' in body)) return null
    const value = (body as { value: unknown }).value
    return isCredentialRecord(value) ? (value as T) : null
  } catch (error) {
    if (error instanceof CryptoUnavailableError) throw error
    throw new CryptoUnavailableError()
  }
}

export async function encryptAiKey(env: Env, apiKey: string): Promise<string> {
  if (!apiKey) throw new Error('invalid_ai_key')
  const response = await vaultRequest(env, '/encrypt', { scope: 'ai:instance', value: { apiKey } })
  if (!response.ok) throw new CryptoUnavailableError()
  const body: unknown = await response.json().catch(() => null)
  const ciphertext = readStringField(body, 'ciphertext')
  if (!ciphertext || ciphertext.length > 24 * 1024) throw new CryptoUnavailableError()
  return ciphertext
}

export async function decryptAiKey(env: Env, stored: string): Promise<string | null> {
  if (stored.length > 24 * 1024) return null
  try {
    const response = await vaultRequest(env, '/decrypt', {
      scope: 'ai:instance',
      ciphertext: stored,
    })
    if (response.status === 422) return null
    if (!response.ok) throw new CryptoUnavailableError()
    const body: unknown = await response.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('value' in body)) return null
    const value = (body as { value: unknown }).value
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const apiKey = (value as Record<string, unknown>).apiKey
    return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : null
  } catch (error) {
    if (error instanceof CryptoUnavailableError) throw error
    throw new CryptoUnavailableError()
  }
}

async function vaultRequest(env: Env, path: '/encrypt' | '/decrypt', body: unknown): Promise<Response> {
  if (!env.CREDENTIAL_VAULT) throw new CryptoUnavailableError()
  try {
    const id = env.CREDENTIAL_VAULT.idFromName(VAULT_NAME)
    return await env.CREDENTIAL_VAULT.get(id).fetch(`${VAULT_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    if (error instanceof CryptoUnavailableError) throw error
    throw new CryptoUnavailableError()
  }
}

function readStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : null
}

function isCredentialRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = new Set(['password', 'accessKeyId', 'secretAccessKey'])
  const entries = Object.entries(value)
  return entries.length > 0 &&
    entries.length <= allowed.size &&
    entries.every(
      ([key, field]) =>
        allowed.has(key) && typeof field === 'string' && field.length > 0 && field.length <= 4096,
    )
}