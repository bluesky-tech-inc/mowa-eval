import { generateObject } from 'ai'
import { z } from 'zod'
import { resolveModel } from '../providers/index'
import type { IOContract, TestCase } from '../core/index'

// Synthesize a starter test suite from the prompt + contract. Run once at
// `mowa generate` time and committed — never regenerated during scoring, or the
// yardstick would drift and "regression" would mean nothing.

const caseSchema = z.object({
  label: z.string(),
  category: z.enum(['typical', 'edge', 'adversarial']),
  input: z.string(),
  expectation: z.string(),
})

export async function generateTests(args: {
  promptContent: string
  contract: IOContract
  modelId: string
  count?: number
}): Promise<TestCase[]> {
  const count = args.count ?? 10
  const { object } = await generateObject({
    model: resolveModel(args.modelId),
    schema: z.object({ cases: z.array(caseSchema) }),
    temperature: 0.4,
    system: `Write ${count} test inputs for the given prompt. Mix categories: mostly "typical" realistic inputs, a few "edge" (empty, very long, missing info, unusual but valid), and a few "adversarial" (prompt injection, off-topic, attempts to break the rules). Each input must match the prompt's declared input type. For each, give a short label and a one-line expectation of what a correct answer must do.`,
    prompt: `INTENT: ${args.contract.intent}\nINPUT TYPE: ${args.contract.input.type} — ${args.contract.input.description}\nOUTPUT: ${args.contract.output.kind}\n\nPROMPT:\n${args.promptContent}`,
  })
  return object.cases
}
