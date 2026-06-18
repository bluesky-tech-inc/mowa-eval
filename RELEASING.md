# Releasing

`mowa-eval` ships in two places: the **npm package** (the `mowa` CLI + what the
Action runs) and the **GitHub Action** (`bluesky-tech-inc/mowa-eval@v1`). The Action
is a thin wrapper that runs `npx mowa-eval`, so publishing to npm is the real step.

## One-time setup

1. An npm account with publish rights to the `mowa-eval` name.
2. Add an npm automation token as the repo secret `NPM_TOKEN`
   (Settings → Secrets and variables → Actions).

## Cut a release (automated)

```bash
npm version patch        # or minor / major — bumps package.json + commits a tag
git push --follow-tags
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which runs the tests,
builds, and `npm publish`es. After it succeeds, move the major tag so
`@v1` keeps pointing at the latest v1.x:

```bash
git tag -f v1 && git push -f origin v1
```

## Cut a release (manual)

```bash
npm login
npm version patch
npm publish              # prepublishOnly builds dist first
git push --follow-tags
git tag -f v1 && git push -f origin v1
```

## Verify

```bash
npx mowa-eval@latest --help
```

And in any repo's workflow: `uses: bluesky-tech-inc/mowa-eval@v1`.

## Marketplace listing (optional)

GitHub → the repo → the `release.yml`/`action.yml` → "Publish this Action to the
Marketplace" on a release. Requires the repo to be public (it is) and `action.yml`
to have a name, description, and branding.
