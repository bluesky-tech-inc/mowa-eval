import type { IOContract } from './contract'
import { deriveRbcSpecs, runRbc, conformanceOf, type EvalOutput, type RbcSpec, type RbcResult } from './rbc'
import { composeScore, type MowaScore } from './standard'

// Orchestration only — every external effect (running the prompt, judging,
// reviewing) is an injected function, so this stays pure and testable.

export interface TestCase {
  label: string
  category: string
  input: string
  expectation?: string
}

export interface RunRequest {
  promptContent: string
  contract: IOContract
  input: string
}

export type RunPrompt = (req: RunRequest) => Promise<EvalOutput>

export interface JudgeRequest {
  intent: string
  input: string
  output: EvalOutput
  category: string
  expectation?: string
}
export interface JudgeVerdict {
  score: number
  whatFailed?: string
  suggestion?: string
}
export type Judge = (req: JudgeRequest) => Promise<JudgeVerdict>

export type ReviewPrompt = (promptContent: string, contract: IOContract) => Promise<number>

export interface CaseResult {
  test: TestCase
  output: EvalOutput
  score: number
  failed: RbcResult[]
  whatFailed?: string
  suggestion?: string
}

export interface PromptResult {
  score: MowaScore
  cases: CaseResult[]
}

const ROBUSTNESS = new Set(['edge', 'adversarial', 'error'])

export async function scorePrompt(args: {
  promptContent: string
  contract: IOContract
  tests: TestCase[]
  run: RunPrompt
  judge: Judge
  review?: ReviewPrompt
  extraChecks?: RbcSpec[]
}): Promise<PromptResult> {
  const { promptContent, contract, tests, run, judge, review } = args
  const specs = [...deriveRbcSpecs(contract), ...(args.extraChecks ?? [])]

  const cases: CaseResult[] = []
  const behavioral: number[] = []
  const robustness: number[] = []
  const allResults: RbcResult[] = []
  const categories = new Set<string>()

  for (const test of tests) {
    const output = await run({ promptContent, contract, input: test.input })
    const results = specs.map(s => runRbc(s, output))
    allResults.push(...results)

    const verdict = await judge({
      intent: contract.intent,
      input: test.input,
      output,
      category: test.category,
      expectation: test.expectation,
    })

    const cat = (test.category || 'typical').toLowerCase()
    categories.add(cat)
    ;(ROBUSTNESS.has(cat) ? robustness : behavioral).push(verdict.score)

    cases.push({
      test,
      output,
      score: verdict.score,
      failed: results.filter(r => !r.passed),
      whatFailed: verdict.whatFailed,
      suggestion: verdict.suggestion,
    })
  }

  const { fraction, hardFail } = conformanceOf(allResults)
  const promptQuality = review ? await review(promptContent, contract) : null

  const score = composeScore({
    promptQuality,
    behavioral: mean(behavioral),
    robustness: mean(robustness),
    conformance: fraction,
    hardFail,
    coverage: { cases: tests.length, categories: categories.size, samplesPerCase: 1 },
    variance: 0,
  })

  return { score, cases }
}

const mean = (xs: number[]): number | null => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
