import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname, basename, sep } from 'node:path'

// Find the prompts already living in a codebase, so `mowa init` can scaffold from
// real prompts instead of a sample. This is a lightweight take on mowa's repo
// scanner: standalone prompt files, plus string/template literals in source that
// are assigned to prompt-ish names. Heuristic by design — the user reviews what
// it finds. No LLM, no network.

export interface Candidate {
  id: string
  file: string
  name: string
  text: string
  source: 'file' | 'embedded'
  outputKind: 'text' | 'structured'
  confidence: number
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', '.cache', 'coverage', 'vendor', '__pycache__'])
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.java', '.php'])
const TEXT_EXT = new Set(['.md', '.txt', '.prompt'])
const MAX_BYTES = 256 * 1024
const MIN_PROMPT_CHARS = 60

export function scanRepo(root: string): Candidate[] {
  const found: Candidate[] = []
  for (const file of walk(root)) {
    const ext = extname(file)
    const rel = relative(root, file)
    if (TEXT_EXT.has(ext)) fromTextFile(file, rel, found)
    else if (CODE_EXT.has(ext)) fromCode(file, rel, found)
  }
  return dedupe(found).sort((a, b) => b.confidence - a.confidence)
}

function* walk(dir: string): Generator<string> {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full)
    } else if (e.isFile()) {
      try { if (statSync(full).size <= MAX_BYTES) yield full } catch { /* unreadable */ }
    }
  }
}

// A standalone prompt file: .prompt anywhere, or .md/.txt that lives under a
// prompts/ directory or is named like a prompt. README and docs are left alone.
function fromTextFile(file: string, rel: string, out: Candidate[]) {
  const ext = extname(file)
  const looksPrompty = ext === '.prompt' || rel.split(sep).includes('prompts') || /prompt/i.test(basename(file))
  if (!looksPrompty) return
  const text = read(file)
  if (!isPromptish(text)) return
  out.push({
    id: slug(basename(file, ext)),
    file: rel,
    name: basename(file),
    text,
    source: 'file',
    outputKind: sniffKind(text),
    confidence: 0.9,
  })
}

// Match string/template literals assigned to a prompt-ish identifier, plus the
// common `system:` field in AI-SDK calls.
const ASSIGN = /(?:const|let|var|export\s+const|export\s+default)?\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(`(?:\\[\s\S]|[^\\`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g
const PROMPTY_NAME = /prompt|system|instruction|template/i

function fromCode(file: string, rel: string, out: Candidate[]) {
  const src = read(file)
  for (const m of src.matchAll(ASSIGN)) {
    const name = m[1] ?? ''
    if (!PROMPTY_NAME.test(name)) continue
    const text = unquote(m[2] ?? '')
    if (!isPromptish(text)) continue
    out.push({
      id: slug(name),
      file: rel,
      name,
      text,
      source: 'embedded',
      outputKind: sniffKind(text),
      confidence: name.toLowerCase().includes('prompt') || name.toLowerCase() === 'system' ? 0.75 : 0.6,
    })
  }
}

function isPromptish(text: string): boolean {
  return text.trim().length >= MIN_PROMPT_CHARS && /\s/.test(text.trim())
}

function sniffKind(text: string): 'text' | 'structured' {
  return /\bjson\b|"type"\s*:\s*"object"|structured output|respond with (?:a )?json/i.test(text) ? 'structured' : 'text'
}

function unquote(literal: string): string {
  const body = literal.slice(1, -1)
  return literal[0] === '`' ? body : body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["'\\])/g, '$1')
}

function dedupe(cands: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>()
  for (const c of cands) {
    const key = c.text.replace(/\s+/g, ' ').trim().slice(0, 200)
    const prev = seen.get(key)
    if (!prev || c.confidence > prev.confidence) seen.set(key, c)
  }
  // Keep ids unique across what survives.
  const used = new Set<string>()
  return [...seen.values()].map(c => {
    let id = c.id || 'prompt'
    let n = 2
    while (used.has(id)) id = `${c.id}-${n++}`
    used.add(id)
    return { ...c, id }
  })
}

function read(file: string): string {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

function slug(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2') // split camelCase, but leave ALL_CAPS intact
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'prompt'
}
