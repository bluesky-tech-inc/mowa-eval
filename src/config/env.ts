import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Load a project-local .env so a key set once with `mowa setup` is picked up on
// every run — no exporting each time. Real environment variables always win.
export function loadDotenv(dir = process.cwd()): void {
  const file = resolve(dir, '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    let val = m[2]!.trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = val
  }
}

// Set or replace one KEY=value in .env, leaving the rest untouched.
export function writeEnvVar(key: string, value: string, dir = process.cwd()): void {
  const file = resolve(dir, '.env')
  const line = `${key}=${value}`
  if (!existsSync(file)) {
    writeFileSync(file, line + '\n')
    return
  }
  const lines = readFileSync(file, 'utf8').split('\n')
  const i = lines.findIndex(l => l.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)))
  if (i >= 0) lines[i] = line
  else lines.push(line)
  writeFileSync(file, lines.filter((l, idx) => l !== '' || idx < lines.length - 1).join('\n').replace(/\n*$/, '\n'))
}

// Keep .env out of git — it holds a secret.
export function ensureGitignored(entry: string, dir = process.cwd()): void {
  const file = resolve(dir, '.gitignore')
  if (!existsSync(file)) { writeFileSync(file, entry + '\n'); return }
  const has = readFileSync(file, 'utf8').split('\n').some(l => l.trim() === entry)
  if (!has) appendFileSync(file, (readFileSync(file, 'utf8').endsWith('\n') ? '' : '\n') + entry + '\n')
}
