export interface CloudflareModel {
  id: string
  label: string
  supportsThinkingToggle: boolean
}

export const CLOUDFLARE_AI_MODELS: CloudflareModel[] = [
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', label: 'Qwen3 30B A3B', supportsThinkingToggle: true },
  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B', supportsThinkingToggle: true },
  { id: '@cf/openai/gpt-oss-20b', label: 'GPT-OSS 20B', supportsThinkingToggle: true },
  { id: '@cf/openai/gpt-oss-120b', label: 'GPT-OSS 120B', supportsThinkingToggle: true },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B', supportsThinkingToggle: true },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B', supportsThinkingToggle: true },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1 24B', supportsThinkingToggle: false },
]

export const DEFAULT_CLOUDFLARE_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8'

export function isAllowedCloudflareModel(id: unknown): id is string {
  return CLOUDFLARE_AI_MODELS.some((model) => model.id === id)
}

export function supportsThinkingToggle(id: string): boolean {
  return CLOUDFLARE_AI_MODELS.some((model) => model.id === id && model.supportsThinkingToggle)
}
