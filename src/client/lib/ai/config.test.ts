import { beforeEach, describe, expect, it } from 'vitest'
import {
  AI_CONFIG_STORAGE_KEY,
  DEFAULT_AI_CONFIG,
  getAiConfig,
  mergeAiConfig,
  normalizeBaseUrl,
  setAiConfig,
} from './config'

describe('AI config persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns the defaults when nothing is stored', () => {
    expect(getAiConfig()).toEqual(DEFAULT_AI_CONFIG)
  })

  it('has a sensible default model', () => {
    expect(DEFAULT_AI_CONFIG.model).toBe('gemma4:12b-it-qat')
  })

  it('fills missing fields from the defaults instead of returning undefined', () => {
    localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify({ model: 'llama3' }))
    const config = getAiConfig()
    expect(config.model).toBe('llama3')
    expect(config.baseUrl).toBe(DEFAULT_AI_CONFIG.baseUrl)
    expect(config.chunkChars).toBe(DEFAULT_AI_CONFIG.chunkChars)
    expect(config.strictConvert).toBe(DEFAULT_AI_CONFIG.strictConvert)
  })

  it('falls back to the defaults on unparsable storage', () => {
    localStorage.setItem(AI_CONFIG_STORAGE_KEY, '{not json')
    expect(getAiConfig()).toEqual(DEFAULT_AI_CONFIG)
  })

  it('rejects values of the wrong type rather than trusting them', () => {
    expect(mergeAiConfig({ chunkChars: 'lots' }).chunkChars).toBe(DEFAULT_AI_CONFIG.chunkChars)
    expect(mergeAiConfig({ maxTokens: -1 }).maxTokens).toBe(DEFAULT_AI_CONFIG.maxTokens)
    expect(mergeAiConfig({ maxTokens: Number.NaN }).maxTokens).toBe(DEFAULT_AI_CONFIG.maxTokens)
    expect(mergeAiConfig({ strictConvert: 'yes' }).strictConvert).toBe(DEFAULT_AI_CONFIG.strictConvert)
    expect(mergeAiConfig({ model: 42 }).model).toBe(DEFAULT_AI_CONFIG.model)
    expect(mergeAiConfig({ baseUrl: { host: 'x' } }).baseUrl).toBe(DEFAULT_AI_CONFIG.baseUrl)
    expect(mergeAiConfig({ extraInstruction: ['a'] }).extraInstruction).toBe(DEFAULT_AI_CONFIG.extraInstruction)
    expect(mergeAiConfig(null).baseUrl).toBe(DEFAULT_AI_CONFIG.baseUrl)
  })

  it('keeps a chunkChars of 0, which means chunking is off', () => {
    expect(mergeAiConfig({ chunkChars: 0 }).chunkChars).toBe(0)
  })

  it('round-trips a saved patch', () => {
    setAiConfig({ model: 'qwen2.5:7b-instruct', chunkChars: 1500 })
    const config = getAiConfig()
    expect(config.model).toBe('qwen2.5:7b-instruct')
    expect(config.chunkChars).toBe(1500)
    expect(config.baseUrl).toBe(DEFAULT_AI_CONFIG.baseUrl)
  })

  it('merges successive patches instead of replacing the whole config', () => {
    setAiConfig({ model: 'a' })
    setAiConfig({ chunkChars: 42 })
    const config = getAiConfig()
    expect(config.model).toBe('a')
    expect(config.chunkChars).toBe(42)
  })
})

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and surrounding space', () => {
    expect(normalizeBaseUrl('  http://127.0.0.1:11434/v1//  ')).toBe('http://127.0.0.1:11434/v1')
  })

  it('falls back to the default when emptied', () => {
    expect(normalizeBaseUrl('   ')).toBe(DEFAULT_AI_CONFIG.baseUrl)
  })
})
