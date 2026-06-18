import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname, basename, sep } from 'node:path'

// Find the prompts already living in a codebase, so `mowa init` can scaffold from
// real prompts instead of a sample. Standalone prompt files, plus string/template
// literals in source assigned to prompt-ish names. Heuristic by design — the user
// reviews what it finds. No LLM, no network.
//
// We deny-list (skip binaries, media, lockfiles) rather than allow-list source
// extensions, so a Kotlin / Swift / C# / Rust repo is scanned just like a TS one.

export interface Candidate {
  id: string
  file: string
  name: string
  text: string
  source: 'file' | 'embedded'
  outputKind: 'text' | 'structured'
  confidence: number
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', '.cache', 'coverage', 'vendor', '__pycache__', 'target', '.venv', 'venv', 'Pods'])

// Extensions and files that never hold a prompt — everything else is read as text.
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff', '.pdf',
  '.mp4', '.mov', '.avi', '.webm', '.mp3', '.wav', '.flac', '.ogg',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.rar', '.7z', '.jar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class',
  '.csv', '.tsv', '.parquet', '.sqlite', '.db', '.lock', '.lockb', '.map',
])
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'cargo.lock', 'poetry.lock', 'composer.lock', 'gemfile.lock', 'go.sum'])

const PROMPT_EXT = new Set(['.md', '.txt', '.prompt'])
const MAX_BYTES = 256 * 1024
const MIN_PROMPT_CHARS = 60

// A file likely to contain prompts, for the AI extraction pass to read in full.
// Scored so we read the most promising files first (and can cap the count).
export interface PromptFile {
  rel: string
  content: string
  score: number
}

const LLM_SIGNALS = /@ai-sdk|generateText|generateObject|streamText|chat\.completions|\bmessages\s*[:=]|\bsystem\s*[:=]|new OpenAI|new Anthropic|GoogleGenerativeAI|ChatPromptTemplate|llm|completion/gi
const LONG_LITERAL = /`[^`]{120,}`|"[^"]{120,}"|'[^']{120,}'|"""[\s\S]{120,}?"""|'''[\s\S]{120,}?'''/

export function findPromptFiles(root: string): PromptFile[] {
  const files: PromptFile[] = []
  for (const file of walk(root)) {
    const rel = relative(root, file)
    const content = readText(file)
    if (content == null) continue

    const ext = extname(file).toLowerCase()
    if (PROMPT_EXT.has(ext) && isPromptFilePath(rel, file) && isPromptish(content)) {
      files.push({ rel, content, score: 100 })
      continue
    }
    let score = (content.match(LLM_SIGNALS) ?? []).length * 3
    if (PROMPTY_NAME.test(content)) score += 2
    if (LONG_LITERAL.test(content)) score += 2
    if (score >= 3) files.push({ rel, content, score })
  }
  return files.sort((a, b) => b.score - a.score)
}

export function scanRepo(root: string): Candidate[] {
  const found: Candidate[] = []
  for (const file of walk(root)) {
    const rel = relative(root, file)
    const content = readText(file)
    if (content == null) continue

    const ext = extname(file).toLowerCase()
    if (PROMPT_EXT.has(ext) && isPromptFilePath(rel, file)) fromTextFile(content, rel, file, found)
    else fromCode(content, rel, found)
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

// Read a file as text, or null if it's binary or a known non-source file.
function readText(file: string): string | null {
  const ext = extname(file).toLowerCase()
  if (SKIP_EXT.has(ext) || SKIP_FILES.has(basename(file).toLowerCase())) return null
  let content: string
  try { content = readFileSync(file, 'utf8') } catch { return null }
  if (/\u0000/.test(content.slice(0, 8000))) return null // binary (NUL byte present)
  return content
}

function isPromptFilePath(rel: string, file: string): boolean {
  return extname(file).toLowerCase() === '.prompt' || rel.split(sep).includes('prompts') || /prompt/i.test(basename(file))
}

function fromTextFile(text: string, rel: string, file: string, out: Candidate[]) {
  if (!isPromptish(text)) return
  out.push({
    id: slug(basename(file, extname(file))),
    file: rel,
    name: basename(file),
    text,
    source: 'file',
    outputKind: sniffKind(text),
    confidence: 0.9,
  })
}

// Match string/template literals assigned to a prompt-ish identifier. Works across
// C-like and script languages (the assignment keyword is optional).
const ASSIGN = /(?:const|let|var|val|final|public|private|static|export\s+const|export\s+default)?\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(`(?:\\[\s\S]|[^\\`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|"""[\s\S]*?"""|'''[\s\S]*?''')/g
const PROMPTY_NAME = /prompt|system|instruction|template/i

function fromCode(src: string, rel: string, out: Candidate[]) {
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
  if (literal.startsWith('"""') || literal.startsWith("'''")) return literal.slice(3, -3)
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
  const used = new Set<string>()
  return [...seen.values()].map(c => {
    let id = c.id || 'prompt'
    let n = 2
    while (used.has(id)) id = `${c.id}-${n++}`
    used.add(id)
    return { ...c, id }
  })
}

function slug(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'prompt'
}
