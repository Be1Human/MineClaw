---
name: doc-style
description: Write MineClaw documentation from a clear conclusion down to reproducible detail.
---

# Documentation Style

Write for the next contributor first: state the conclusion, scope, and decision before implementation details.

## Structure

- Requirements: background, user goal, scope, acceptance criteria, and dependencies.
- Design: background, goals, current state, problems, implementation, risks, tradeoffs, and prioritized follow-up.
- Test material: system goal, end-to-end smoke path, focused checks, regression boundaries, and evidence.

Use diagrams only when they clarify a relationship that prose cannot explain concisely. Keep paths, commands, and configuration examples portable; never paste local credentials or private machine paths.

## Review Checklist

Verify internal links, code fences, headings, and terminology. A reader should be able to identify what changed, why it changed, how to validate it, and what remains outside scope.
