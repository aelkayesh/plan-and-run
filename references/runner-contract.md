# Sequential Codex execution contract

The runner executes one package at a time, resumes interrupted conversations and advances only after validating completion records. Requirements: macOS/Linux (including [Windows through WSL2](windows.md)), Node.js 22.13+, Git with an existing HEAD, and authenticated Codex CLI. Existing model/provider configuration is used unless overridden; worker calls consume its quota or API budget.

## Commands

```bash
node /path/to/repository/docs/implementation-plans/feature/run.mjs dry-run
node /path/to/repository/docs/implementation-plans/feature/run.mjs preflight --from 01 --to 02 --json
node /path/to/repository/docs/implementation-plans/feature/run.mjs start --from 01 --to 02
# When unattended execution is requested:
node /path/to/repository/docs/implementation-plans/feature/run.mjs launch --from 01 --to 02 --json
node /path/to/repository/docs/implementation-plans/feature/run.mjs status --json
node /path/to/repository/docs/implementation-plans/feature/run.mjs logs
node /path/to/repository/docs/implementation-plans/feature/run.mjs stop --session SESSION_UUID --json
```

`resume` equals foreground `start`, and omitting the subcommand retains foreground `start` as the default. Ctrl+C/SIGTERM stops the worker and saves progress; use the same command and selected range again. Explicit `launch` detaches from terminal stdio only after full-range preflight and durable ownership under the shared plan lock. It does not install a persistent service. Closing the launching terminal does not define completion; the saved result and accepted evidence do.

Controls include `--step NN`, `--from NN --to NN`, `--model`, `--profile`, `--timeout-minutes`, `--progress-seconds` and `--codex-bin`. See `--help` for current defaults. Generated wrappers pin repository and manifest. `--step NN --fresh-session` explicitly replaces the unfinished step's active conversation, including its current subdivision actor, while retaining files, history, budgets and cooldown.

Implementation workers use `workspace-write`; subdivision planners use `read-only`. Both use `approval_policy="never"`. The planner returns structured JSON and the CLI writes its output file. The runner never bypasses sandbox restrictions, copies credentials or changes providers to avoid quotas. CLI parsing was checked against 0.167.0; JSONL, structured output and session resumption follow [OpenAI Docs](https://learn.chatgpt.com/docs/non-interactive-mode).

## Preflight, background ownership and results

`preflight` resolves the exact selected range, verifies accepted evidence, checks prerequisites before the range and collects required capabilities across its unfinished executable prefix. Earlier unfinished packages inside the range are planned predecessors. The first explicit manual package stops execution; if the requested range includes it, that range remains unfinished. Every package number is ordinary unless `manual:true`. Already accepted packages require no new host capability execution.

Preflight uses the selected Codex executable/profile for local authentication readiness without inference, login mutation or credential output. Readiness is not a remote authorization or billing guarantee. Fixed capability checks inspect existing scripts/dependencies, local Docker/image and installed browser as applicable; they never download tools, start feature workers or create acceptance fixtures. Future package mappings/test files remain implementation deliverables. Missing prerequisites and changed frozen/runtime/configuration identities produce actionable reports before the first worker. Launch rechecks protected identities under the execution lock before announcing readiness.

Local authentication checks support configured credential presence and the selected stored-login method. The fixed Azure CLI adapter recognizes `az account get-access-token` with an explicit HTTPS `--resource`, UUID `--subscription`, `--query accessToken` and `-o tsv` or `--output tsv`. It inspects the installed helper identity and the existing AzureCloud user profile/plaintext MSAL cache for a unique matching account and refresh credential. It never executes `az` or another auth command, refreshes a token, decrypts storage, changes credentials or contacts a provider. `ready` means matching local inputs exist; token validity, expiry/revocation and remote authorization remain unverified. Unknown command shapes, absent helpers/caches, ambiguous accounts, encrypted stores and custom cloud endpoints stop with an explicit action. Selected file profiles are supported; repository-level provider/profile overrides stop when the CLI's effective trust and precedence cannot be established safely. Preserve the existing configuration when resolving a blocker.

`launch` returns a stable session UUID and result location. Foreground and background runs share the same plan lock; another live runner/worker or unknown ownership prevents a duplicate. Private session records bind the repository, frozen plan/runtime/policy, selected range and execution options. Session history is retained under `.codex-plan-runner/<plan-id>/background/<UUID>/`; selecting the latest session does not replace history. Human/JSON results and `logs` are redacted presentation surfaces. Private session/control records and forensic logs may contain sensitive material and must not be published; ownership tokens are omitted from public output.

`status --json` reports execution phase, selected packages, accepted versus unfinished criteria/gates, current blockers, retry deadlines/budgets and evidence/result locations. Earlier failure reports remain historical after recovery. Liveness or a zero worker/supervisor exit never completes a selected range with missing acceptance. Use `--session UUID` with `status`, `logs` or `stop` to address a retained session; omission selects the latest session.

`stop` sends a fresh ownership challenge to the recorded live runner and requests cooperative cancellation. The runner cancels its separately owned worker/acceptance groups, reconciles owned fixtures, saves interruption and releases the plan lock. Success requires observed exit and cleanup. A stale/reused PID or unresponsive/unverifiable owner is refused rather than signalled speculatively; inspect its durable ownership diagnostics before retry. Stopping never clears accepted receipts, partial files, cooldowns or budgets.

On macOS the background runner journals an owned `/usr/bin/caffeinate -i -w` helper tied to the runner lifetime, confirms startup liveness, and verifies cleanup on completion/failure/stop. Unexpected assertion loss aborts work and prevents a successful result; uncertain ownership, journal storage or cleanup remains unresolved. Other platforms receive no macOS assertion. This inhibits idle system sleep only; there is no automatic restart after reboot and no promise of survival across poweroff or closed-lid sleep. Authentication/services must remain available, and finite retry budgets still stop with unresolved diagnostics.

## Recovery and durable budgets

Normal `start`/`resume` attempts eligible recovery automatically. A separate sandboxed supervisor classifies implementation defects, prerequisite source defects, environment restrictions or genuine external blockers. It inspects partial effects, may repair in-scope source, and returns a strict recovery decision: `resume`, `host-check` with a recipe ID, `acceptance-check` for the existing strict package profile, or `blocked` with an actionable reason. It cannot finish a package, change acceptance, install dependencies, edit credentials/npm scripts, alter scheduling/runtime, rewrite accepted artifacts or authorize arbitrary host commands. Corrections to prerequisite source belong to the current package and additive recovery notes; accepted predecessor evidence remains unchanged.

- Rate retries use provider-aware backoff and persist cooldowns/counts. `--max-rate-retries` defaults to **8**; `0` explicitly opts into unlimited retries. Finite values remain exhausted on restart.
- `--tpm-threshold 2` requires two consecutive explicitly classified TPM-failed attempts by the current actor before subdivision or session rotation. Repeated reconnect notices within one attempt count once. An explicitly oversized per-minute token request can reach this gate in one attempt.
- `--max-session-rotations 3` bounds fresh retry sessions within the single subdivision. Zero permits no such rotation; explicit increases are capped at 100. The initial planner, each first subtask session and the first finalizer session are distinct from these retry rotations.
- `--max-transport-retries 8` bounds transport/timeout continuations. Transport reconnects use a 10-second local base plus positive jitter, capped at 30 seconds; smaller `--retry-delay-seconds`/`--max-delay-seconds` values also apply. Explicit provider retry minima still take priority, and saved deadlines are retained across restarts. Rate-limit backoff keeps its separate 60-second base and 900-second default cap. Unexpected worker termination retains generic signal classification.
- `--max-repair-retries 3` bounds supervisor cycles; `--max-no-progress 2` stops repeated unchanged diagnostic/source failures.
- `--max-evidence-refreshes 2` bounds stale evidence/host-timeout retries. `--host-timeout-minutes 30` bounds each automatic host phase.
- These counters, phase, actor conversations, decisions, retry deadlines, subdivision checkpoints and pending evidence survive restart. Explicit larger CLI budgets permit more work without resetting history. `--no-recovery` disables subdivision, supervisor, transport and automatic host recovery.
- One missing worker session may receive a fresh replacement only after preserving a partial-source inventory. Authentication, billing, configuration, unknown authority/services, tampering and exhausted budgets stop with durable `needs-attention.json`; `status` shows phase, counters and exact next action.
- `manual: true` stops with exit 2 before that package, independent of its number. Preserve selected `--step` or `--from/--to` boundaries.

The frozen manifest's `recovery` configuration selects host recipes per package. Without a host recipe, sandbox source repair remains available. The generic recovery recipe is `npm-checks`: fixed argv `npm test` and `npm run check`. Strict acceptance independently selects the fixed npm/build/synthetic-PostgreSQL/loopback-browser capabilities described below; these are not additional supervisor recipe strings. The parent verifies the strict recipe selection; it never executes supervisor-supplied commands. Existing npm scripts/config, credentials and dependencies are guarded before/after every phase. `host-check --step NN` is an explicit capture for an already authorized recipe; normal recovery needs no separate invocation.

Automatic host validation journals exact helper/process-group and fixture ownership before mutation, supports SIGINT/SIGTERM/timeout cleanup, and reconciles owned identities after a hard crash without killing/deleting unknown resources. Failed evidence is preserved. Children receive a fresh `CODEX_PLAN_DATA_DIR` and scrubbed credential variables. Scripts must respect that fixture convention. Environment scrubbing is not a security sandbox and does not itself prevent external effects. Strict acceptance has separate fixed synthetic PostgreSQL and loopback browser adapters, selected only by its frozen profile. There is no deployment or dependency installation recipe.

Automatic host evidence binds source/config/environment/dependencies, fixed argv, actual logs, successful checks and verified fixture cleanup. Explicit synchronous `host-check` retains compatibility capture semantics: it binds source, fixed commands and logs, but does not provide the automatic path's environment/dependency binding, cancellation journal or verified cleanup. Prefer automatic recovery for those guarantees. The resumed worker must explicitly cite `host_validation:{file,sha256}` and `origin:"host-validation"` for every reused check. Source changes require bounded evidence refresh. Host success never completes a package; original completion checks still apply.

## TPM subdivision and checkpoints

Only explicit tokens-per-minute pressure can trigger subdivision, and only for a package whose frozen recovery configuration permits local repair. Ordinary RPM throttling, generic temporary rate errors, context-window limits, authentication, billing and configuration errors do not trigger it. Provider cooldowns are honored before a fresh planner or retry session starts, including after interruption. A rate error alone does not demonstrate an implementation defect. Context capacity and TPM quota are separate; the runner does not switch models/providers automatically. Future model selection, including an Azure configuration, requires a separate user decision and is outside this recovery path.

The runner records a compact partial-work inventory, prioritizing dirty files and linking the failed attempt. Pre-existing user changes remain protected; inventory membership does not establish ownership. The inventory includes at most 60 dirty files and records truncation, so workers must inspect current Git status when necessary. One fresh read-only planner proposes 2–6 sequential subtasks for only the remaining original scope. Strict planner output binds the package, attempt, subdivision and source identities. Planner checks are descriptions for later workers; the parent never executes planner-supplied commands or argv.

Each subtask starts an independent conversation with the original contract and compact checkpoint references. It inspects partial changes and unknown effects before repeating actions, implements only its bounded scope, and returns `checkpointed`, `blocked` or `failed` through a separate schema. Its JSON checkpoint records `schema_version`, `package_id`, `attempt_id`, `subdivision_id`, `subtask_id`, `summary`, `source_sha256`, `changed_files`, actual `checks`, `blockers` and `next_steps`. The result binds that file and its SHA-256. The parent checks canonical repository-relative paths, rejects symlinks, and verifies identities, source and passing checks before accepting a checkpoint. Planner/subtask output cannot write or stand in for the final package receipt and handoff.

Accepted checkpoints and successful output hashes survive restart. The runner reconciles saved results before launching another attempt and skips accepted subtasks. Historical source hashes remain evidence after later subtasks edit source; they are not claims about the final source. Unknown effects and unfinished attempts remain explicit inspection obligations. Repeated TPM pressure inside this single subdivision may rotate the active session within its cumulative budget, but cannot recursively split or replan. Supervisor and approved host phases return to the saved actor, preserving accepted work and all retry budgets.

Between accepted subtasks, historical host evidence remains hash-verified but may be deferred while later subtasks change source. It is not supplied as current proof. An explicit host-check request or finalization requires current evidence and uses the existing bounded refresh budget. Deferral never clears the pending host obligation or resets counters.

After the last accepted subtask, a **fresh finalizer** receives the original package contract and compact checkpoints. It must run the original final acceptance checks and produce the ordinary validation receipt, handoff and final result below. A checkpoint or a set of passing subtask checks never completes its parent. Frozen acceptance, selected ranges, predecessor receipts, manual boundaries and manifest host-recipe authority remain unchanged. Ordinary two-digit package IDs, including `15`, have no implicit manual status.

`status` reports subdivision phase, accepted-subtask progress, explicit TPM attempts, rotation usage and the exact next action. Exhaustion remains durable across restart and produces `needs-attention.json`; raising a budget does not erase prior attempts, files, checkpoints or cooldowns. These structural and hash checks do not independently establish semantic correctness; the original acceptance remains required.

## Pinned runtime upgrades

All phases check the frozen plan and worker contract, runtime/policy identities, accepted artifacts and parent-owned state revision. `status`/`dry-run` report runtime mismatch without changing state; normal execution fails closed. Generation and ordinary resume never silently accept changed runtime authority.

For an explicitly requested runtime replacement, stop all users of that runtime, review the replacement and saved work, then run:

```bash
node docs/implementation-plans/feature/run.mjs runtime-prepare --runtime-review-note path/to/review.md
# Inspect the immutable proposal, exact file inventory and printed SHA-256.
node docs/implementation-plans/feature/run.mjs runtime-apply --proposal .codex-plan-runner/feature/runtime-upgrades/ID-proposal.json --proposal-sha256 REVIEWED_SHA256
```

The review note must be an existing nonempty repository file. Prepare binds source/config, prior state, historical logs, accepted artifacts and current runtime. Apply archives the old state and records the reviewed proposal before updating only runtime/policy identities, audit history and revision. It preserves package entries, sessions, budgets and accepted evidence; no worker or host recipe runs. Changed inputs invalidate the proposal. Workers/supervisors may inspect status, but cannot invoke these parent commands. An upgrade does not authorize dependency installation or changed npm shell recipes.

## Parent acceptance handoff and finalization

For a nonmanual package with an existing strict profile, an implementation worker or original-package finalizer may return `status: "acceptance-ready"` using the ordinary result schema, required artifact paths and an empty `blockers` array. The implementation and complete criterion-to-test mapping must be ready for parent evaluation. Final validation/handoff files need not exist yet; preserve partial records and do not claim deferred checks passed. Configured parent gates that cannot run inside the worker sandbox are deferred checks, not external blockers. Missing prerequisites, services, permissions and decisions remain genuine blockers.

After inspecting a truthful blocked worker, a supervisor may explicitly request `action: "acceptance-check"`, `classification: "environment"`, `recipe_id: null` and no blockers. This selects only the current frozen strict profile; it does not select or authorize a legacy host recipe. The request cannot contain commands, argv, environments or overrides. Legacy/no-profile and manual packages cannot use either handoff, and arbitrary blocked prose is never converted automatically.

The parent persists the hash-bound request and original worker/finalizer actor before entering its acceptance phase. It resumes mapping review, configured fixed gates and evidence review through the existing acceptance lifecycle after interruption. Current evidence is reused only after source/cleanup verification. Failed gates return to bounded source repair; source drift, evidence refresh, timeout, provider, protocol and no-progress counters remain cumulative. Repeated handoffs after current passing evidence do not permit unlimited finalization attempts.

Passing parent gates resumes the saved original worker/finalizer with exact evidence references. That actor reads and attributes the actual parent checks, runs remaining checks and writes a current truthful final receipt/handoff/result. Parent acceptance alone never completes a package. Before advancing, the parent validates those completed artifacts and verifies fresh acceptance for their current source. Source changes can require a bounded evidence refresh.

## Receipt and final result

Strict acceptance profiles add parent-owned verification before these receipt checks can complete a package. Frozen `required_gates` and criterion IDs/types/purposes are authority; `NN-acceptance-mapping.json` is a proposal containing only gate files/cases and criterion-to-test references. Every required criterion/gate pair must have actual passing evidence from an authorized fixed adapter. Missing files, omitted criteria, required skipped cases, stale source, changed evidence, unverified cleanup or negative semantic review prevent completion. Worker exit zero and optimistic receipt prose do not bypass these checks.

The portable runtime includes `acceptance-fixtures.md` with exact marker fields, browser exports, report enumeration and cleanup rules. Protocol corrections use a separate default two-retry budget and preserve rejected bytes/sessions. Acceptance refreshes charge once per changed input generation; verified-clean timeouts have a separate bounded counter. Both survive restart and budget increases retain evidence.

The fixed capability classes are existing local npm tests/typechecking, isolated production build without installation, owned synthetic PostgreSQL from a preinstalled image, and loopback browser evidence with an installed browser. Parent execution is journaled and source-bound; worker mappings cannot select command strings, environments, remote addresses or arbitrary resource paths. Independent fresh read-only review sees original requirements, source changes, real assertions and compact evidence references. A model-reviewed verdict is engineering evidence with explicit limits, not a mathematical guarantee.

Legacy manifests without an acceptance profile retain legacy receipt verification. They do not gain the stronger claim merely by loading a newer runtime. Existing completed package entries and historical receipts are verified using their saved evidence, without inventing new obligations or rerunning them. Package numbers have no special meaning; only an explicit manual flag creates a manual boundary.

The prompt supplies `PACKAGE_ID` and unique `ATTEMPT_ID`. Write the manifest's validation and handoff paths. A successful receipt looks like this, using actual values:

```json
{
  "schema_version": 1,
  "package_id": "01",
  "attempt_id": "current-attempt-id-from-prompt",
  "status": "completed",
  "source": { "head": "current-git-head", "branch": "current-branch", "dirty": true },
  "changed_files": ["actual/repository/file"],
  "checks": [{ "command": "actual executed check", "exit_code": 0, "passed": true }],
  "fixtures": [{ "id": "actual identity or digest", "kind": "synthetic", "location": "actual path" }],
  "blockers": []
}
```

`checks` must be nonempty and all required checks passed. Describe fixed exploratory failures in the handoff and record final passing checks. Additional receipt evidence is allowed. `fixtures` may be empty if none were used.

The handoff records actual changes, checks, source/fixture identity, limitations, blockers and exact next action. The final response is ONLY JSON with exactly these keys:

```json
{
  "schema_version": 1,
  "package_id": "01",
  "attempt_id": "current-attempt-id-from-prompt",
  "status": "completed",
  "summary": "Concrete outcome and checks",
  "validation_file": "docs/implementation-plans/feature/01-validation.json",
  "handoff_file": "docs/implementation-plans/feature/01-handoff.md",
  "blockers": []
}
```

The supplied output schema defines non-completion statuses. Use `blocked` for a genuine missing input, decision, permission or service. Use `failed` for an implementation/verification attempt that may be repaired. Use `acceptance-ready` only for the explicit strict parent handoff above. Never claim completed when the turn/budget ends.

Advancement requires exit 0, successful `turn.completed`, matching package/attempt identities and paths, current Git HEAD, passing checks, no blockers and a nonempty handoff. Artifact hashes are checked on restart. These validate completion records; they do not independently prove feature correctness or replace integrated acceptance. Git HEAD alone does not hash dirty files.

## State and worker isolation

State/logs live at `.codex-plan-runner/<plan-id>/`, ignored by Git and private to the OS user. Raw logs can contain sensitive source/tool output; do not publish them. Derived failure reports record commands, checks, changed files and unknown tool outcomes with best-effort secret redaction.

Atomic writes and the shared foreground/background plan lock protect progress. Live runners or recorded orphan workers prevent replacements. Stale locks recover only when both are absent. Never remove a live lock. A hard crash in lock maintenance may leave an empty `lock-guard`; inspect processes before removing it. Unrelated editing agents are not coordinated by this lock.

Foreground/background admission and runtime upgrades inspect durable controller/session/wake ownership around the plan lock. Runtime proposals bind unfinished strict acceptance evidence, review packets, timeout snapshots, retained journals and owned-tree membership as well as completed evidence. Unknown ownership or unverified resource closure blocks replacement; read-only upgrade checks never signal, delete or adopt resources. Historical verified source is not required to equal legitimate successor source. Repeated apply revalidates current history without freezing later package progress to the old proposal.

The state writer hashes exact serialized bytes and rechecks the old state immediately before replacement. This is an optimistic check under a cooperative lock, not portable filesystem compare-and-swap against arbitrary same-user writers. Hard termination can retain unresolved sessions; it does not grant permission to signal a stored PID.

Workers receive `CODEX_PLAN_WORKER=1` and a prompt marker. Execute exactly the assigned package; never initialize or start a nested runner. Resume inspects partial tool effects; it is not an exact replay or rollback. Do not edit orchestrator/state or frozen plans from a worker.

## Discovery and validation

[OpenAI Docs on skills](https://learn.chatgpt.com/docs/build-skills) documents automatic discovery and user skill folders. [Global AGENTS guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md) explains optional standing workflow preferences. Installing this skill does not change those preferences. Start a new session if existing instruction context has not refreshed.

Tests use temporary repositories and fake Codex executables. A prepared bundle or passing orchestration test does not mean feature implementation has run.
