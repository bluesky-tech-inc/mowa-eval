import { generateObject } from 'ai'
import { z } from 'zod'
import { resolveModel } from '../providers/index'
import type { Candidate } from './scan'

// The heuristic scan casts a wide net; this is the judgement pass. An agent reads
// each candidate and decides whether it's really a prompt, what to call it, what
// it's for, and what it produces — dropping false positives (a stray template
// fragment, a log string) the regex can't tell apart. Used when a key is present
// and the user hasn't pointed at specific prompts.

export interface DiscoveredPrompt {
  candidate: Candidate
  id: string
  intent: string
  role: 'system' | 'user' | 'template' | 'other'
  outputKind: 'text' | 'structured'
}

const schema = z.object({
  prompts: z.array(
    z.object({
      ref: z.number().int(),
      isPrompt: z.boolean(),
      id: z.string(),
      intent: z.string(),
      role: z.enum(['system', 'user', 'template', 'other']),
      outputKind: z.enum(['text', 'structured']),
    }),
  ),
})

export async function refineCandidates(args: { candidates: Candidate[]; modelId: string }): Promise<DiscoveredPrompt[]> {
  if (!args.candidates.length) return []

  const listing = args.candidates
    .map((c, i) => `[${i}] file=${c.file} name=${c.name}\n${c.text.slice(0, 600)}`)
    .join('\n\n---\n\n')

  const { object } = await generateObject({
    model: resolveModel(args.modelId),
    schema,
    temperature: 0,
    system: `You are reviewing strings pulled from a codebase to find the AI prompts worth evaluating.

For each candidate decide:
- isPrompt: true only if it is an instruction to a model (a system prompt, or a real user-message template). false for log lines, error strings, UI copy, or fragments that are just variable interpolation with no instruction.
- id: a short kebab-case identifier from its purpose (e.g. "pr-reviewer", "test-generator").
- intent: one plain sentence on what the prompt is for.
- role: system | user | template | other.
- outputKind: "structured" if it asks for JSON / a fixed shape, else "text".

Prefer system prompts and standalone prompt files. Keep the reference number.`,
    prompt: `Candidates:\n\n${listing}`,
  })

  const out: DiscoveredPrompt[] = []
  const usedIds = new Set<string>()
  for (const r of object.prompts) {
    const candidate = args.candidates[r.ref]
    if (!candidate || !r.isPrompt || r.role === 'other') continue
    let id = (r.id || candidate.id).trim() || candidate.id
    let n = 2
    while (usedIds.has(id)) id = `${r.id}-${n++}`
    usedIds.add(id)
    out.push({ candidate, id, intent: r.intent, role: r.role, outputKind: r.outputKind })
  }
  return out
}

export function hasAnyKey(): boolean {
  return Boolean(
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY,
  )
}
