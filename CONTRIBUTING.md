# Contributing

## Before You Start

Work from a feature branch and keep each change focused. The runtime, tests, and public documentation are maintained in the same repository; do not add local operational state to source control.

## Local Rules

- Copy `.env.example` to `.env`; never commit the resulting file.
- Do not add Minecraft worlds, player data, RCON credentials, logs, databases, caches, build output, or agent-memory files.
- Keep third-party dependencies in package manifests. Do not vendor an upstream repository without a license review.
- Add or update focused tests when behavior changes.

## Validation

Run the checks relevant to your change before opening a pull request:

```bash
node scripts/check-release.mjs
cd apps/minecraft-companion && npm run build
cd apps/minecraft-companion/web && npm run build
cd apps/minefriend-site && npm run build
```

Backend behavior changes should also run the relevant `npm run test:v2` subset or the full suite when feasible.

## Pull Requests

Describe the user-visible result, affected modules, validation performed, and any follow-up work. Never paste credentials, private URLs, player identifiers, or raw production logs into the pull request body.
