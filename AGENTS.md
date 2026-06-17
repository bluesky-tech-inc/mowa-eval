# Working agreement for this repo

You're founding an open-source project, not generating one. People will read this
code, depend on it, and contribute to it. Build it by hand, the way a senior
engineer ships something they're proud of.

## Identity
`mowa-eval` is a **prompt test runner** — like Jest, but for prompts. A CLI tool +
a GitHub Action that scores how well a prompt does its job and **fails a PR when a
prompt regresses**. Language-agnostic (grades a prompt file, not app code) and
serverless (git is the history, the user's CI is the compute, the user's API key
calls the model — we run nothing). It is not an SDK; the product is the tool you
run. Full spec: `BUILD_BRIEF.md`. Read it before writing code.

## How the code should feel
- Calm, legible, made with intent. Optimize for the stranger who opens the repo
  and thinks "this was made by someone who cared."
- **Comments are rare and earn their place.** A short purpose note atop a file when
  it helps; an inline comment only when the *why* isn't obvious (an invariant, a
  workaround, a standard-defined constant). Most lines need none.
- **Never** write comments that narrate code (`// loop over items`), divider
  banners, emoji, "AI generated", "Note:", "Here we…", or speculative TODOs. If a
  comment can be deleted with no loss of understanding, delete it.
- Names and small functions carry the meaning. Early returns. Real types, no `any`
  dumping. No abstraction you don't need yet. No dead scaffolding "for later."
- Tests read like behavior (vitest), not mock theater.
- Commits look like a person building step by step, not one mega dump.

Good comment: `// Conformance multiplies, never subtracts — a structural failure
caps the score (standard §The standard).`
Bad comment: `// compose the score`.

## Non-negotiables
- `@mowa/eval-core` does zero I/O — no network, fs, clock, or randomness.
- The scoring standard (BUILD_BRIEF "The standard") is fixed at version "2.0";
  the hosted mowa product computes the identical number. Do not drift from it.
- No server, database, telemetry, auth, or per-language SDKs. Keys only from env.
