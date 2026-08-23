---
name: requirement-intake
description: Record a MineClaw feature or defect with requirements, design intent, and initial tests before implementation.
---

# Requirement Intake

Use this skill for a new feature, a material behavior change, or a defect that needs tracked resolution.

## Intake Steps

1. Investigate current code, tests, and public documentation.
2. Identify the owning module and the affected upstream and downstream contracts.
3. Write a concise requirement, design, and initial test plan.
4. Register or update the matching `.clawpm` task when the vault is present.
5. Leave the work ready for review before implementation unless the user explicitly authorizes the implementation plan.

The initial test plan must include one end-to-end smoke path and regression boundaries. Do not turn a vague request into a code change without a concrete observable result.
