import { getMeta, setMeta } from '../db/metadata'


const KEY_REGISTRATION_OPEN = 'setting:allow_registration'
const KEY_AI_BASE_URL = 'ai:base_url'
const KEY_AI_MODEL = 'ai:model'
const KEY_AI_KEY_CIPHER = 'ai:key_cipher'

export async function getAllowRegistration(db: D1Database): Promise<boolean> {
  return (await getMeta(db, KEY_REGISTRATION_OPEN)) === '1'
}

export async function setAllowRegistration(db: D1Database, enabled: boolean): Promise<void> {
  await setMeta(db, KEY_REGISTRATION_OPEN, enabled ? '1' : '0')
}

export interface AiConfigRecord {
  baseUrl: string
  model: string
  hasKey: boolean
}

export async function getAiConfig(db: D1Database): Promise<AiConfigRecord> {
  const [baseUrl, model, keyCipher] = await Promise.all([
    getMeta(db, KEY_AI_BASE_URL),
    getMeta(db, KEY_AI_MODEL),
    getMeta(db, KEY_AI_KEY_CIPHER),
  ])
  return {
    baseUrl: baseUrl ?? '',
    model: model ?? '',
    hasKey: Boolean(keyCipher),
  }
}

export async function setAiConfig(
  db: D1Database,
  patch: { baseUrl?: string; model?: string },
): Promise<void> {
  if (patch.baseUrl !== undefined) await setMeta(db, KEY_AI_BASE_URL, patch.baseUrl)
  if (patch.model !== undefined) await setMeta(db, KEY_AI_MODEL, patch.model)
}

export async function getAiKeyCipher(db: D1Database): Promise<string | null> {
  return getMeta(db, KEY_AI_KEY_CIPHER)
}

export async function setAiKeyCipher(db: D1Database, cipher: string): Promise<void> {
  await setMeta(db, KEY_AI_KEY_CIPHER, cipher)
}

export async function clearAiKeyCipher(db: D1Database): Promise<void> {
  await setMeta(db, KEY_AI_KEY_CIPHER, '')
}