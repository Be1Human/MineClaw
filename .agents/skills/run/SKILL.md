---
name: run
description: Start MineClaw's local backend and control console using contributor-owned local configuration.
---

# Run MineClaw Locally

If this checkout is the workspace private overlay (or the workspace root that contains `private/`), do not re-list startup checks here. Run the one-click script:

```powershell
.\Start-Dev.bat
# or
.\private\scripts\Start-DevEnvironment.ps1
```

That script starts the companion app (Hub + Web) and the imported Minecraft test server, skips ports that are already listening, and fails with the next command when local config or the test server is missing.

## Public-only clone

Copy `apps/minecraft-companion/.env.example` to a local `.env` and fill only your own server and provider values. Keep that file untracked.

```bash
cd apps/minecraft-companion
npm ci
npm run dev
```

```bash
cd apps/minecraft-companion/web
npm ci
npm run dev
```

The console reads optional Vite variables such as `VITE_BACKEND_URL` and `VITE_DEV_PORT`. Start the backend first, verify it is reachable, then open the Vite URL printed by the console.

Do not automatically start a game session or send bot commands as part of ordinary local startup.
