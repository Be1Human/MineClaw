---
name: local-loop-test
description: Validate a MineClaw change through build, targeted tests, startup, observation, and recorded evidence.
---

# Local Loop Test

Use this workflow after a code or configuration change that affects runtime behavior.

## Loop

1. Build the affected package and run focused tests.
2. Start only the explicitly configured local backend and control console.
3. Confirm the expected endpoint or UI is available before exercising behavior.
4. Perform the smallest user-level action that proves the claim.
5. Observe the resulting state, output, or world change and record evidence.

Stop on the first failure that invalidates the scenario. Preserve the logs and state needed for diagnosis instead of repeatedly retrying. Never send paid model requests, change a world, or control a Minecraft server unless the user has explicitly authorized that action.
