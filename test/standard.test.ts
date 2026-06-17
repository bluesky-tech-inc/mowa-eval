import { test, expect } from 'vitest'
import { composeScore } from '../src/core/standard'
import { deriveRbcSpecs, runRbc, conformanceOf, type EvalOutput } from '../src/core/rbc'

// These fixtures pin the published standard. A re-implementation (or the hosted
// product) must reproduce them exactly, or it isn't the same standard.

test('worked example composes to 75', () => {
  const r = composeScore({
    promptQuality: 88, behavioral: 82, robustness: 71,
    conformance: 0.93, hardFail: false,
    coverage: { cases: 16, categories: 3, samplesPerCase: 3 }, variance: 4,
  })
  expect(r.score).toBe(75)
  expect(r.confidence).toBe('high')
})

test('conformance caps the score (multiplier, not subtraction)', () => {
  const base = { promptQuality: 90, behavioral: 90, robustness: 90, hardFail: false, coverage: { cases: 8, categories: 3, samplesPerCase: 1 }, variance: 0 }
  expect(composeScore({ ...base, conformance: 1 }).score).toBe(90)
  expect(composeScore({ ...base, conformance: 0.5 }).score).toBe(45)
})

test('a safety hard-fail zeroes the score', () => {
  const r = composeScore({ promptQuality: 95, behavioral: 95, robustness: 95, conformance: 1, hardFail: true, coverage: { cases: 8, categories: 3, samplesPerCase: 1 }, variance: 0 })
  expect(r.score).toBe(0)
})

test('static-only score is provisional and renormalizes weights', () => {
  const r = composeScore({ promptQuality: 80, behavioral: null, robustness: null, conformance: 1, hardFail: false, coverage: { cases: 0, categories: 0, samplesPerCase: 0 }, variance: 0 })
  expect(r.score).toBe(80)
  expect(r.confidence).toBe('provisional')
  expect(r.breakdown.weightsUsed.promptQuality).toBe(1)
})

test('derives schema checks and catches a prose answer to a JSON contract', () => {
  const specs = deriveRbcSpecs({ output: { kind: 'structured', description: '', jsonSchema: { properties: { ingredients: {}, steps: {} } } } })
  const good: EvalOutput = { kind: 'structured', text: '```json\n{"ingredients":["2 eggs"],"steps":["whisk"]}\n```' }
  expect(conformanceOf(specs.map(s => runRbc(s, good))).fraction).toBe(1)
  const prose: EvalOutput = { kind: 'text', text: 'Here is a lovely recipe...' }
  expect(conformanceOf(specs.map(s => runRbc(s, prose))).fraction).toBeLessThan(1)
})
