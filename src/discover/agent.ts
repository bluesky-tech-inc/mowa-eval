import { generateObject } from 'ai'
import { z } from 'zod'
import { resolveModel } from '../providers/index'
import { findPromptFiles, type PromptFile } from './scan'

// AI discovery: read the prompt-bearing files in a repo and pull out the prompts
// embedded in them — the full instruction text, a name, and what it's for —
// regardless of how the variable was named or whether it spans many lines. This
// is what the heuristic scan can't do: find a prompt the regex missed and recover
// its exact text. Used when a key is present and the user hasn't pointed at files.

export interface DiscoveredPrompt {
  id: string
  file: string
  text: string
  intent: string
  role: 'system' | 'user' | 'template' | 'other'
  outputKind: 'text' | 'structured'
  source: 'file' | 'embedded'
}

const fileSchema = z.object({
  prompts: z.array(
    z.object({
      id: z.string(),
      intent: z.string(),
      role: z.enum(['system', 'user', 'template', 'other']),
      outputKind: z.enum(['text', 'structured']),
      text: z.string(),
    }),
  ),
})

const SYSTEM = `You extract the AI prompts embedded in a source file.

A prompt is instruction text written to be sent to a language model — a system
prompt, or a user-message template. Return its EXACT text as written in the file:
keep \${...} / {{...}} placeholders, resolve trivial string concatenation, and
drop the surrounding code. Ignore logs, error strings, UI copy, and SQL.

Only return substantial prompts — system prompts and real user-message templates.
Ignore short tool/parameter descriptions, field labels, and one-line strings that
are part of a schema rather than an instruction to the model.

For each prompt give: id (short kebab-case from its purpose), intent (one plain
sentence), role (system | user | template | other), and outputKind ("structured"
if it asks for JSON or a fixed shape, else "text"). If the file has no prompts,
return an empty list.`

const MAX_FILES = 25
const MAX_CHARS = 14000

export async function discoverFromFiles(args: { root: string; modelId: string }): Promise<DiscoveredPrompt[]> {
  const files = findPromptFiles(args.root).slice(0, MAX_FILES)
  const model = resolveModel(args.modelId)

  const perFile = await Promise.all(files.map(f => extractOne(model, f)))
  return dedupe(perFile.flat())
}

async function extractOne(model: Parameters<typeof generateObject>[0]['model'], file: PromptFile): Promise<DiscoveredPrompt[]> {
  try {
    const { object } = await generateObject({
      model,
      schema: fileSchema,
      temperature: 0,
      system: SYSTEM,
      prompt: `FILE: ${file.rel}\n\n${file.content.slice(0, MAX_CHARS)}`,
    })
    const isFile = /\.(md|txt|prompt)$/i.test(file.rel)
    return object.prompts
      .filter(p => p.role !== 'other' && p.text.trim().length > 0)
      .map(p => ({ ...p, file: file.rel, source: isFile ? 'file' : 'embedded' }))
  } catch {
    return []
  }
}

function dedupe(prompts: DiscoveredPrompt[]): DiscoveredPrompt[] {
  const seenText = new Set<string>()
  const usedIds = new Set<string>()
  const out: DiscoveredPrompt[] = []
  for (const p of prompts) {
    const key = p.text.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (seenText.has(key)) continue
    seenText.add(key)
    let id = p.id?.trim() || 'prompt'
    let n = 2
    while (usedIds.has(id)) id = `${p.id}-${n++}`
    usedIds.add(id)
    out.push({ ...p, id })
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
