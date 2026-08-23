---
name: clawpm-project-workflow
description: Manage MineClaw work recorded in a local .clawpm task vault.
---

# ClawPM Project Workflow

Use this skill only in a repository that contains `.clawpm/clawpm.json`.

## Before Changing Task State

1. Read `.clawpm/AGENTS.md`, `clawpm.json`, and the related task files.
2. Inspect `git status --short -- .clawpm` and `git diff -- .clawpm`.
3. Stop when another contributor has changed the same task file and resolve ownership before editing it.

## Work Model

Build a result tree: one outcome root, phases or problem branches, and independently verifiable leaf tasks. Use `parent` for decomposition and `deps` only for execution order.

Claim only a leaf whose dependencies are satisfied. Record the claim, progress, test evidence, and append-only history in that task file. Use `active` during work, `review` after verification, and `done` only after the configured gates pass.

## Evidence

Every completion claim needs a command or observable action, its outcome, and the paths or logs needed to repeat it. Do not fabricate passing evidence or convert a failed test into a passing status.

## Boundaries

The vault is local project data. Do not create a separate task database, HTTP service, or token-based task API for it.
