import pc from 'picocolors'
import type { PromptResult } from '../core/index'

export interface PromptReport {
  id: string
  result: PromptResult
  baseScore: number | null
  threshold: { min?: number; max_regression?: number }
  failed: { reason: 'threshold' | 'regression'; detail: string }[]
}

export function printReport(reports: PromptReport[]): void {
  for (const r of reports) {
    const s = r.result.score
    const head = `${color(s.score)(String(s.score))}${pc.dim(`/100 ±${s.band}`)} ${pc.dim(s.confidence)}`
    const delta = r.baseScore == null ? '' : pc.dim(` (was ${r.baseScore}, ${signed(s.score - r.baseScore)})`)
    console.log(`\n${pc.bold(r.id)}  ${head}${delta}`)

    const p = s.breakdown.pillars
    console.log(pc.dim(`  quality ${fmt(p.promptQuality)}  ·  behavioral ${fmt(p.behavioral)}  ·  robustness ${fmt(p.robustness)}  ·  conformance ${Math.round(s.breakdown.conformance * 100)}%`))

    const weak = r.result.cases.filter(c => c.score < 70 || c.failed.length).slice(0, 6)
    for (const c of weak) {
      const checks = c.failed.length ? pc.red(` [${c.failed.map(f => f.id).join(', ')}]`) : ''
      console.log(`  ${color(c.score)('•')} ${pc.dim(c.test.category.padEnd(11))} ${c.test.label}${checks}`)
      if (c.whatFailed) console.log(pc.dim(`      ${c.whatFailed}`))
    }

    for (const f of r.failed) console.log(pc.red(`  ✗ ${f.reason}: ${f.detail}`))
    if (!r.failed.length) console.log(pc.green('  ✓ passed'))
  }
}

const color = (n: number) => (n >= 70 ? pc.green : n >= 45 ? pc.yellow : pc.red)
const fmt = (n: number | null) => (n == null ? pc.dim('—') : String(n))
const signed = (n: number) => (n > 0 ? `+${n}` : String(n))
