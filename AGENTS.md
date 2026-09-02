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

These are mandatory design and review constraints, not labels to add without evidence.

1. **Single responsibility (SRP):** give each module one cohesive responsibility and reason to change; state its inputs, outputs, and exclusions. Keep domain decisions out of framework plumbing.
2. **Open/closed (OCP):** extend behavior through registrations, composition, strategies, and definitions, not central business-specific switch/if branches. A missing generic extension point requires an explicitly documented and approved lower-level refactoring design as specified below, not a feature-specific patch.
3. **Liskov substitution (LSP):** implementations must preserve the interface's behavioral contract, not just its signature. Do not strengthen preconditions, weaken postconditions, or violate invariants. Preserve specified failure, cancellation, timeout, resource-release, and side-effect semantics. Do not require callers to identify concrete implementations to compensate for contract violations. Split unsupported capabilities or declare them before selection; never fake success or silently do nothing. Verify substitutability with shared contract tests.
4. **Interface segregation (ISP):** expose small consumer-oriented contracts; do not force unrelated capabilities through empty implementations, oversized optional interfaces, or unexpected not-implemented errors.
5. **Dependency inversion (DIP):** high-level policy and low-level details depend on stable consumer-owned or neutral contracts. Contracts must not depend on concrete domain or adapter implementations. Select and inject cross-layer implementations at the composition root; keep interpretation of domain-specific data inside its domain package.
6. **High cohesion, low coupling:** keep related rules, state, and verification together; collaborate through public contracts, events, or controlled references. Avoid private-state access, circular dependencies, hidden shared mutable state, and abstraction layers with no demonstrated purpose.

### Mandatory Design Review Gate

Every new or materially revised design must document compliance with the rules above and explicitly disclose lower-level changes. Before changing a module, identify its inputs, outputs, and affected upstream/downstream consumers.

Apply these principles when choosing module boundaries, dependency direction, behavioral contracts, call chains, and state ownership in the design itself. A final checklist cannot compensate for conflicting design content. Resolve implementation-critical integration, cancellation/resumption, and registration decisions during design; keep diagrams, contracts, tests, and task scope consistent.

- In the overview, state **Lower-level/framework changes: none or present**; classify present changes as compatible extensions, breaking changes, or fixes. Use **not yet investigated** instead of claiming none when evidence is missing. Lower-level includes shared frameworks, task runtime, public contracts, strategy execution, atomics, adapters, storage, and configuration contracts regardless of directory names.
- Include **Design principle compliance**: explain SRP, OCP, LSP, ISP, DIP, and cohesion/coupling with actual boundaries, interface/file references, dependency direction, validation plans, and unresolved issues. For LSP, identify interchangeable implementations and their shared preconditions, postconditions, invariants, failure/cancellation behavior, and resource-release tests. Explain any genuinely inapplicable check; a checkbox is not evidence.
- Include a **Lower-level/framework change inventory**, even when the answer is none. For each change, identify repository/layer/module/file/symbol and owner; explain why current extension points and domain-only alternatives are insufficient; describe old/new contracts and compatibility; list affected callers, implementers, registrations, assembly points, and stored-data/configuration consumers; specify contract/substitution tests, regression and end-to-end coverage, migration and rollback plans or why they do not apply.
- Resolve principle violations and unknown lower-level impact before implementation. Obtain approval of the concrete design and its lower-level inventory. If implementation reveals an additional lower-level change, update the design and obtain approval for the expanded scope before making that change.
- Give each lower-level change a stable ID such as F01, referenced by implementation ownership and tests, with explicit approval status and evidence. Distinguish domain extensions, composition-root registration, and lower-level changes. New lower-level modules, shared fields, and behavioral-contract changes count even without editing an existing implementation. General feature intent or agreement on these rules is not approval of that inventory.
- At design time, provide validation plans rather than claiming tests passed. After implementation, record actual results. Matching signatures, successful compilation, or merely adding an interface does not prove LSP, OCP, or DIP compliance.

A capability should own a coherent domain lifecycle without merging observation, scheduling, execution, and persistence into one class. A closed lifecycle or a language-level closure does not replace the principles above.

### Mandatory Lower-level Refactoring: No Patchwork

Missing lower-level capabilities, incomplete contracts, or unsuitable implementations must be addressed through a bounded architectural refactoring. Incremental patchwork, symptom fixes, and "patch now, refactor later" proposals are prohibited.

**Separate task ownership is a prerequisite.** Business tasks own domain modules and use of existing, delivered public extension points only. Put every foundation gap in an independent refactor requirement and task, with evidence, required outcomes, affected consumers, and acceptance criteria. Independently design and approve that refactor; remove its implementation from the business design and explicitly block dependent integration. After contract delivery, complete and review the concrete integration mapping. An F label, pending-approval note, or approved business goal does not authorize foundation implementation within the business task.

Calling an existing registration method at the composition root is assembly; adding a generic hook, shared field/configuration contract, or changing lifecycle/semantics is foundation work. A new file or thin-adapter name does not change ownership. Missing contracts are integration blockers, not permission to invent temporary interfaces while coding. This separation also governs configuration additions and the change inventories above.

1. **Define the complete refactoring unit first.** Investigate the affected responsibility's call chains, implementers, state, and lifecycle; identify the root cause or missing capability and specify the target modules and contracts. Do not design backwards from isolated patches for the current feature or error.
2. **Do not hide deficiencies.** Business-specific branches, bypass execution, duplicated state, caller-side workarounds, swallowed errors, unjustified retries/tuning, and compatibility wrappers around broken contracts are not substitutes for refactoring. Do not keep a defective path while adding a feature-only alternative; renaming a workaround "adaptation" or "optimization" does not make it acceptable.
3. **Document replacement, not accumulation.** Each lower-level change inventory must identify the target architecture, old-to-new responsibility/interface mapping, migration of all affected callers and stored data/configuration, and removal of superseded implementations and temporary paths. Preserve valid contracted behavior; explicitly review breaking changes rather than using refactoring to evade LSP.
4. **Accept the target architecture, not a temporary state.** Complete the approved caller migration and remove superseded defective paths. Verify shared contracts, substitution compatibility, failure/cancellation/recovery, and end-to-end behavior, including other instances of the same defect class. Temporary patches, parallel fallback paths, and cleanup deferred to a future task are not completed delivery.
5. **Keep refactoring bounded and approved.** Cover the complete affected responsibility and contract, not unrelated modules or a whole-repository rewrite. Task decomposition and small commits do not authorize patchwork; implementation must follow one approved target design. Scope expansion needs approval. Schedule pressure, complexity, and urgency are not exceptions; do not hotfix first and document the design afterwards. Any emergency containment requires separate authorization and does not authorize temporary lower-level patches.

Business registration through a healthy extension point still follows OCP; do not manufacture unnecessary lower-level changes. Judge patchwork by unresolved root causes, responsibility boundaries, and contracts, not by changed-line counts, editing tools, or Git diff size.

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
