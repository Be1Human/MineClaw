# MineClaw Contributor Guide

This file defines the public working rules for people and coding agents contributing to MineClaw.

## Repository Boundary

This repository is the public MineClaw source tree. It contains product code, tests, benchmarks, and public contributor guides only.

**Allowed**

- Application source under `apps/`
- `test-case/` and `benchmark/`
- Public templates such as `.env.example`
- Public guides: `README.md`, this file, `CONTRIBUTING.md`, `SECURITY.md`, `.agents/`, and CI

**Not allowed**

- Task vaults (`.clawpm/`)
- Internal requirement or design docs (`docs/` belongs in the private workspace, not here)
- Real `.env` files, API keys, RCON passwords
- Local Minecraft servers, worlds, `local/`, `runtime/`, or a private overlay repo
- Runtime `data/`, logs, databases, agent memory, and caches

Do not add a private environment repository as a submodule or hard-code its location. Public source must remain cloneable by itself. Never force-add ignored private paths.

## Architecture Rules

1. Keep modules focused on one responsibility.
2. Depend on interfaces and events across module boundaries; do not embed product-specific behavior in framework plumbing.
3. Extend behavior through registrations and definitions instead of growing central switch statements.
4. Before changing a module, identify its inputs, outputs, and affected consumers.

## Change Workflow

1. Read the affected code, tests, and public documentation before proposing a change.
2. For a feature or defect, record the requirement, design, and test intent before implementation when the change is not a small documentation correction.
3. Keep a change scoped to one behavior or one public contract.
4. Run the relevant build and tests. Do not change tests merely to hide a product defect.
5. Document user-visible configuration or startup changes in the public guides.

## Local Development Safety

- Copy `apps/minecraft-companion/.env.example` to a local `.env`; never commit it.
- Treat any local Minecraft server as optional developer infrastructure. Only control a server explicitly configured for local testing.
- Do not print credentials, player identifiers, raw logs, or private URLs in issues, pull requests, screenshots, or test reports.
- Do not terminate processes by broad name matching. Resolve and verify the intended local process first.

## Validation

Run the narrowest checks that prove the change, then broaden coverage when shared behavior changes:

```bash
node scripts/check-release.mjs
cd apps/minecraft-companion && npm run build
cd apps/minecraft-companion/web && npm run build
cd apps/minefriend-site && npm run build
```

See [.agents/README.md](.agents/README.md) for reusable project skills.
