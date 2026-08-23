---
name: run
description: Start MineClaw's local backend and control console using contributor-owned local configuration.
---

# Run MineClaw Locally

## Prerequisites

Copy `apps/minecraft-companion/.env.example` to a local `.env` and fill only your own server and provider values. Keep that file untracked.

## Start Order

In one terminal:

```bash
cd apps/minecraft-companion
npm ci
npm run dev
```

In another terminal:

```bash
cd apps/minecraft-companion/web
npm ci
npm run dev
```

The console reads optional Vite variables such as `VITE_BACKEND_URL` and `VITE_DEV_PORT`. Start the backend first, verify it is reachable, then open the Vite URL printed by the console.

Do not automatically start a game session or send bot commands as part of ordinary local startup.
