import { DEFAULT_CLOUDFLARE_MODEL, isAllowedCloudflareModel } from '@shared/ai-models'

export type AiProvider = 'ollama' | 'cloudflare'

export interface AiConfig {
  provider: AiProvider
  baseUrl: string
  model: string
  cloudflareModel: string
  maxTokens: number
  chunkChars: number
  extraInstruction: string
  strictConvert: boolean
}

export const AI_CONFIG_STORAGE_KEY = 'inkstone_ai_config_v1'

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'gemma4:12b-it-qat',
  cloudflareModel: DEFAULT_CLOUDFLARE_MODEL,
  maxTokens: 8192,
  chunkChars: 6000,
  extraInstruction: '',
  strictConvert: true,
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function mergeAiConfig(stored: unknown): AiConfig {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_AI_CONFIG }
  const raw = stored as Record<string, unknown>
  return {
    provider: raw.provider === 'cloudflare' ? 'cloudflare' : 'ollama',
    baseUrl: readString(raw.baseUrl, DEFAULT_AI_CONFIG.baseUrl),
    model: readString(raw.model, DEFAULT_AI_CONFIG.model),
    cloudflareModel: isAllowedCloudflareModel(raw.cloudflareModel)
      ? raw.cloudflareModel
      : DEFAULT_AI_CONFIG.cloudflareModel,
    maxTokens: readNumber(raw.maxTokens, DEFAULT_AI_CONFIG.maxTokens),
    chunkChars: readNumber(raw.chunkChars, DEFAULT_AI_CONFIG.chunkChars),
    extraInstruction: readString(raw.extraInstruction, DEFAULT_AI_CONFIG.extraInstruction),
    strictConvert: readBoolean(raw.strictConvert, DEFAULT_AI_CONFIG.strictConvert),
  }
}

export function getAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(AI_CONFIG_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_AI_CONFIG }
    return mergeAiConfig(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_AI_CONFIG }
  }
}

export function setAiConfig(patch: Partial<AiConfig>): AiConfig {
  const next = mergeAiConfig({ ...getAiConfig(), ...patch })
  try {
    localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify(next))
  } catch {
    return next
  }
  return next
}

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed || DEFAULT_AI_CONFIG.baseUrl
}
