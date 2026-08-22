import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_AI_MODELS,
  DEFAULT_CLOUDFLARE_MODEL,
  isAllowedCloudflareModel,
  supportsThinkingToggle,
} from './ai-models'

const PAID_ONLY_MODELS = [
  '@cf/moonshotai/kimi-k2.6',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/zai-org/glm-5.2',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/deepseek-ai/deepseek-v4-pro-0813',
]

describe('Cloudflare model allow list', () => {
  it('is not empty and has no duplicates', () => {
    const ids = CLOUDFLARE_AI_MODELS.map((model) => model.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('only lists fully qualified Workers AI ids', () => {
    for (const model of CLOUDFLARE_AI_MODELS) {
      expect(model.id.startsWith('@cf/')).toBe(true)
      expect(model.label.length).toBeGreaterThan(0)
    }
  })

  it('has a default that is itself allowed', () => {
    expect(isAllowedCloudflareModel(DEFAULT_CLOUDFLARE_MODEL)).toBe(true)
  })

  it('excludes the models that require a paid plan', () => {
    for (const paid of PAID_ONLY_MODELS) {
      expect(isAllowedCloudflareModel(paid)).toBe(false)
    }
  })
})

describe('isAllowedCloudflareModel', () => {
  it('accepts an id that is on the list', () => {
    expect(isAllowedCloudflareModel('@cf/openai/gpt-oss-20b')).toBe(true)
  })

  it('rejects anything not on the list, so the route cannot proxy arbitrary models', () => {
    expect(isAllowedCloudflareModel('@cf/some/other-model')).toBe(false)
    expect(isAllowedCloudflareModel('gpt-4')).toBe(false)
    expect(isAllowedCloudflareModel('')).toBe(false)
  })

  it('rejects a prefix or suffix of an allowed id rather than matching loosely', () => {
    expect(isAllowedCloudflareModel('@cf/openai/gpt-oss')).toBe(false)
    expect(isAllowedCloudflareModel('@cf/openai/gpt-oss-20b-extra')).toBe(false)
  })

  it('rejects non-string input instead of throwing', () => {
    expect(isAllowedCloudflareModel(null)).toBe(false)
    expect(isAllowedCloudflareModel(undefined)).toBe(false)
    expect(isAllowedCloudflareModel(42)).toBe(false)
    expect(isAllowedCloudflareModel({ id: '@cf/openai/gpt-oss-20b' })).toBe(false)
  })
})

describe('supportsThinkingToggle', () => {
  it('is off for Mistral, whose tokenizer rejects chat_template_kwargs with a 400', () => {
    expect(supportsThinkingToggle('@cf/mistralai/mistral-small-3.1-24b-instruct')).toBe(false)
  })

  it('is on for the models measured to accept it', () => {
    expect(supportsThinkingToggle('@cf/qwen/qwen3-30b-a3b-fp8')).toBe(true)
    expect(supportsThinkingToggle('@cf/google/gemma-4-26b-a4b-it')).toBe(true)
    expect(supportsThinkingToggle('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(true)
  })

  it('is off for anything not on the list', () => {
    expect(supportsThinkingToggle('@cf/some/unknown-model')).toBe(false)
    expect(supportsThinkingToggle('')).toBe(false)
  })

  it('declares the flag on every listed model, so a new entry cannot silently default', () => {
    for (const model of CLOUDFLARE_AI_MODELS) {
      expect(typeof model.supportsThinkingToggle).toBe('boolean')
    }
  })
})
