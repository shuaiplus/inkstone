import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from '../lib/encoding'


const MASTER_KEY_NAME = 'backup-master-key-v1'
const MASTER_KEY_BYTES = 32
const MAX_REQUEST_BYTES = 24 * 1024
const MAX_CIPHERTEXT_LENGTH = 24 * 1024
const BACKUP_SCOPE_PATTERN = /^backup:[0-9a-hjkmnp-tv-z]{26}$/
const AI_SCOPE_PATTERN = /^ai:instance$/
const CIPHERTEXT_PATTERN = /^v1\.([A-Za-z0-9_-]+)$/
const HKDF_SALT = utf8('inkstone.backup-credentials.v1')
const ALLOWED_SECRET_FIELDS = new Set(['password', 'accessKeyId', 'secretAccessKey', 'apiKey'])

type CredentialRecord = Record<string, string>

export class CredentialVault implements DurableObject {
  private masterKeyPromise: Promise<CryptoKey> | null = null

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return jsonError(404, 'not_found')

    const body = await readBody(request)
    if (!body) return jsonError(400, 'invalid_request')

    if (new URL(request.url).pathname === '/encrypt') {
      if (!isScope(body.scope) || !isCredentialRecord(body.value)) {
        return jsonError(400, 'invalid_request')
      }
      const plaintext = utf8(JSON.stringify(body.value))
      if (plaintext.byteLength > MAX_REQUEST_BYTES) return jsonError(413, 'payload_too_large')
      const ciphertext = await this.encrypt(body.scope, plaintext)
      return Response.json({ ciphertext })
    }

    if (new URL(request.url).pathname === '/decrypt') {
      if (
        !isScope(body.scope) ||
        typeof body.ciphertext !== 'string' ||
        body.ciphertext.length > MAX_CIPHERTEXT_LENGTH
      ) {
        return jsonError(400, 'invalid_request')
      }
      const value = await this.decrypt(body.scope, body.ciphertext)
      return value ? Response.json({ value }) : jsonError(422, 'invalid_ciphertext')
    }

    return jsonError(404, 'not_found')
  }

  private async encrypt(scope: string, plaintext: Uint8Array): Promise<string> {
    const key = await this.targetKey(scope)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        additionalData: associatedData(scope) as BufferSource,
      },
      key,
      plaintext as BufferSource,
    )
    const packed = new Uint8Array(iv.byteLength + encrypted.byteLength)
    packed.set(iv)
    packed.set(new Uint8Array(encrypted), iv.byteLength)
    return `v1.${toBase64Url(packed)}`
  }

  private async decrypt(scope: string, ciphertext: string): Promise<CredentialRecord | null> {
    const match = CIPHERTEXT_PATTERN.exec(ciphertext)
    if (!match) return null
    try {
      const packed = fromBase64Url(match[1]!)
      if (packed.byteLength <= 12) return null
      const key = await this.targetKey(scope)
      const decrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: packed.subarray(0, 12) as BufferSource,
          additionalData: associatedData(scope) as BufferSource,
        },
        key,
        packed.subarray(12) as BufferSource,
      )
      const value: unknown = JSON.parse(fromUtf8(decrypted))
      return isCredentialRecord(value) ? value : null
    } catch {
      return null
    }
  }

  private async targetKey(scope: string): Promise<CryptoKey> {
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: HKDF_SALT as BufferSource,
        info: utf8(scope) as BufferSource,
      },
      await this.masterKey(),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  }

  private masterKey(): Promise<CryptoKey> {
    if (!this.masterKeyPromise) {
      this.masterKeyPromise = this.state.blockConcurrencyWhile(async () => {
        let encoded = await this.state.storage.get<string>(MASTER_KEY_NAME)
        if (encoded === undefined) {
          encoded = toBase64Url(crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES)))
          await this.state.storage.put(MASTER_KEY_NAME, encoded)
        }

        let raw: Uint8Array
        try {
          raw = fromBase64Url(encoded)
        } catch {
          throw new Error('credential_vault_master_key_corrupt')
        }
        if (raw.byteLength !== MASTER_KEY_BYTES) {
          throw new Error('credential_vault_master_key_corrupt')
        }
        return crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey'])
      })
    }
    return this.masterKeyPromise
  }
}

function associatedData(scope: string): Uint8Array {
  return utf8(`inkstone:credential-vault:v1:${scope}`)
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text()
    if (utf8(text).byteLength > MAX_REQUEST_BYTES) return null
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function isScope(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (BACKUP_SCOPE_PATTERN.test(value) || AI_SCOPE_PATTERN.test(value))
  )
}

function isCredentialRecord(value: unknown): value is CredentialRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  if (entries.length < 1 || entries.length > ALLOWED_SECRET_FIELDS.size) return false
  return entries.every(
    ([key, field]) =>
      ALLOWED_SECRET_FIELDS.has(key) &&
      typeof field === 'string' &&
      field.length > 0 &&
      field.length <= 4096,
  )
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status })
}