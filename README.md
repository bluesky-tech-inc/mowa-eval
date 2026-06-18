# mowa eval

A test runner for prompts. Score them, and fail the pull request when one regresses.

Prompts are production code that everyone treats as throwaway text. `mowa eval`
runs your prompts against example inputs, scores how well each one does its job,
and in CI it blocks a merge when a change makes a prompt worse — the same way a
failing unit test would.

It's a CLI and a GitHub Action, not an SDK. It grades a *prompt file*, not your app
code, so it works in any repo, in any language. Nothing is hosted: git is the
history, your CI is the compute, your API key calls the model.

## Quick start

```bash
npx mowa-eval setup google <api-key>   # save a key to .env (gitignored)
npx mowa-eval init                     # find the prompts in your repo, scaffold a config
npx mowa-eval generate                 # write test cases for each
npx mowa-eval eval                     # run + see the score
```

You don't have to point it at anything. `init` reads your codebase with an **AI
agent**: it finds the prompts (standalone files and ones embedded in source),
names them, and infers each one's full contract — intent, input, and output shape.
Set a key first (any provider below); run `mowa scan` to preview what it finds.

```
Providers (set one key)
  GOOGLE_API_KEY      Google Gemini   google:gemini-2.5-flash
  OPENAI_API_KEY      OpenAI          openai:gpt-4o
  ANTHROPIC_API_KEY   Anthropic       anthropic:claude-sonnet-4-5
```

Pass `--no-ai` for a rough keyless heuristic pass, or `--sample` to start from a
blank example.

You commit two files per prompt plus one config:

```
prompts/recipe.md     the prompt
tests/recipe.jsonl    example inputs (the fixed yardstick)
mowa.eval.yml         the contract, thresholds, and which model to use
```

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
        with: { fetch-depth: 0 }      # needed so it can score the base branch
      - uses: mowa-dev/eval@v1
        with: { config: mowa.eval.yml, base-ref: ${{ github.base_ref }} }
        env:  { GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }} }
```

On a PR it scores the changed prompt and the version on the base branch, then
fails the check if the score dropped past `max_regression` or fell below `min`.

## Generating tests

```bash
npx mowa-eval generate recipe   # AI writes typical/edge/adversarial cases → tests/recipe.jsonl
```

Generated once and committed — never regenerated during scoring, so the yardstick
stays fixed and "regression" stays meaningful. You can also hand-write tests or
paste in real inputs from your logs.

## Use cases

- **PR gate** — block prompt regressions before merge.
- **Local loop** — `mowa eval recipe` while you iterate.
- **Non-engineers** — edit a prompt in the GitHub UI; the PR gets scored automatically.
- **Model migration** — `--model openai:gpt-4o` to compare candidates before switching.
- **Audit** — `mowa eval` scores every prompt; find your weakest.
- **Incident → regression test** — add the bad input to `tests/`, and it's guarded forever.

## Extending it

Providers (models), generators (how tests are made), checks (rules), judges
(grading), and reporters (output) are all pluggable. A plugin is an npm package
that exports `definePlugin({...})`; list it under `plugins:` in `mowa.eval.yml`.

## Development

```bash
pnpm install
pnpm test          # the standard's conformance fixtures
pnpm mowa eval     # run against examples/
```

MIT.
