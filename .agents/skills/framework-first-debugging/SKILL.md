---
name: framework-first-debugging
description: Diagnose MineClaw behavior by tracing the runtime flow before changing an implementation detail.
---

# Framework-First Debugging

Start with the system path, not the first suspicious line of code.

## Investigation Order

1. Define the observed behavior and the expected external result.
2. Map the flow: input or event, state update, planning, capability or action execution, verification, and user-visible output.
3. Identify the first stage whose observed state diverges from expectation.
4. Confirm the cause with a focused reproduction, code evidence, and a regression test.
5. Describe blast radius, severity, confidence, and any remaining uncertainty.

Do not hide a defect with a fallback, a swallowed error, or a test-only workaround. Fix the owning layer and keep the evidence attached to the change.
