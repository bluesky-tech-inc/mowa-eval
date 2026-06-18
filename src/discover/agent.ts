import { generateObject } from 'ai'
import { z } from 'zod'
import { resolveModel } from '../providers/index'
import { findPromptFiles, type PromptFile } from './scan'

// AI discovery: read the prompt-bearing files in a repo and pull out the prompts
// embedded in them — full text, a name, and the whole I/O contract (intent,
// input, output shape). This is what the heuristic scan can't do: find a prompt
// the regex missed, recover its exact text, and infer what it's for.

export interface DiscoveredPrompt {
  id: string
  file: string
  text: string
  intent: string
  role: 'system' | 'user' | 'template' | 'other'
  inputType: 'text' | 'image' | 'number' | 'boolean' | 'enum' | 'json'
  inputDescription: string
  outputKind: 'text' | 'structured' | 'image' | 'video'
  outputDescription: string
  jsonSchema?: Record<string, unknown>
  source: 'file' | 'embedded'
}

const fileSchema = z.object({
  prompts: z.array(
    z.object({
      id: z.string(),
      intent: z.string(),
      role: z.enum(['system', 'user', 'template', 'other']),
      inputType: z.enum(['text', 'image', 'number', 'boolean', 'enum', 'json']),
      inputDescription: z.string(),
      outputKind: z.enum(['text', 'structured', 'image', 'video']),
      outputDescription: z.string(),
      // JSON Schema as a string when outputKind is structured, else empty.
      jsonSchema: z.string(),
      text: z.string(),
    }),
  ),
})

const SYSTEM = `You extract the AI prompts embedded in a source file and describe each one's I/O contract.

A prompt is instruction text written to be sent to a language model — a system
prompt, or a user-message template. Return its EXACT text as written: keep
\${...} / {{...}} placeholders, resolve trivial string concatenation, drop the
surrounding code. Ignore logs, error strings, UI copy, SQL, and short tool or
parameter descriptions.

For each prompt provide:
- id: short kebab-case from its purpose (e.g. "pr-reviewer").
- intent: one plain sentence on what it is for.
- role: system | user | template | other.
- inputType: the type of the user input it expects (text | image | number | boolean | enum | json).
- inputDescription: one line on what that input is.
- outputKind: structured (asks for JSON / a fixed shape) | text | image | video.
- outputDescription: one line on what it produces.
- jsonSchema: when outputKind is structured, a JSON Schema STRING
  ({"type":"object","properties":{...},"required":[...]}); otherwise an empty string.

Only return substantial prompts (system prompts, real user-message templates).
If the file has none, return an empty list.`

const MAX_FILES = 25
const MAX_CHARS = 14000

export async function discoverFromFiles(args: { root: string; modelId: string }): Promise<DiscoveredPrompt[]> {
  const files = findPromptFiles(args.root).slice(0, MAX_FILES)
  const model = resolveModel(args.modelId)
  const perFile = await Promise.all(files.map(f => extractOne(model, f)))
  const prompts = dedupe(perFile.flat())

  // A structured contract is useless without a schema; if the extraction left it
  // empty, synthesize it in a focused second pass (it drives the required-keys check).
  await Promise.all(
    prompts.map(async p => {
      if (p.outputKind === 'structured' && schemaIsEmpty(p.jsonSchema)) {
        p.jsonSchema = await synthesizeSchema(model, p.text, p.outputDescription)
      }
    }),
  )
  return prompts
}

function schemaIsEmpty(s?: Record<string, unknown>): boolean {
  if (!s) return true
  const props = (s as { properties?: unknown }).properties
  if (props && typeof props === 'object') return Object.keys(props as Record<string, unknown>).length === 0
  return Object.keys(s).filter(k => k !== 'type' && k !== 'required').length === 0
}

async function synthesizeSchema(model: Parameters<typeof generateObject>[0]['model'], promptText: string, outputDescription: string): Promise<Record<string, unknown> | undefined> {
  try {
    const { object } = await generateObject({
      model,
      temperature: 0,
      schema: z.object({ schema: z.string() }),
      system: `Produce a JSON Schema (as a JSON string) for a prompt's structured output: {"type":"object","properties":{"<field>":{"type":...}},"required":[...]}. Infer every field the output must contain from the prompt and description. Never return empty properties.`,
      prompt: `OUTPUT: ${outputDescription}\n\nPROMPT:\n${promptText.slice(0, 4000)}`,
    })
    return parseSchema(object.schema)
  } catch {
    return undefined
  }
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
      .map(p => ({
        id: p.id,
        file: file.rel,
        text: p.text,
        intent: p.intent,
        role: p.role,
        inputType: p.inputType,
        inputDescription: p.inputDescription,
        outputKind: p.outputKind,
        outputDescription: p.outputDescription,
        jsonSchema: parseSchema(p.jsonSchema),
        source: isFile ? 'file' : 'embedded',
      }))
  } catch {
    return []
  }
}

function parseSchema(s: string): Record<string, unknown> | undefined {
  if (!s.trim()) return undefined
  try {
    const parsed = JSON.parse(s)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
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
