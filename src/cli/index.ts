import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, basename, extname } from 'node:path'
import { parse, stringify } from 'yaml'
import pc from 'picocolors'
import { scorePrompt, type TestCase, type RbcSpec, type PromptResult } from '../core/index'
import { loadConfig, readPromptContent, readTests, type LoadedConfig } from '../config/load'
import { evalConfig, type PromptConfig } from '../config/schema'
import { loadDotenv, writeEnvVar, ensureGitignored } from '../config/env'
import { makeRunner, PROVIDERS } from '../providers/index'
import { makeJudge, makeReviewer } from '../judges/index'
import { generateTests } from '../generators/index'
import { readFileAtRef, repoRelative, changedFiles } from '../git/refs'
import { printReport, type PromptReport } from '../report/tty'
import { spin } from '../report/spinner'
import { INIT_CONFIG, INIT_PROMPT, INIT_TESTS } from './scaffold'

const DEFAULT_MODEL = 'google:gemini-2.5-flash'

async function main() {
  loadDotenv()
  const [command, ...rest] = process.argv.slice(2)
  const { positional, flags } = parseArgs(rest)
  const configPath = flags.config ?? 'mowa.eval.yml'

  if (!command || command === 'help' || command === '--help' || command === '-h' || flags.help === 'true' || flags.h === 'true') return cmdHelp()

  switch (command) {
    case 'setup': return cmdSetup(positional, flags)
    case 'init': return cmdInit(flags)
    case 'add': return cmdAdd(positional, flags)
    case 'list': case 'ls': return cmdList(configPath)
    case 'generate': return cmdGenerate(configPath, positional[0])
    case 'eval': return cmdEval(configPath, positional[0], flags.base, flags.all === 'true')
    default:
      console.error(`Unknown command "${command}".\n`)
      cmdHelp()
      process.exit(2)
  }
}

function cmdSetup(positional: string[], flags: Record<string, string>) {
  let env: string | undefined
  let key: string | undefined
  for (const p of PROVIDERS) {
    const short = p.env.split('_')[0]!.toLowerCase() // google | openai | anthropic
    if (flags[short]) { env = p.env; key = flags[short] }
  }
  if (!env && positional[0]) {
    const q = positional[0].toLowerCase()
    const prov = PROVIDERS.find(p => p.name.toLowerCase().includes(q) || p.env.toLowerCase().startsWith(q))
    if (prov) { env = prov.env; key = positional[1] }
  }

  if (!env || !key) {
    console.log('Save an API key to .env so mowa uses it on every run.\n')
    console.log(`${pc.bold('Usage')}`)
    console.log('  mowa setup <provider> <api-key>     e.g. mowa setup google AIza...')
    console.log('  mowa setup --openai sk-...')
    console.log(`\nProviders: ${PROVIDERS.map(p => p.env.split('_')[0]!.toLowerCase()).join(' · ')}`)
    process.exit(2)
  }

  writeEnvVar(env, key)
  ensureGitignored('.env')
  console.log(pc.green(`✓ saved ${env} to .env`) + pc.dim('  (.env is gitignored)'))
  console.log(pc.dim('Next: mowa init'))
}

// Create a starter config + a working sample prompt. The user points it at their
// own prompts by editing mowa.eval.yml or with `mowa add`. (Auto-discovering
// prompts across a codebase and inferring contracts is a mowa.dev feature.)
function cmdInit(flags: Record<string, string>) {
  const force = flags.force === 'true'
  if (existsSync(resolve('mowa.eval.yml')) && !force) {
    console.log(pc.yellow('mowa.eval.yml already exists.'), 'Add a prompt with', pc.bold('mowa add <file>'), 'or edit it directly (--force to reset to the sample).')
    return
  }
  write('mowa.eval.yml', INIT_CONFIG, true)
  write('prompts/recipe.md', INIT_PROMPT, force)
  write('tests/recipe.jsonl', INIT_TESTS, force)
  console.log(pc.green('\nReady.'), 'A sample prompt is wired up. Point mowa at your own prompts:')
  console.log(pc.dim('  • mowa add path/to/your-prompt.md     — register a prompt file'))
  console.log(pc.dim('  • or edit mowa.eval.yml — set `file:` and fill each contract'))
  console.log(pc.dim('Then: mowa generate && mowa eval'))
  console.log(pc.dim('\nWant mowa to find prompts across your codebase and write the contracts for you? → mowa.dev'))
}

// Point mowa at an existing prompt file. The contract starts blank — you fill it
// in (intent, input, output). No scanning, no inference.
function cmdAdd(positional: string[], flags: Record<string, string>) {
  const file = positional[0]
  if (!file) {
    console.log('Usage: mowa add <path-to-prompt-file> [--id <id>]')
    process.exit(2)
  }
  if (!existsSync(resolve(file))) {
    console.error(pc.red(`File not found: ${file}`))
    process.exit(1)
  }
  const configPath = flags.config ?? 'mowa.eval.yml'
  const config = existsSync(resolve(configPath))
    ? evalConfig.parse(parse(readFileSync(resolve(configPath), 'utf8')))
    : { version: 1 as const, standard: '2.0', defaults: { reference_model: DEFAULT_MODEL, judge: DEFAULT_MODEL, samples_per_case: 1 }, plugins: [], prompts: [] }

  const id = flags.id ?? slug(basename(file, extname(file)))
  if (config.prompts.some(p => p.id === id)) {
    console.error(pc.red(`A prompt "${id}" already exists in ${configPath}. Pass --id to choose another.`))
    process.exit(1)
  }

  config.prompts.push({
    id,
    file,
    tests: `tests/${id}.jsonl`,
    contract: { intent: '', input: { type: 'text', description: '' }, output: { kind: 'text', description: '' } },
    checks: [],
    threshold: { min: 70, max_regression: 8 },
  })
  writeFileSync(resolve(configPath), stringify(config))
  console.log(pc.green(`✓ added ${id}`), pc.dim(`→ ${configPath}`))
  console.log(pc.dim(`Fill in its contract (intent / input / output) in ${configPath}, then \`mowa generate ${id}\`.`))
}

function cmdList(configPath: string) {
  const loaded = loadConfig(configPath)
  const prompts = loaded.config.prompts
  if (!prompts.length) {
    console.log(`No prompts in ${configPath}. Run \`mowa init\` or \`mowa add <file>\`.`)
    return
  }
  console.log(`${pc.bold(String(prompts.length))} prompt${prompts.length === 1 ? '' : 's'} in ${configPath}:\n`)
  for (const p of prompts) {
    const n = readTests(loaded, p).length
    const tests = n ? `${n} test${n === 1 ? '' : 's'}` : pc.yellow('no tests')
    console.log(`  ${pc.bold(p.id)}  ${pc.dim(`${p.file} · ${p.contract.output.kind} · ${tests}`)}`)
    if (p.contract.intent) console.log(pc.dim(`    ${p.contract.intent}`))
  }
}

function cmdHelp() {
  const b = pc.bold
  console.log(`${b('mowa')} — a test runner for prompts. Score them, and fail the PR when one regresses.

${b('Usage')}
  mowa <command> [options]

${b('Commands')}
  setup <p> <key> Save an API key to .env (provider: google | openai | anthropic)
  init            Create a starter mowa.eval.yml + a sample prompt
  add <file>      Register one of your prompt files (you fill in its contract)
  list            List the prompts (and ids) in mowa.eval.yml — offline, no key
  generate [id]   Write test cases for a prompt (id = name in mowa.eval.yml; omit for all)
  eval [id]       Score prompts; exits non-zero on regression or below threshold

${b('Options')}
  --config <path>   Config file (default: mowa.eval.yml)
  --id <id>         add: id for the prompt (default: derived from the filename)
  --base <ref>      eval: compare against a git ref; scores only changed prompts
  --all             eval: score every prompt even with --base (not just changed)
  --force           init: reset to the sample, overwriting mowa.eval.yml

${b('Providers')} ${pc.dim('(set one key — used to generate tests and judge outputs)')}
${PROVIDERS.map(p => `  ${p.env.padEnd(24)}${pc.dim(`${p.name} · ${p.model}`)}`).join('\n')}
  ${pc.dim('set the model per prompt in mowa.eval.yml; default is ' + DEFAULT_MODEL)}

${b('Quickstart')}
  mowa setup google <key>
  mowa init                  # or: mowa add prompts/your-prompt.md
  mowa generate && mowa eval

Find prompts across your codebase and manage them with a team → mowa.dev
Docs: https://github.com/bluesky-tech-inc/mowa-eval`)
}

async function cmdGenerate(configPath: string, id?: string) {
  const loaded = loadConfig(configPath)
  for (const p of pick(loaded, id)) {
    const content = readPromptContent(loaded, p)
    const sp = spin(`Generating test cases for ${p.id}…`)
    const tests = await generateTests({ promptContent: content, contract: p.contract, modelId: modelFor(loaded, p) }).finally(() => sp.stop())
    const out = resolve(loaded.dir, p.tests)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, tests.map(t => JSON.stringify(t)).join('\n') + '\n')
    console.log(pc.green(`✓ ${p.id}`), pc.dim(`${tests.length} tests → ${p.tests} (review and commit)`))
  }
}

async function cmdEval(configPath: string, id: string | undefined, base: string | undefined, all: boolean) {
  const loaded = loadConfig(configPath)
  const reports: PromptReport[] = []

  // On a PR (base set) score only the prompts whose files actually changed —
  // no id needed, the diff decides. --all forces the whole suite.
  let targets = pick(loaded, id)
  if (base && !id && !all) {
    const changed = new Set(changedFiles(base))
    const scoped = targets.filter(p => changed.has(repoRelative(resolve(loaded.dir, p.file))))
    if (!scoped.length) {
      console.log(pc.dim(`No prompt files changed vs ${base} — nothing to score.`))
      process.exit(0)
    }
    if (scoped.length < targets.length) console.log(pc.dim(`Scoring ${scoped.length} changed prompt(s) (use --all for the full suite).`))
    targets = scoped
  }

  for (const p of targets) {
    const content = readPromptContent(loaded, p)
    const tests = readTests(loaded, p)
    if (!tests.length) {
      console.error(pc.yellow(`! ${p.id}: no tests at ${p.tests} — run \`mowa generate ${p.id}\``))
      continue
    }

    const sp = spin(`Scoring ${p.id}…`)
    const result = await scoreOne(loaded, p, content, tests, (d, t) => sp.update(`Scoring ${p.id}… ${d}/${t}`))
    let baseScore: number | null = null
    if (base) {
      sp.update(`Scoring ${p.id} on ${base} (baseline)…`)
      baseScore = await scoreBase(loaded, p, tests, base)
    }
    sp.stop()

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

function scoreOne(loaded: LoadedConfig, p: PromptConfig, content: string, tests: TestCase[], onProgress?: (done: number, total: number) => void): Promise<PromptResult> {
  return scorePrompt({
    promptContent: content,
    contract: p.contract,
    tests,
    run: makeRunner(modelFor(loaded, p)),
    judge: makeJudge(judgeFor(loaded, p)),
    review: makeReviewer(judgeFor(loaded, p)),
    extraChecks: p.checks.map(toRbcSpec),
    onProgress,
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

function slug(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'prompt'
}

function write(rel: string, body: string, force = false) {
  const abs = resolve(rel)
  if (existsSync(abs) && !force) { console.log(pc.dim(`· ${rel} exists, skipped`)); return }
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
