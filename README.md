# mowa eval

A test runner for prompts. Score them, and fail the pull request when one regresses.

Prompts are production code that everyone treats as throwaway text. `mowa eval`
runs your prompts against example inputs, scores how well each one does its job,
and in CI it blocks a merge when a change makes a prompt worse — the same way a
failing unit test would.

It's a CLI and a GitHub Action, not an SDK. It grades a *prompt file*, not your app
code, so it works in any repo, in any language. Nothing is hosted: git is the
history, your CI is the compute, your API key calls the model.

## Install

```bash
npx mowa-eval <command>        # no install
npm i -g mowa-eval             # or install the `mowa` binary globally
```

## Quick start

```bash
mowa setup google <api-key>   # save a key to .env (gitignored)
mowa init                     # find your prompts, scaffold mowa.eval.yml
mowa generate                 # write test cases for each prompt
mowa eval                     # score them
```

You don't point it at anything. `init` reads your codebase with an **AI agent**: it
finds the prompts (standalone files *and* ones embedded in source), names them, and
infers each one's full contract — intent, input, and output shape — into
`mowa.eval.yml`. Prompts embedded in code are copied into `prompts/<id>.md` so they
can be versioned and graded.

## Commands

### `mowa setup <provider> <key>`
Save an API key to a local `.env` (and add `.env` to `.gitignore`). Every command
auto-loads `.env`, so you set a key once.
```bash
mowa setup google AIza...        # provider: google | openai | anthropic
mowa setup --openai sk-...        # flag form
```

### `mowa scan`
Preview the prompts in the repo without writing anything. With a key, an AI agent
reads the candidate files and reports each prompt's name and intent.

### `mowa init`
Scaffold `mowa.eval.yml` from the discovered prompts (and lift embedded prompts
into `prompts/*.md`). Prints the ids it created. Refuses to clobber an existing
config unless you pass `--force`.

### `mowa list` (alias `ls`)
List the prompts and ids in `mowa.eval.yml` — offline, no key, no model calls.
```
2 prompts in mowa.eval.yml:
  recipe     prompts/recipe.md · structured · 6 tests
  classify   prompts/classify.md · text · no tests
```

### `mowa generate [id]`
Synthesize test cases (typical / edge / adversarial) for one prompt, or all of them
if you omit the id, and write them to `tests/<id>.jsonl`. Generate once and commit
them — they are **not** regenerated during scoring, so the yardstick stays fixed.
```bash
mowa generate            # all prompts
mowa generate recipe     # one (id = the name from `mowa list`)
```

### `mowa eval [id]`
Run each test input through the prompt, score it, and print a report. Exits non-zero
when a prompt is below `min` or has regressed past `max_regression`.
```bash
mowa eval                       # score all prompts (absolute)
mowa eval recipe                # score one
mowa eval --base main           # regression: compare to a git ref; only scores changed prompts
mowa eval --base main --all     # regression across every prompt
```

## Options

| Flag | Commands | Meaning |
|---|---|---|
| `--config <path>` | all | Config file (default `mowa.eval.yml`) |
| `--model <id>` | scan, init, generate | Model for discovery/generation (default `google:gemini-2.5-flash`) |
| `--base <ref>` | eval | Compare to a git ref for regression; scores only the prompts whose files changed |
| `--all` | eval | With `--base`, score every prompt, not just changed ones |
| `--force` | init | Overwrite an existing `mowa.eval.yml` (and lifted prompt copies) |
| `--no-ai` | scan, init | Heuristic only — no key, no model calls (contracts come out blank) |
| `--sample` | init | Start from a blank example instead of your prompts |
| `--help`, `-h` | — | Show help |

## Providers & keys

Set one key (bring your own — used to find prompts, generate tests, and judge):

| Env var | Provider | Example model |
|---|---|---|
| `GOOGLE_API_KEY` | Google Gemini | `google:gemini-2.5-flash` |
| `OPENAI_API_KEY` | OpenAI | `openai:gpt-4o` |
| `ANTHROPIC_API_KEY` | Anthropic | `anthropic:claude-sonnet-4-5` |

Pick a model with `--model <provider:model>`. A real env var always wins over `.env`.

## `mowa.eval.yml`

The entry point. One block per prompt.

```yaml
version: 1
standard: "2.0"                       # the scoring standard this file targets
defaults:
  reference_model: google:gemini-2.5-flash   # model the prompt is scored on
  judge: google:gemini-2.5-flash             # model that grades outputs
prompts:
  - id: recipe                        # used by `generate <id>` / `eval <id>`
    file: prompts/recipe.md           # the prompt text
    tests: tests/recipe.jsonl         # the test cases
    contract:
      intent: Turn a meal name into a structured recipe
      input:  { type: text, description: a meal name }   # text|image|number|boolean|enum|json
      output:
        kind: structured              # text | structured | image | video
        description: a recipe object
        jsonSchema:                   # required for structured; drives the required-keys check
          type: object
          properties:
            ingredients: { type: array }
            steps:       { type: array }
          required: [ingredients, steps]
    checks:                           # optional extra rule-based checks
      - { type: max_length, max: 4000 }
      - { type: banned_content, patterns: ["<script"] }   # a safety check
    threshold:
      min: 70                         # fail below this
      max_regression: 8              # fail if it drops this many points vs --base
```

Test files are JSON Lines, one case per line:
```json
{"label":"common dish","category":"typical","input":"lasagna","expectation":"valid JSON recipe with quantities"}
```
`category` is `typical` (→ behavioral pillar) or `edge`/`adversarial` (→ robustness pillar).

## The score

One number, 0–100, with a confidence band — how well the prompt fulfills its
declared contract. It composes four signals: a static read of the prompt, its
behaviour on typical inputs, its robustness on edge/adversarial inputs, and a
structural-conformance multiplier (valid JSON, required fields, safe output). A
structural failure caps the score; a safety failure zeroes it. The formula is
published and versioned, so this tool and hosted mowa produce the identical number.

## In CI

```yaml
# .github/workflows/prompts.yml
on: pull_request
jobs:
  prompts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }      # full history so it can score the base branch
      - uses: bluesky-tech-inc/mowa-eval@v1
        with: { config: mowa.eval.yml, base-ref: ${{ github.base_ref }} }
        env:  { GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }} }
```

On a PR it scores the prompts that **changed** against the base branch and fails the
check if a score dropped past `max_regression` or fell below `min`. It's the same
`mowa eval --base` you can run locally — the Action just runs it for you.

## Use cases

- **PR gate** — block prompt regressions before merge.
- **Local loop** — `mowa eval recipe` while you iterate.
- **Open a PR** — a prompt change (from anyone) gets scored automatically; reviewers see the number.
- **Model migration** — `--model openai:gpt-4o` to compare candidates before switching.
- **Audit** — `mowa eval` scores every prompt; find your weakest.
- **Incident → regression test** — add the bad input to `tests/`, and it's guarded forever.

## Extending it

Providers (models), generators (how tests are made), checks (rules), judges
(grading), and reporters (output) are all pluggable. A plugin is an npm package
that exports `definePlugin({...})`; list it under `plugins:` in `mowa.eval.yml`.

## Development

```bash
npm install
npm test           # the standard's conformance fixtures
npm run mowa eval  # run against examples/
```

MIT.
