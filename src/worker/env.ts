
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export interface Env {

  DB: D1Database

  ASSETS: Fetcher

  FILES?: R2Bucket

  FILES_KV?: KVNamespace

  OAUTH_KV: KVNamespace

  OAUTH_PROVIDER?: OAuthHelpers

  SYNC_HUB?: DurableObjectNamespace

  CREDENTIAL_VAULT?: DurableObjectNamespace

  APP_NAME?: string

  PUBLIC_URL?: string

  /** Workers AI binding for semantic search; optional so AI search degrades gracefully. */
  AI?: {
    run: <T = unknown>(model: string, inputs: unknown) => Promise<T>
  }
}

export interface DatabaseState {
  ftsEnabled: boolean
}


export interface Variables {

  database: DatabaseState
  blogOwnerId?: string
  userId: string

  sessionId: string

  user: {
    id: string
    username: string
    login: string
    name: string
    avatarUrl: string
    role: 'owner' | 'member'
    createdAt: number
    settingsRaw: string
  }
}

export type AppBindings = { Bindings: Env; Variables: Variables }
