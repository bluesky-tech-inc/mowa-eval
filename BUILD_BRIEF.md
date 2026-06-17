# Build `mowa-eval`

You're not generating a project. You're founding one. People will read this code,
depend on it, and contribute to it. Build it the way you'd build something you're
proud to put your name on — small, clear, made by hand. Sparse comments, honest
names, no machinery for its own sake. If a section here reads like a checklist,
your job is to turn it into software that feels considered.

## What it is

`mowa-eval` is a **prompt test runner** — like Jest, but for prompts. You point it
at a prompt file and some example inputs; it runs them, scores how well the prompt
did its job, and in CI it **fails the pull request when a prompt gets worse.** It's
a command-line tool and a GitHub Action, not an SDK. It's language-agnostic (it
grades a *prompt*, not anyone's app code) and serverless (git is the history, the
user's CI is the compute, the user's API key calls the model — we run nothing).

It exists because prompts are production code that everyone treats as throwaway
text. This makes them testable, and makes a regression as loud as a failing test.

## The feeling we're chasing

A developer should add it in five minutes and immediately trust it. The terminal
output should be calm and legible. The PR comment should read like a thoughtful
colleague, not a linter screaming. When something takes time, it should say so
kindly. Every default should be the one a careful person would pick.

## Context: what mowa is

mowa is an AI-governance product — it versions, tests, and attributes prompts like
code. Its eval scores a prompt's fitness and catches regressions. `mowa-eval` is the
open-source heart of that eval, given away so anyone can gate their prompts in CI.
The hosted mowa app imports the same scoring engine, so the free tool and the paid
product produce the **identical number**. That equality is sacred — never drift
from the standard below.

## How people get it

Two front doors, both zero-infrastructure:
- **GitHub Action** — published to the Marketplace (a public repo + a tag). Any repo
  adds one `uses:` line and it runs on GitHub's runners on every PR.
- **CLI on npm** — `npx mowa eval` runs locally with no install; or
  `pnpm add -D @mowa/eval-cli`.

Setup is `mowa init` then drop in the Action. Make those first five minutes
effortless.

## Shape

TypeScript. pnpm workspaces + turborepo. Node 20. LLM calls through the Vercel AI
SDK (`ai`, `@ai-sdk/google|openai|anthropic`). `zod` at the edges, `vitest` for
tests, `yaml` for config, a small CLI lib. MIT, conventional commits, changesets.

```
packages/
  core/         @mowa/eval-core        standard + pipeline — pure, no I/O ever
  config/       @mowa/eval-config      mowa.eval.yml + .jsonl loaders + score cache
  providers/    @mowa/eval-providers   google / openai / anthropic adapters
  judges/       @mowa/eval-judges      text judge (vision judge stubbed, clearly)
  checks/       @mowa/eval-checks       the built-in rule-based checks
  generators/   @mowa/eval-generators  AI test synthesizer
  reporters/    @mowa/eval-reporters   tty · json · junit · sarif · github-pr
  cli/          @mowa/eval-cli         the `mowa` binary
  action/       @mowa/eval-action      the GitHub Action
  plugin-sdk/   @mowa/eval-plugin-sdk  definePlugin() — what the community pins to
examples/   a real prompt + contract + tests that actually runs
docs/       the standard, and a warm "write a plugin" guide
```
Inviolable: **`core` touches nothing external** — no network, fs, clock, or
randomness. Everything impure lives in the other packages. That keeps the score
reproducible and the core a joy to test.

## The standard (the math — get it exactly right, v"2.0")

One score, 0–100, composed from four pillars:
- **promptQuality** — a static critique of the prompt text alone.
- **behavioral** — mean judge score on `typical` cases.
- **robustness** — mean judge score on `edge` + `adversarial` cases.
- **conformance** (0–1) — fraction of *structural* checks that passed across all outputs.

```
weights       = { behavioral: 0.45, robustness: 0.30, promptQuality: 0.25 }
quality_block = weighted mean of the pillars present (renormalize over present ones)
score         = round(quality_block × conformance)   // conformance multiplies; never just subtracts
any safety check fails  →  score = 0                  // a hard gate
```
A structural failure (wrong type, invalid JSON, missing field) *caps* the score
through the multiplier — that's the point, not a deduction. Missing pillars
renormalize; prompt-quality-only is a **provisional** score, and you say so. The
score is normalized to the prompt's own contract, so it means "how well does this
do its declared job" and is comparable across very different prompts.

Report a **confidence band** (`84 ±3`): wider with output variance and thin
coverage, tighter otherwise; levels `provisional | low | medium | high`. Judge
model fixed, temperature 0. Cache by `(promptHash, input, model, judgeVersion)`.

Check types (declarative serializable data run by an interpreter — never functions,
so they can live in YAML): `output_present`, `output_kind`, `json_valid`,
`required_keys`, `max_length`, `min_length`, `banned_content` (a safety check).
Derive the default set from the contract's output.

Ship a **conformance fixture suite** — input pillars → expected score — so anyone
can prove a re-implementation matches. Pin this worked example as a test:
`promptQuality 88, behavioral 82, robustness 71, conformance 0.93 → 75`.

## The contract (the spine)

Each prompt declares what it takes and returns. This decides which checks apply,
which models are eligible, and which judge runs.
```yaml
contract:
  intent: "Turn a meal name into a structured recipe"
  input:  { type: text, description: "a meal name" }       # text|image|number|boolean|enum|json
  output:
    kind: structured                                        # text | structured | image | video
    description: "a recipe object"
    jsonSchema: { type: object, properties: { ingredients: {type: array}, steps: {type: array} }, required: [ingredients, steps] }
```
For `structured`, the schema is required and generates the `required_keys` checks.
`image` output → only image-capable providers and a vision judge.

## Config & tests

`mowa.eval.yml`:
```yaml
version: 1
standard: "2.0"
defaults: { reference_model: google:gemini-2.5-flash, judge: google:gemini-2.5-flash, samples_per_case: 1 }
plugins: ["@acme/mowa-eval-plugin-toxicity"]
prompts:
  - id: recipe
    file: prompts/recipe.md
    contract: { ... }
    tests: tests/recipe.jsonl
    checks: [{ type: max_length, max: 4000 }]
    threshold: { min: 80, max_regression: 8 }
```
`tests/recipe.jsonl`, one object per line:
`{"label","category":"typical|edge|adversarial","input","expectation"}`.

## Regression — stateless, through git

No database. On a PR, score the prompt at `HEAD` and at the base ref, and diff them.
Cache the base score (re-pay only when the base changes). If the contract changed
between refs, it's a breaking change — reset the baseline, don't cry regression. A
brand-new prompt has no base, so threshold-only.

## CLI
```
mowa init               scaffold config + a sample test
mowa generate <id>      synthesize tests → tests/<id>.jsonl (the user commits it)
mowa eval [id]          run + a clean tty report (no id = all)
mowa eval --reporter junit,sarif --base <ref>
```
Generators run only at `generate` time and write a committed file. **Never**
synthesize during scoring — the yardstick must stay fixed or "regression" means
nothing.

## GitHub Action
Inputs: `config`, `base-ref` (default the PR base), `fail-on`
(`regression,threshold` | `none`). Keys from env/secrets only — never logged, never
written to config. On a PR: score head vs base, post a humane comment (the score
and band, the pillar breakdown, the inputs that failed, the suggested fix), set the
check.

## Plugins
A plugin is an npm package default-exporting `definePlugin({...})`, listed under
`plugins:`. Five extension points: **providers** (bring your own model),
**generators** (how tests are made), **checks** (custom RBCs), **judges**
(text/vision/golden-file), **reporters** (Slack, dashboards). Built-ins are
themselves plugins; user ones override by id. Convention `mowa-eval-plugin-*`; npm
is the registry, no server.

## Modalities
`output.kind` switches the pipeline; the score formula stays identical across all of
them. Build the text path end to end; leave the vision judge + image provider as
honest, clearly-marked stubs with the interface in place.

## Build it in this order
core (+ fixtures) → config → providers + text judge → generators → cli → git
regression → action + reporters → plugin-sdk (re-express built-ins as plugins) →
vision/image stubs. Ship 1–7 as a working text prompt-CI before anything fancy.

## Out of scope
No server, database, telemetry, auth, or per-language SDKs. Keys only from env. If
you're tempted to reach for a hosted service, stop.

## Done means
`cd examples && npx mowa eval` runs end to end against a real sample prompt and
prints a real score; the core fixtures pass; the README makes a stranger want to
use it (what it is, install, the use cases, how to write a plugin); the Action is
ready to publish. It should feel finished, not scaffolded.
