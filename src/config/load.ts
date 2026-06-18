import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parse } from 'yaml'
import { evalConfig, type EvalConfig, type PromptConfig } from './schema'
import type { TestCase } from '../core/index'

export interface LoadedConfig {
  config: EvalConfig
  dir: string
  path: string
}

export function loadConfig(path: string): LoadedConfig {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new Error(`No config at ${path}. Run \`mowa init\` to create one.`)
  const config = evalConfig.parse(parse(readFileSync(abs, 'utf8')))
  return { config, dir: dirname(abs), path: abs }
}

export function readPromptContent(loaded: LoadedConfig, p: PromptConfig): string {
  const abs = resolve(loaded.dir, p.file)
  if (!existsSync(abs)) {
    throw new Error(`Prompt file not found: ${p.file} (for "${p.id}"). Re-run \`mowa init --force\`, or fix the path in mowa.eval.yml.`)
  }
  return readFileSync(abs, 'utf8')
}

export function readTests(loaded: LoadedConfig, p: PromptConfig): TestCase[] {
  const abs = resolve(loaded.dir, p.tests)
  if (!existsSync(abs)) return []
  return readFileSync(abs, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as TestCase)
}
