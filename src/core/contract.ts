import { z } from 'zod'

// A prompt's typed signature — what it takes and what it produces. The contract
// is the spine of an eval: it decides which checks apply, which models can run
// it, and how the judge compares.

export const varType = z.enum(['text', 'image', 'number', 'boolean', 'enum', 'json'])
export type VarType = z.infer<typeof varType>

export const outputKind = z.enum(['text', 'structured', 'image', 'video'])
export type OutputKind = z.infer<typeof outputKind>

export const contractInput = z.object({
  type: varType.default('text'),
  description: z.string().default(''),
})

export const contractOutput = z.object({
  kind: outputKind,
  description: z.string().default(''),
  // Present for structured output: a JSON-schema-ish object. Drives required-keys
  // checks. Kept loose so authors aren't forced into strict schema grammar.
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
})

export const ioContract = z.object({
  intent: z.string().default(''),
  input: contractInput.default({ type: 'text', description: '' }),
  output: contractOutput,
})
export type IOContract = z.infer<typeof ioContract>
