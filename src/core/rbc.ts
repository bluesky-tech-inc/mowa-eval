import type { IOContract, OutputKind } from './contract'

// Rule-based checks: deterministic, LLM-free checks on a model's output. Specs are
// plain serializable data (not functions) so the exact same checks can live in
// mowa.eval.yml and be interpreted anywhere. Structural failures lower the
// conformance multiplier; safety failures zero the score.

export interface EvalOutput {
  kind: OutputKind
  text?: string
  mediaUrl?: string
}

export type RbcKind = 'structural' | 'safety'

export type RbcSpec =
  | { id: string; label: string; kind: RbcKind; type: 'output_present' }
  | { id: string; label: string; kind: RbcKind; type: 'output_kind'; expect: OutputKind }
  | { id: string; label: string; kind: RbcKind; type: 'json_valid' }
  | { id: string; label: string; kind: RbcKind; type: 'required_keys'; keys: string[] }
  | { id: string; label: string; kind: RbcKind; type: 'max_length'; max: number }
  | { id: string; label: string; kind: RbcKind; type: 'min_length'; min: number }
  | { id: string; label: string; kind: RbcKind; type: 'banned_content'; patterns: string[] }

export interface RbcResult {
  id: string
  label: string
  kind: RbcKind
  passed: boolean
  detail: string
}

export function deriveRbcSpecs(contract: Pick<IOContract, 'output'>): RbcSpec[] {
  const { output } = contract
  const specs: RbcSpec[] = [
    { id: 'present', label: 'Output is non-empty', kind: 'structural', type: 'output_present' },
    { id: 'kind', label: `Output is ${output.kind}`, kind: 'structural', type: 'output_kind', expect: output.kind },
  ]
  if (output.kind === 'structured') {
    specs.push({ id: 'json', label: 'Output is valid JSON', kind: 'structural', type: 'json_valid' })
    const keys = output.jsonSchema ? topLevelKeys(output.jsonSchema) : []
    if (keys.length) specs.push({ id: 'keys', label: `Has keys: ${keys.join(', ')}`, kind: 'structural', type: 'required_keys', keys })
  }
  return specs
}

export function runRbc(spec: RbcSpec, output: EvalOutput): RbcResult {
  const base = { id: spec.id, label: spec.label, kind: spec.kind }
  const ok = (detail = 'ok'): RbcResult => ({ ...base, passed: true, detail })
  const no = (detail: string): RbcResult => ({ ...base, passed: false, detail })

  switch (spec.type) {
    case 'output_present':
      return (output.text?.trim() || output.mediaUrl) ? ok() : no('empty output')
    case 'output_kind':
      return output.kind === spec.expect ? ok() : no(`expected ${spec.expect}, got ${output.kind}`)
    case 'json_valid':
      return parseJson(output.text) !== undefined ? ok() : no('not parseable as JSON')
    case 'required_keys': {
      const parsed = parseJson(output.text)
      if (parsed === undefined) return no('not parseable as JSON')
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return no('output is not a JSON object')
      const missing = spec.keys.filter(k => !(k in (parsed as Record<string, unknown>)))
      return missing.length ? no(`missing keys: ${missing.join(', ')}`) : ok()
    }
    case 'max_length': {
      const len = (output.text ?? '').length
      return len <= spec.max ? ok() : no(`length ${len} > ${spec.max}`)
    }
    case 'min_length': {
      const len = (output.text ?? '').length
      return len >= spec.min ? ok() : no(`length ${len} < ${spec.min}`)
    }
    case 'banned_content': {
      const hit = spec.patterns.find(p => new RegExp(p, 'i').test(output.text ?? ''))
      return hit ? no(`matched banned pattern: ${hit}`) : ok()
    }
  }
}

export interface Conformance {
  fraction: number
  hardFail: boolean
}

export function conformanceOf(results: RbcResult[]): Conformance {
  const structural = results.filter(r => r.kind === 'structural')
  const passed = structural.filter(r => r.passed).length
  return {
    fraction: structural.length === 0 ? 1 : passed / structural.length,
    hardFail: results.some(r => r.kind === 'safety' && !r.passed),
  }
}

// Models wrap JSON in ```fences```; strip them before parsing so well-formed JSON
// isn't failed on a cosmetic wrapper. Returns undefined on parse failure.
function parseJson(text?: string): unknown {
  if (text == null) return undefined
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  try {
    return JSON.parse(fenced ? (fenced[1] ?? '') : trimmed)
  } catch {
    return undefined
  }
}

function topLevelKeys(schema: Record<string, unknown>): string[] {
  const props = schema.properties
  if (props && typeof props === 'object') return Object.keys(props as Record<string, unknown>)
  return Object.keys(schema).filter(k => k !== 'type' && k !== 'required')
}
