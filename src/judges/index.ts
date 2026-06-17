import { generateObject } from 'ai'
import { z } from 'zod'
import type { Judge, ReviewPrompt } from '../core/index'
import { resolveModel } from '../providers/index'

// The judge scores the residue that rule-based checks can't: did the output do
// what the prompt intended? Fixed model, temperature 0, so a score is reproducible.

const verdictSchema = z.object({
  score: z.number().min(0).max(100),
  whatFailed: z.string().describe('The single most important thing wrong with the output. Empty if score >= 90.'),
  suggestion: z.string().describe('One concrete fix to the prompt. Empty if score >= 90.'),
})

const JUDGE_SYSTEM = `You evaluate whether a model's output fulfilled its prompt's intent for one input.

Score 0-100:
- 90-100 fully satisfies the intent, no fabrication or real flaw
- 70-89  minor gaps
- 50-69  partial — skips key requirements
- 30-49  significant deviation
- 0-29   misses the point entirely

Use the full range; reserve 90+ for genuinely clean outputs. For edge, adversarial,
or missing-information cases, confident fabrication or ignoring missing input is a
serious failure (40 or below) even when the prose is fluent. Judge against the
intent, not surface polish. Be concrete about what failed.`

export function makeJudge(modelId: string): Judge {
  const model = resolveModel(modelId)
  return async ({ intent, input, output, category, expectation }) => {
    const { object } = await generateObject({
      model,
      schema: verdictSchema,
      temperature: 0,
      system: JUDGE_SYSTEM,
      prompt: [
        `INTENT: ${intent || '(not declared)'}`,
        `TEST CATEGORY: ${category}`,
        expectation ? `A CORRECT ANSWER MUST: ${expectation}` : '',
        `INPUT:\n${input}`,
        `OUTPUT:\n${output.text ?? '(non-text output)'}`,
      ].filter(Boolean).join('\n\n'),
    })
    return {
      score: object.score,
      whatFailed: object.whatFailed || undefined,
      suggestion: object.suggestion || undefined,
    }
  }
}

// The prompt-quality pillar: a static critique of the prompt text alone, no outputs.
export function makeReviewer(modelId: string): ReviewPrompt {
  const model = resolveModel(modelId)
  return async (promptContent, contract) => {
    const { object } = await generateObject({
      model,
      schema: z.object({ score: z.number().min(0).max(100) }),
      temperature: 0,
      system: `Rate a prompt's quality 0-100 on clarity, completeness, and robustness of wording — the prompt text only, not any output. Lower scores for ambiguity, missing constraints, contradictions, or no guard against bad input.`,
      prompt: `INTENT: ${contract.intent || '(not declared)'}\n\nPROMPT:\n${promptContent}`,
    })
    return object.score
  }
}
