import { execFileSync } from 'node:child_process'

// Reads a file as it existed at a git ref. This is how regression works with no
// database: score the prompt at HEAD and at the base branch, then diff. Returns
// null when the file didn't exist at that ref (a brand-new prompt).

export function readFileAtRef(ref: string, repoRelativePath: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${repoRelativePath}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

export function repoRelative(absPath: string): string {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  return absPath.startsWith(root) ? absPath.slice(root.length + 1) : absPath
}

// Files that differ between a base ref and the working tree — used to score only
// the prompts a PR actually touched, instead of the whole suite.
export function changedFiles(base: string): string[] {
  try {
    return execFileSync('git', ['diff', '--name-only', base, '--'], { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}
