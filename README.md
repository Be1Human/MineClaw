# MineClaw

MineClaw is an embodied Minecraft AI companion. It combines a Mineflayer bot, an LLM-driven decision loop, a local control console, and repeatable capability tests.

## Repository Scope

This repository contains product source code, public configuration templates, tests, benchmarks, and website source. It intentionally excludes private configuration, agent memory, operational logs, Minecraft worlds, player data, server binaries, caches, build output, and third-party source mirrors.

## Architecture

```text
Minecraft server <-> Mineflayer adapter <-> MineClaw runtime <-> LLM provider
                                          |
                                          +-> Local web console
                                          +-> Tests and benchmarks
```


## Prerequisites

- Node.js 22 or later
- A compatible Minecraft Java server for live bot operation
- An LLM provider account and API key, stored only in a local `.env` file

## Quick Start

1. Install the backend dependencies:

   ```bash
   cd apps/minecraft-companion
   npm ci
   ```

2. Create local configuration from the committed template, then set your own provider and server values:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Start the backend:

   ```bash
   npm run dev
   ```

4. In another terminal, install and start the control console:

   ```bash
   cd apps/minecraft-companion/web
   npm ci
   npm run dev
   ```

The companion requires a reachable Minecraft server. Server worlds, RCON credentials, and runtime data are deliberately not bundled with this repository.

## Website

The product site is a separate Vite project:

```bash
cd apps/minefriend-site
npm ci
npm run dev
```

## Quality Checks

```bash
node scripts/check-release.mjs
cd apps/minecraft-companion && npm run build
cd apps/minecraft-companion/web && npm run build
cd apps/minefriend-site && npm run build
```

## Security

Do not commit `.env` files, API keys, server credentials, local databases, logs, or Minecraft worlds. See [SECURITY.md](SECURITY.md) for the reporting and disclosure policy.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This repository currently has no open-source license grant; do not redistribute it until the project owner publishes a license.

## Agent-Guided Development

