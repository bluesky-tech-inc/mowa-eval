import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText, type LanguageModel } from 'ai'
import type { RunPrompt } from '../core/index'

// Resolves a `provider:model` id to a model instance, reading the provider's key
// from the environment. Bring-your-own-key: nothing is read from config or
// written to logs. Image/video generation is not wired yet — see the stub below.

// The built-in providers, their key env var, and an example model id. Shown in
// help and the no-key message so a user knows exactly what to set.
export const PROVIDERS = [
  { name: 'Google Gemini', env: 'GOOGLE_API_KEY', model: 'google:gemini-2.5-flash' },
  { name: 'OpenAI', env: 'OPENAI_API_KEY', model: 'openai:gpt-4o' },
  { name: 'Anthropic', env: 'ANTHROPIC_API_KEY', model: 'anthropic:claude-sonnet-4-5' },
] as const

export function hasAnyKey(): boolean {
  return PROVIDERS.some(p => process.env[p.env]) || Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY)
}

export interface ModelRef {
  provider: string
  model: string
}

export function parseModelId(id: string): ModelRef {
  const [provider, ...rest] = id.split(':')
  if (!provider || rest.length === 0) throw new Error(`Bad model id "${id}". Use provider:model, e.g. google:gemini-2.5-flash`)
  return { provider, model: rest.join(':') }
}

export function resolveModel(id: string): LanguageModel {
  const { provider, model } = parseModelId(id)
  switch (provider) {
    case 'google': {
      const key = process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY
      requireKey(key, 'GOOGLE_API_KEY')
      return createGoogleGenerativeAI({ apiKey: key })(model)
    }
    case 'openai':
      requireKey(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY')
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(model)
    case 'anthropic':
      requireKey(process.env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY')
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(model)
    default:
      throw new Error(`Unknown provider "${provider}". Built-in: google, openai, anthropic (others come from plugins).`)
  }
}

// Runs the prompt as a system message with the test input as the user turn.
export function makeRunner(modelId: string): RunPrompt {
  const model = resolveModel(modelId)
  return async ({ promptContent, contract, input }) => {
    if (contract.output.kind === 'image' || contract.output.kind === 'video') {
      throw new Error(`${contract.output.kind} output isn't supported yet — add a provider plugin that supports it.`)
    }
    const { text } = await generateText({ model, system: promptContent, prompt: input })
    return { kind: contract.output.kind, text }
  }
}

function requireKey(key: string | undefined, name: string): asserts key is string {
  if (!key) throw new Error(`Missing ${name}. Set it in your environment (or CI secrets) before running.`)
}
