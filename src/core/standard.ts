// The mowa Prompt Score — one number, composed from four pillars. This module is
// pure (no I/O, no clock, no randomness) so the score is reproducible and the
// hosted mowa product can compute the identical value. Do not drift from it
// without bumping STANDARD_VERSION.

export const STANDARD_VERSION = '2.0' as const

// The weights are the standard. Behavioral dominates because it measures what the
// prompt actually does; static prompt quality matters least once outputs exist.
export const WEIGHTS = { behavioral: 0.45, robustness: 0.3, promptQuality: 0.25 } as const

const TARGET_CASES = 8

export interface ScoreInput {
  promptQuality: number | null
  behavioral: number | null
  robustness: number | null
  conformance: number
  hardFail: boolean
  coverage: { cases: number; categories: number; samplesPerCase: number }
  variance: number
}

export type Confidence = 'provisional' | 'low' | 'medium' | 'high'

export interface MowaScore {
  score: number
  band: number
  confidence: Confidence
  standardVersion: typeof STANDARD_VERSION
  breakdown: {
    pillars: { promptQuality: number | null; behavioral: number | null; robustness: number | null }
    weightsUsed: Record<string, number>
    qualityBlock: number
    conformance: number
    hardFail: boolean
    provisional: boolean
  }
}

export function composeScore(input: ScoreInput): MowaScore {
  const present: Array<{ key: string; value: number; weight: number }> = []
  if (input.promptQuality != null) present.push({ key: 'promptQuality', value: input.promptQuality, weight: WEIGHTS.promptQuality })
  if (input.behavioral != null) present.push({ key: 'behavioral', value: input.behavioral, weight: WEIGHTS.behavioral })
  if (input.robustness != null) present.push({ key: 'robustness', value: input.robustness, weight: WEIGHTS.robustness })

  const provisional = input.behavioral == null && input.robustness == null
  const totalWeight = present.reduce((s, p) => s + p.weight, 0)

  const weightsUsed: Record<string, number> = {}
  let qualityBlock = 0
  for (const p of present) {
    const w = totalWeight === 0 ? 0 : p.weight / totalWeight
    weightsUsed[p.key] = round2(w)
    qualityBlock += p.value * w
  }

  const conformance = clamp01(input.conformance)
  const score = input.hardFail ? 0 : qualityBlock * conformance
  const { band, confidence } = bandAndConfidence(input, provisional, present.length > 0)

  return {
    score: Math.round(score),
    band,
    confidence,
    standardVersion: STANDARD_VERSION,
    breakdown: {
      pillars: { promptQuality: input.promptQuality, behavioral: input.behavioral, robustness: input.robustness },
      weightsUsed,
      qualityBlock: Math.round(qualityBlock),
      conformance: round2(conformance),
      hardFail: input.hardFail,
      provisional,
    },
  }
}

function bandAndConfidence(input: ScoreInput, provisional: boolean, hasPillar: boolean): { band: number; confidence: Confidence } {
  if (input.hardFail) return { band: 0, confidence: 'high' }
  if (!hasPillar) return { band: 50, confidence: 'provisional' }

  const { cases, categories } = input.coverage
  const casePenalty = clamp(((TARGET_CASES - cases) / TARGET_CASES) * 10, 0, 10)
  const categoryPenalty = clamp((3 - categories) * 3, 0, 9)
  const variancePenalty = clamp(input.variance * 0.5, 0, 20)
  const band = Math.round(clamp(2 + casePenalty + categoryPenalty + variancePenalty, 1, 45))

  let confidence: Confidence
  if (provisional) confidence = 'provisional'
  else if (band > 12 || cases < 3) confidence = 'low'
  else if (band > 6 || cases < TARGET_CASES) confidence = 'medium'
  else confidence = 'high'

  return { band, confidence }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const clamp01 = (n: number) => clamp(n, 0, 1)
const round2 = (n: number) => Math.round(n * 100) / 100
