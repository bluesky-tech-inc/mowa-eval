import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { parse } from 'yaml'
import pc from 'picocolors'
import { scorePrompt, type TestCase, type RbcSpec, type PromptResult } from '../core/index'
import { loadConfig, readPromptContent, readTests, type LoadedConfig } from '../config/load'
import { evalConfig, type PromptConfig } from '../config/schema'
import { makeRunner } from '../providers/index'
import { makeJudge, makeReviewer } from '../judges/index'
import { generateTests } from '../generators/index'
import { readFileAtRef, repoRelative } from '../git/refs'
import { printReport, type PromptReport } from '../report/tty'
import { INIT_CONFIG, INIT_PROMPT, INIT_TESTS } from './scaffold'

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { positional, flags } = parseArgs(rest)
  const configPath = flags.config ?? 'mowa.eval.yml'

  switch (command) {
    case 'init': return cmdInit()
    case 'generate': return cmdGenerate(configPath, positional[0])
    case 'eval': case undefined: return cmdEval(configPath, positional[0], flags.base)
    default:
      console.error(`Unknown command "${command}". Try: init · generate · eval`)
      process.exit(2)
  }
}

function cmdInit() {
  write('mowa.eval.yml', INIT_CONFIG)
  write('prompts/recipe.md', INIT_PROMPT)
  write('tests/recipe.jsonl', INIT_TESTS)
  console.log(pc.green('\nReady.'), 'Set GOOGLE_API_KEY, then run', pc.bold('mowa eval'))
}

async function cmdGenerate(configPath: string, id?: string) {
  const loaded = loadConfig(configPath)
  for (const p of pick(loaded, id)) {
    const content = readPromptContent(loaded, p)
    const tests = await generateTests({ promptContent: content, contract: p.contract, modelId: modelFor(loaded, p) })
    const out = resolve(loaded.dir, p.tests)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, tests.map(t => JSON.stringify(t)).join('\n') + '\n')
    console.log(pc.green(`✓ ${p.id}`), pc.dim(`${tests.length} tests → ${p.tests} (review and commit)`))
  }
}

async function cmdEval(configPath: string, id?: string, base?: string) {
  const loaded = loadConfig(configPath)
  const reports: PromptReport[] = []

  for (const p of pick(loaded, id)) {
    const content = readPromptContent(loaded, p)
    const tests = readTests(loaded, p)
    if (!tests.length) {
      console.error(pc.yellow(`! ${p.id}: no tests at ${p.tests} — run \`mowa generate ${p.id}\``))
      continue
    }

    const result = await scoreOne(loaded, p, content, tests)
    const baseScore = base ? await scoreBase(loaded, p, tests, base) : null

    const failed: PromptReport['failed'] = []
    const { min, max_regression } = p.threshold
    if (min != null && result.score.score < min) failed.push({ reason: 'threshold', detail: `${result.score.score} < min ${min}` })
    if (baseScore != null && max_regression != null && baseScore - result.score.score >= max_regression)
      failed.push({ reason: 'regression', detail: `${baseScore} → ${result.score.score} (−${baseScore - result.score.score})` })

    reports.push({ id: p.id, result, baseScore, threshold: p.threshold, failed })
  }

  printReport(reports)
  const broke = reports.some(r => r.failed.length)
  process.exit(broke ? 1 : 0)
}

function scoreOne(loaded: LoadedConfig, p: PromptConfig, content: string, tests: TestCase[]): Promise<PromptResult> {
  return scorePrompt({
    promptContent: content,
    contract: p.contract,
    tests,
    run: makeRunner(modelFor(loaded, p)),
    judge: makeJudge(judgeFor(loaded, p)),
    review: makeReviewer(judgeFor(loaded, p)),
    extraChecks: p.checks.map(toRbcSpec),
  })
}

// Regression baseline: score the prompt as it exists on the base ref, but only if
// its contract is unchanged. A changed contract is a breaking change — reset the
// baseline rather than report a meaningless drop.
async function scoreBase(loaded: LoadedConfig, p: PromptConfig, tests: TestCase[], base: string): Promise<number | null> {
  const baseContent = readFileAtRef(base, repoRelative(resolve(loaded.dir, p.file)))
  if (baseContent == null) return null
  if (contractChanged(loaded, p, base)) return null
  const result = await scoreOne(loaded, p, baseContent, tests)
  return result.score.score
}

function contractChanged(loaded: LoadedConfig, p: PromptConfig, base: string): boolean {
  const raw = readFileAtRef(base, repoRelative(loaded.path))
  if (raw == null) return false
  try {
    const baseCfg = evalConfig.parse(parse(raw))
    const baseP = baseCfg.prompts.find(x => x.id === p.id)
    return !baseP || JSON.stringify(baseP.contract) !== JSON.stringify(p.contract)
  } catch {
    return false
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
function pick(loaded: LoadedConfig, id?: string): PromptConfig[] {
  const all = loaded.config.prompts
  if (!id) return all
  const one = all.find(p => p.id === id)
  if (!one) throw new Error(`No prompt "${id}" in config.`)
  return [one]
}

const modelFor = (l: LoadedConfig, p: PromptConfig) => p.reference_model ?? l.config.defaults.reference_model
const judgeFor = (l: LoadedConfig, p: PromptConfig) => p.judge ?? l.config.defaults.judge

function toRbcSpec(c: { type: string } & Record<string, unknown>): RbcSpec {
  const kind = c.type === 'banned_content' ? 'safety' : 'structural'
  return { id: c.type, label: c.type, kind, ...c } as RbcSpec
}

function write(rel: string, body: string) {
  const abs = resolve(rel)
  if (existsSync(abs)) { console.log(pc.dim(`· ${rel} exists, skipped`)); return }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
  console.log(pc.green(`✓ ${rel}`))
}

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) flags[a.slice(2)] = args[i + 1]?.startsWith('--') || args[i + 1] == null ? 'true' : args[++i]!
    else positional.push(a)
  }
  return { positional, flags }
}

main().catch(e => { console.error(pc.red(e instanceof Error ? e.message : String(e))); process.exit(2) })
