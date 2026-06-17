import { z } from 'zod'
import { ioContract } from '../core/contract'

// Schema for mowa.eval.yml. Kept permissive where authors benefit (checks pass
// through to the RBC runner) and strict where correctness depends on it.

const checkSpec = z.object({ type: z.string() }).passthrough()

export const promptConfig = z.object({
  id: z.string(),
  file: z.string(),
  contract: ioContract,
  tests: z.string(),
  checks: z.array(checkSpec).default([]),
  reference_model: z.string().optional(),
  judge: z.string().optional(),
  threshold: z
    .object({ min: z.number().min(0).max(100).optional(), max_regression: z.number().min(0).optional() })
    .default({}),
})
export type PromptConfig = z.infer<typeof promptConfig>

export const evalConfig = z.object({
  version: z.literal(1).default(1),
  standard: z.string().default('2.0'),
  defaults: z
    .object({
      reference_model: z.string().default('google:gemini-2.5-flash'),
      judge: z.string().default('google:gemini-2.5-flash'),
      samples_per_case: z.number().int().min(1).default(1),
    })
    .default({ reference_model: 'google:gemini-2.5-flash', judge: 'google:gemini-2.5-flash', samples_per_case: 1 }),
  plugins: z.array(z.string()).default([]),
  prompts: z.array(promptConfig),
})
export type EvalConfig = z.infer<typeof evalConfig>
