---
name: minecraft-test-environment
description: Prepare an explicitly configured local Minecraft test environment for MineClaw validation.
---

# Minecraft Test Environment

Use this skill only for a server the contributor explicitly configured for local testing.

## Safety Rules

- Resolve the server directory from local configuration or an explicit user-provided path.
- Restrict control to loopback or a test server the user has explicitly approved.
- Never print, commit, or copy server credentials into reports, commands, or public documentation.
- Snapshot or document the initial scene before mutating a world.

## Workflow

1. Verify the server version, status, and local configuration.
2. Prepare a named, reproducible test scenario.
3. Hand the scenario to the runtime validation workflow.
4. Capture only the evidence required for the test result.
5. Restore or clean the scenario when the test is complete.

Actual server binaries, worlds, and runtime state belong in a private local environment, not in this public repository.
