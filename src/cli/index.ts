import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { parse } from 'yaml'
import pc from 'picocolors'
import { scorePrompt, type TestCase, type RbcSpec, type PromptResult } from '../core/index'
import { loadConfig, readPromptContent, readTests, type LoadedConfig } from '../config/load'
import { evalConfig, type PromptConfig } from '../config/schema'
import { makeRunner, hasAnyKey, PROVIDERS } from '../providers/index'
import { makeJudge, makeReviewer } from '../judges/index'
import { generateTests } from '../generators/index'
import { readFileAtRef, repoRelative } from '../git/refs'
import { printReport, type PromptReport } from '../report/tty'
import { INIT_CONFIG, INIT_PROMPT, INIT_TESTS } from './scaffold'
import { scanRepo } from '../discover/scan'
import { discoverFromFiles } from '../discover/agent'
import { stringify } from 'yaml'

const DEFAULT_MODEL = 'google:gemini-2.5-flash'

interface Found {
  id: string
  file: string
  source: 'file' | 'embedded'
  text: string
  intent: string
  inputType: string
  inputDescription: string
  outputKind: 'text' | 'structured' | 'image' | 'video'
  outputDescription: string
  jsonSchema?: Record<string, unknown>
  confidence: number
}

// Heuristic scan gathers candidates; an AI agent then confirms and names them
// when a key is present and the user hasn't opted out with --no-ai.
async function discover(flags: Record<string, string>): Promise<{ items: Found[]; usedAI: boolean }> {
  const candidates = scanRepo(process.cwd())
  if (!candidates.length) return { items: [], usedAI: false }

  if (flags['no-ai'] === 'true') {
    // Explicit heuristic pass — fast, no key, but contracts come out empty.
    return {
      items: candidates.map(c => ({ id: c.id, file: c.file, source: c.source, text: c.text, intent: '', inputType: 'text', inputDescription: '', outputKind: c.outputKind, outputDescription: '', confidence: c.confidence })),
      usedAI: false,
    }
  }

  // AI path: read prompt-bearing files in full and extract the embedded prompts
  // with their whole contract.
  const refined = await discoverFromFiles({ root: process.cwd(), modelId: flags.model ?? DEFAULT_MODEL })
  return {
    items: refined.map(r => ({
      id: r.id, file: r.file, source: r.source, text: r.text, intent: r.intent,
      inputType: r.inputType, inputDescription: r.inputDescription,
      outputKind: r.outputKind, outputDescription: r.outputDescription, jsonSchema: r.jsonSchema,
      confidence: 0.9,
    })),
    usedAI: true,
  }
}

// mowa is useless without a model — without one it can't name prompts or infer
// contracts, so refuse rather than dump empty entries. --no-ai is the escape hatch.
function ensureKeyOrExit(flags: Record<string, string>) {
  if (flags['no-ai'] === 'true' || hasAnyKey()) return
  console.log(`mowa needs an AI key — it reads your prompts to name them and infer their contracts.\n`)
  console.log('Set one of these, then run again:')
  for (const p of PROVIDERS) console.log(`  ${pc.bold(p.env.padEnd(22))} ${pc.dim(`# ${p.name} · ${p.model}`)}`)
  console.log(pc.dim(`\n  export ${PROVIDERS[0]!.env}=...\n`))
  console.log(pc.dim('Advanced: `--no-ai` does a rough heuristic pass with no key (contracts come out blank).'))
  process.exit(1)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { positional, flags } = parseArgs(rest)
  const configPath = flags.config ?? 'mowa.eval.yml'

  if (!command || command === 'help' || command === '--help' || command === '-h' || flags.help === 'true' || flags.h === 'true') return cmdHelp()

  switch (command) {
    case 'scan': return cmdScan(flags)
    case 'init': return cmdInit(flags)
    case 'generate': return cmdGenerate(configPath, positional[0])
    case 'eval': return cmdEval(configPath, positional[0], flags.base)
    default:
      console.error(`Unknown command "${command}".\n`)
      cmdHelp()
      process.exit(2)
  }
}

function cmdHelp() {
  const b = pc.bold
  console.log(`${b('mowa')} — a test runner for prompts. Score them, and fail the PR when one regresses.

${b('Usage')}
  mowa <command> [options]

${b('Commands')}
  scan            Find the prompts in this repo (AI-reviewed when a key is set)
  init            Scaffold mowa.eval.yml from the prompts it finds
  generate [id]   Write test cases for a prompt (or all of them)
  eval [id]       Score prompts; exits non-zero on regression or below threshold

${b('Options')}
  --config <path>   Config file (default: mowa.eval.yml)
  --base <ref>      eval: compare against a git ref to catch regressions
  --model <id>      Model for discovery/generation (default: google:gemini-2.5-flash)
  --no-ai           scan/init: heuristic only, no model calls
  --sample          init: start from a blank example instead of your prompts

${b('Providers')} ${pc.dim('(set one key — used to find prompts, generate tests, and judge)')}
${PROVIDERS.map(p => `  ${p.env.padEnd(24)}${pc.dim(`${p.name} · ${p.model}`)}`).join('\n')}
  ${pc.dim('pick a model with --model <provider:model>; default is ' + DEFAULT_MODEL)}

${b('Quickstart')}
  export GOOGLE_API_KEY=...
  mowa init && mowa generate && mowa eval

Docs: https://github.com/bluesky-tech-inc/mowa-eval`)
}

async function cmdScan(flags: Record<string, string>) {
  ensureKeyOrExit(flags)
  const { items, usedAI } = await discover(flags)
  if (!items.length) {
    console.log('No prompts found. They live in .md/.txt/.prompt files, or in string literals named like a prompt (PROMPT, system, …).')
    return
  }
  console.log(`Found ${pc.bold(String(items.length))} prompt${items.length === 1 ? '' : 's'}${usedAI ? pc.dim(' (AI-reviewed)') : ''}:\n`)
  for (const c of items) {
    console.log(`  ${pc.bold(c.id)}  ${pc.dim(`${c.file} · ${c.source}`)}`)
    console.log(pc.dim(`    ${c.intent || c.text.replace(/\s+/g, ' ').trim().slice(0, 90) + '…'}`))
  }
  if (!usedAI) console.log(pc.dim('\nSet an API key for AI-reviewed discovery (or pass --no-ai to keep it heuristic).'))
  console.log(pc.dim('Run `mowa init` to scaffold a config from these.'))
}

async function cmdInit(flags: Record<string, string>) {
  if (flags.sample !== 'true') ensureKeyOrExit(flags)
  const { items, usedAI } = flags.sample === 'true' ? { items: [] as Found[], usedAI: false } : await discover(flags)
  if (!items.length) {
    write('mowa.eval.yml', INIT_CONFIG)
    write('prompts/recipe.md', INIT_PROMPT)
    write('tests/recipe.jsonl', INIT_TESTS)
    console.log(pc.dim('\nNo existing prompts found — scaffolded a sample.'))
    console.log(pc.green('Ready.'), 'Set GOOGLE_API_KEY, then run', pc.bold('mowa eval'))
    return
  }

  console.log(`Found ${pc.bold(String(items.length))} prompt${items.length === 1 ? '' : 's'}${usedAI ? pc.dim(' (AI-reviewed)') : ''} in your repo.`)
  const top = items.slice(0, 25)
  const config = {
    version: 1,
    standard: '2.0',
    defaults: { reference_model: DEFAULT_MODEL, judge: DEFAULT_MODEL },
    prompts: top.map(configEntry),
  }
  write('mowa.eval.yml', stringify(config))
  for (const c of top) {
    // Embedded prompts get lifted into a file so they can be versioned and graded.
    if (c.source === 'embedded') write(`prompts/${c.id}.md`, c.text.trim() + '\n')
  }
  console.log(pc.green('\nReady.'), 'Review mowa.eval.yml, then:')
  console.log(pc.dim('  mowa generate   # write test cases for each prompt'))
  console.log(pc.dim('  mowa eval       # score them'))
}

function configEntry(c: Found) {
  const output: Record<string, unknown> = { kind: c.outputKind, description: c.outputDescription }
  if (c.outputKind === 'structured') output.jsonSchema = c.jsonSchema ?? { type: 'object', properties: {} }
  return {
    id: c.id,
    file: c.source === 'embedded' ? `prompts/${c.id}.md` : c.file,
    tests: `tests/${c.id}.jsonl`,
    contract: {
      intent: c.intent,
      input: { type: c.inputType || 'text', description: c.inputDescription },
      output,
    },
    threshold: { min: 70, max_regression: 8 },
  }
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
