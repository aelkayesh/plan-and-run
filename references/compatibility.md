# Compatibility and adapter scope

The generic workflow needs macOS or Linux, Node.js 22.13 or newer, Git with an existing HEAD, and a compatible authenticated Codex CLI. CLI argument parsing was checked against 0.167.0. New CLI versions can change output or session behavior; run the tests and a bounded task before relying on a new version. Windows is supported through WSL2 with Linux tools, authentication and project files in one distribution; see the [Windows guide](windows.md). Native Windows Node.js execution remains unsupported because process ownership and cleanup use POSIX primitives.

Preparation, dry-run and status do not call a model. Preflight also uses no inference: it inspects local readiness and writes a private report. It cannot prove remote authorization or available quota. It supports stored-login checks, selected provider environment credentials and one fixed Azure CLI user-auth shape. Arbitrary custom authentication commands, unsupported credential stores and unresolved repository provider/profile overrides stop with diagnostics. Preserve the existing authentication configuration when resolving a blocker; see the [authentication contract](runner-contract.md#preflight-background-ownership-and-results).

## Optional strict acceptance

The default legacy mode verifies completion records and declared checks. Strict mode additionally requires authored criteria, mappings, fixed parent-run checks and fresh model review. Neither is a proof of correctness.

The strict adapters are deliberately narrow and originated in a TypeScript/Next.js application workflow:

| Capability | Existing prerequisites |
| --- | --- |
| `npm-checks` | `npm test` is `vitest run`; `npm run check` is `tsc --noEmit`; local Vitest and TypeScript. |
| `production-build` | `npm run build` is `next build`; local Next.js and dependencies. |
| `synthetic-postgres` | `npm test` is `vitest run`; local Vitest, Docker daemon and preinstalled `pgvector/pgvector:pg17`; expected test fixtures. |
| `loopback-browser` | `npm run build` is `next build`; local Next.js, `playwright-core` and supported Chrome/Chromium; a package-specific harness. |

Optional Python dependencies and tokenizer data must already be available. No adapter installs packages or downloads dependencies. These adapters are not a general execution interface for arbitrary stacks. Start with legacy mode for a different stack and author meaningful package checks; adding a strict adapter requires a reviewed implementation change.

## Preserved identifiers

This release keeps tested compatibility identifiers from the originating TrialProof workflow:

- `TRIALPROOF_PYTHON` selects the Python interpreter where applicable.
- `TRIALPROOF_*` environment guards suppress originating-application behavior during isolated acceptance.
- Legacy SQL suite presets, schema markers and role labels remain in the synthetic PostgreSQL adapter.

These names are compatibility code, not bundled project data or credentials. New generic SQL suites use the documented `tests/acceptance/NN/` and fixture-marker convention. See [acceptance fixtures](../assets/runner/acceptance-fixtures.md) before selecting a strict profile. Renaming these identifiers without a migration could change existing behavior.

## Saved bundles

Generated bundles carry pinned runtime copies and do not depend on the installed skill afterward. A prepared repository can move before its first execution. Once execution starts, progress binds the canonical checkout; moving it or editing identity hashes is not a supported resume mechanism. Resumption inspects partial effects and retains accepted progress, cooldowns and budgets. It does not roll back prior effects.

An installed-skill update does not update existing bundles. Use the explicit, reviewed [runtime reconciliation](runner-contract.md#pinned-runtime-upgrades) process when an upgrade is necessary.
