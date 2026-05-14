# Release

Tag-triggered via `.github/workflows/release.yml`. The workflow verifies the tag matches both `public/manifest.json` and `package.json` before building.

## Steps

```bash
# 1. Bump the version (keeps manifest.json + package.json in lockstep)
npm run version <new-version>     # e.g. 0.3.0

# 2. Commit and merge to main via a PR
# 3. Tag main and push
git tag v0.3.0 && git push origin v0.3.0
```

The workflow builds, packages `miyo-capture-<version>-chrome.zip`, and attaches it to a GitHub release.

## Rules

- **Tag must match the manifest + package version exactly.** The workflow fails if they diverge.
- **Tag from `main`, not a feature branch.** The build checks out at the tag ref.
- **Don't manually edit the version in `manifest.json` or `package.json`** — always use `npm run version` so they stay aligned.
- **Increment monotonically.** Chrome's auto-update path silently ignores downgrades.

## Channels

Single channel for now — every tag is a public release. Add `-beta` / `-alpha` suffixes later if a staged rollout becomes needed; the workflow currently does not distinguish channels.
