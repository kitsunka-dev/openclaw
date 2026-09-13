---
summary: "Configure a Claude Code on the web cloud environment so pnpm install and pnpm check succeed for this repo"
read_when:
  - You are setting up a Claude Code on the web cloud environment for this repo
  - pnpm install fails with an HTTP 403 fetching a git-tarball dependency
  - A cloud session cannot push branches to GitHub
title: "Cloud dev environment setup"
---

# Cloud dev environment setup

This repo installs cleanly with `pnpm install` locally, but a fresh Claude Code on the web cloud environment needs a few settings changed from the defaults before `pnpm install` and `pnpm check` succeed inside it. This page is the checklist.

## Why the default environment is not enough

The Trusted network access level allows common package registries and github.com/codeload.github.com by default. Two things still commonly break a fresh cloud environment for this repo:

- The environment's actual allowlist can differ from the documented Trusted defaults depending on how the environment was created. If `pnpm install` fails with `ERR_PNPM_FETCH_403` on `codeload.github.com` (a `@whiskeysockets/baileys` transitive dependency, `@whiskeysockets/libsignal-node`, resolves from a git tarball there), the environment needs an explicit Custom allowlist.
- Pushing a branch back to GitHub needs the Claude GitHub App installed and scoped to this specific repository. It is easy to have the App installed but scoped only to a different repository, which fails pushes with a 403 that looks unrelated to network access.

## Configure the environment

In the environment settings on [claude.ai/code](https://claude.ai/code) (open the environment picker above the message box, then edit the environment):

1. Set **Network access** to `Custom`.
2. Check **Also include default list of common package managers**. Without this, `registry.npmjs.org` itself gets blocked and `corepack enable` fails before `pnpm install` even starts.
3. Leave **Allowed domains** empty, or add `github.com` and `codeload.github.com` explicitly if you want to be safe against the default list not covering them.
4. Set **Setup script** to:

```bash
#!/usr/bin/env bash
set -euo pipefail
set -x

for root in "${CLAUDE_PROJECT_DIR:-}" "$HOME" /workspace /repo "$PWD"; do
  [ -n "$root" ] || continue
  hit=$(find "$root" -maxdepth 3 -name package.json -not -path "*/node_modules/*" -print -quit 2>/dev/null || true)
  if [ -n "$hit" ]; then
    cd "$(dirname "$hit")"
    break
  fi
done

pwd
corepack enable
pnpm install
```

The loop exists because the working directory the setup script starts in is not guaranteed to be the repository root across environments; it has been observed as `$HOME` on one run and `/root` on another. The loop finds the checkout instead of assuming a fixed path.

5. Save. The setup script only runs once per environment; after that the filesystem (including `node_modules`) is snapshotted and reused, so later sessions start fast.

## Grant push access

Separately from the environment, the Claude GitHub App needs read/write access to this specific repository:

1. Open [github.com/settings/installations](https://github.com/settings/installations) and find the **Claude** app.
2. Under **Repository access**, confirm this repository is selected (not just other repositories in the same account/org).
3. Save.

Without this, cloud sessions can clone and run `pnpm install`/tests fine, but pushing a branch fails with a 403 that is easy to mistake for a network access problem.

## Verifying the setup

Start a new session in the configured environment and ask it to run `pnpm install`, then a single test file, then `pnpm check`. All three should complete without touching the network access or GitHub App settings again. If `pnpm check` is slow, that is expected on the first run in a fresh environment; the tsgo build cache warms up and later runs are faster.
