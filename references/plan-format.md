# Authoring a runnable plan

Inspect the user's intended outcome, repository and existing authoritative plan first. The runtime supports macOS/Linux, Node.js 22.13+ and Git worktrees with an existing HEAD. Do not silently initialize or commit a user's project.

Write a specification JSON with complete Markdown strings, not file paths:

```json
{
  "title": "Improve account settings",
  "source": "# Request\n\nExact requested outcome, decisions, constraints and relevant source links.\n",
  "contract": "# Shared contract\n\nRepository invariants, existing authority, data preservation and acceptance requirements.\n",
  "recovery": {
    "schema_version": 1,
    "packages": {
      "01": { "local_repair": true, "recipes": ["npm-checks"] },
      "02": { "local_repair": true, "recipes": [] }
    }
  },
  "steps": [
    {
      "id": "01",
      "title": "Settings storage and validation",
      "manual": false,
      "plan": "# Package 01\n\nPrerequisites, bounded deliverables, real checks, acceptance gates, scope limits and next handoff.\n"
    },
    {
      "id": "02",
      "title": "Settings interface and acceptance",
      "manual": false,
      "plan": "# Package 02\n\nRead package 01's receipt. Specify interface behavior, failure states and final integrated acceptance.\n"
    }
  ]
}
```

Replace these illustrative strings with real task-specific instructions. Each package must specify actual prerequisites, deliverables, checks, scope boundaries, fixture/source identity and `NN-validation.json` / `NN-handoff.md` outputs. A failed, skipped or unknown required check is not success.

Define the original final acceptance precisely enough that a fresh worker can execute it from the saved contract and current source. Under explicit TPM pressure the runner may subdivide the remaining work into 2–6 sequential subtasks, but those checkpoints cannot replace the package's final checks or completion receipt. State any effects that require inspection before retry so that fresh subtask contexts can reconcile partial work safely. Do not pre-author extra packages merely to anticipate rate pressure or let a planner broaden authorization.

`recovery` is optional. Omitting it enables bounded sandbox source repair for each nonmanual package and authorizes no host recipes. When present, it must contain exactly `schema_version: 1` and `packages`; each named, nonmanual package has exactly boolean `local_repair` and an array `recipes`. Unlisted packages have recovery disabled. Host recipes require `local_repair: true`. The recovery recipe selector supports only the unique string `npm-checks`: fixed `npm test` followed by `npm run check`. It does not accept arbitrary argv or installations. The separate strict acceptance profile below authorizes its own fixed build, synthetic PostgreSQL and loopback browser capabilities; they are not extra recovery recipe strings. Select it only when these existing local npm scripts and their effects are authorized. Unsupported recipes, extra command fields and manual/missing package IDs fail before writes.

The configuration is copied into the frozen manifest. Recovery cannot change npm scripts/config, credentials or installed dependencies. Checks receive a fresh `CODEX_PLAN_DATA_DIR`; projects must use this directory for disposable test data when their tests need writable fixtures. This is an environment convention, not a sandbox or proof that scripts avoid every external effect. Review the scripts before authorizing host execution.

## Strict parent-owned acceptance

The separate optional `acceptance` profile freezes acceptance capabilities and semantic criteria in the authored manifest. Omission produces explicit `mode: "legacy"` with empty packages: legacy completion validates receipts and declared checks, without claiming the stronger parent-owned acceptance guarantee. Existing manifests and accepted historical receipts remain readable. New strict profiles apply only to their named nonmanual packages.

```json
{
  "acceptance": {
    "schema_version": 1,
    "mode": "strict",
    "packages": {
      "01": {
        "required_gates": [
          { "id": "npm", "capability": "npm-checks" },
          { "id": "sql", "capability": "synthetic-postgres" },
          { "id": "build", "capability": "production-build" }
        ],
        "criteria": [
          { "id": "reject-stale-write", "type": "persistence", "purpose": "Reject stale writes on SQLite and PostgreSQL without losing the prior state.", "gate_ids": ["npm", "sql"] },
          { "id": "production-build", "type": "build", "purpose": "Produce the production application build with installed dependencies.", "gate_ids": ["build"] }
        ]
      }
    }
  }
}
```

Capabilities are exactly `npm-checks`, `production-build`, `synthetic-postgres`, and `loopback-browser`. The profile author must have existing authority for each local effect. Capability declarations are not arbitrary commands: adapters own executable arguments, environment, loopback URLs, fixture markers and resource cleanup. Omitted capabilities remain unavailable. A PostgreSQL gate may name only a reviewed runtime preset; new suites use `tests/acceptance/NN/*.postgres.test.ts` and the parent-owned marker convention. Browser mappings use one `tests/acceptance/NN/*.browser.mjs` harness with package-specific assertions and rendered evidence. Production builds use an isolated checkout and preinstalled dependencies, without package installation or downloads.

Criterion types are `behavior`, `security`, `persistence`, `ui`, `build`, and `suite`. Each needs an immutable stable ID, a precise original purpose and the IDs of every required gate. Persistence needs SQL coverage; UI needs browser coverage. All required gates must serve at least one criterion. Do not collapse substantive behavior into a single generic `suite` criterion: fresh review must see the original acceptance and actual assertions.

The generator reserves `NN-acceptance-mapping.json` beside the package plan but does not invent its cases. This file is a worker deliverable with exactly `schema_version:1`, `package_id`, `gates:[{gate_id,files,cases}]` and `criteria:[{criterion_id,gate_id,test_ids}]`. It contains no commands, environment overrides, URLs, optional/skip decisions or new authority. Every frozen criterion/gate pair must appear exactly once and reference declared case IDs. Behavioral criteria require real assertion cases, not merely a successful npm command. `npm-test` and `npm-check` are fixed command case IDs; `production-build` is the sole build case. Required test suites must be completely enumerated and have zero skipped required cases. A default suite's unrelated opt-in skips cannot be claimed as SQL coverage.

Missing mappings and future test files are implementation gaps. Missing installed prerequisites are checked across the whole selected executable prefix before its first worker; the runner does not install dependencies, download browsers or start arbitrary services. The parent independently checks mappings, source/report/artifact hashes, full case coverage and fixture cleanup, then obtains fresh read-only semantic review before accepting new or changed mappings. Semantic review is model-reviewed engineering evidence, not proof of all correctness. Failed or stale evidence remains durable, and only stale source-bound gates are refreshed within saved budgets.

## Mandatory preflight planning

Before marking the manifest ready, inspect every selected package through its first explicit manual boundary and record the following in its saved plan/shared contract. Capability authority must be present in the frozen profile before work starts; discovering an omitted capability later requires an explicit reviewed plan/runtime change, not an agent-authored command.

| Required work | Frozen capability and readiness to establish before launch |
| --- | --- |
| Local behavior/security assertions and typechecking | `npm-checks`; existing `vitest run` and `tsc --noEmit` scripts, npm, installed Vitest and TypeScript. |
| Python-backed extraction/token counting | Existing Python runtime and local packages declared in `requirements.txt` / `requirements-protocol.txt`; exact pins and local tokenizer data are checked offline and bound into isolated acceptance. No installation/download. |
| Persistence/transaction assertions | `synthetic-postgres`; installed Vitest, local Docker endpoint and running daemon, preinstalled `pgvector/pgvector:pg17` image. Author marker/schema/rollback expectations; no existing database may be reused. |
| Production artifact | `production-build`; existing `next build` script and installed Next/dependencies. Build is isolated and offline; no dependency download. |
| Visible/browser behavior | `loopback-browser`; installed Next, `playwright-core` and supported Chrome/Chromium. Author persona, negative-state, rendered-artifact and cleanup assertions. |
| Selected Codex configuration | Installed chosen executable/profile and a positive local authentication-readiness indication. The fixed Azure CLI user-auth adapter checks the unchanged helper/profile/plaintext MSAL cache for matching local credentials; it never runs the auth command or refreshes credentials. Local readiness does not prove token validity or remote authorization. |
| Package before `--from` | Its accepted evidence must already verify. An earlier unfinished package inside the selected range is a planned predecessor and may run first. |

[The complete strict authoring example](strict-acceptance-example.json) freezes concrete stale-write, authorization, browser-error and build criteria across packages `01` and ordinary `15`, followed by an explicit manual `45`. Adapt the full source/contract/plans and criteria to the actual request; it is not authority to run those effects in an unrelated project. Future `NN-acceptance-mapping.json`, SQL suites and browser harnesses are deliverables, so preflight does not require them to exist before implementation. Once those deliverables are ready, a worker/finalizer can return `acceptance-ready` to request the frozen parent gates before any successful final receipt exists. A supervisor can explicitly request the same strict lifecycle with `acceptance-check`; neither request adds capabilities or authorizes legacy/manual packages. The original actor must finalize with current evidence after parent acceptance passes.

`preflight --from NN --to NN --json` reports the exact selection, accepted and pending packages, executable prefix, capability attribution and missing prerequisites. Packages after the first manual boundary are not executed. The launch path runs the same prerequisites and rechecks protected identities under the plan lock before announcing readiness. A failed prerequisite produces an actionable report without a worker or host fixture. `dry-run` and `status` remain diagnostics; their exit zero is not proof that execution is ready.

For local authentication planning, review the supported mechanisms in [runner-contract.md](runner-contract.md#preflight-background-ownership-and-results). The Azure adapter accepts the known `az account get-access-token` shape with explicit HTTPS resource, subscription UUID, access-token query and TSV output. Unknown auth commands, missing or ambiguous local credentials, encrypted stores, custom cloud endpoints and repository provider/profile overrides with unresolved CLI trust/precedence are blockers. The runner preserves the selected configuration and never substitutes a provider or changes credential storage to obtain readiness.

The existing `local_repair` setting also gates TPM subdivision; no additional manifest fields or host recipes are needed. Runtime defaults are eight rate retries, a threshold of two consecutive explicit TPM-failed attempts and three fresh retry rotations inside one nonrecursive subdivision. An explicitly oversized per-minute token request can trigger subdivision after one attempt, always after cooldown. `--max-rate-retries 0` explicitly opts into unlimited rate retries. Budgets and checkpoints persist across restart; see the [execution contract](runner-contract.md#tpm-subdivision-and-checkpoints) for controls and fresh-finalizer acceptance. Ordinary RPM/temporary failures and authentication, billing or configuration errors do not trigger subdivision. A larger context window does not increase TPM quota, and this runner does not change models/providers automatically.

Run the installed skill's generator:

```bash
node /absolute/path/to/plan-and-run/scripts/prepare.mjs \
  --repo /absolute/path/to/repository \
  --slug account-settings \
  --spec /absolute/path/to/authored-spec.json
```

It creates `docs/implementation-plans/<slug>/` with a copied runtime, including subdivision, acceptance, preflight and background-control modules, and a local `run.mjs`. Generated bundles do not depend on the skill's installation path. A prepared repository can be relocated before execution; once execution begins, saved state binds the checkout identity and must not be hand-edited to move it. Existing plans/state are never overwritten, no progress state is created, and Codex is not launched. Private state gets an ignore entry without replacing existing ignore rules.

The generator creates a sequential dependency chain. A different acyclic order may be reviewed before execution; dependencies must reference earlier listed packages. Ordinary two-digit IDs, including `15`, are unrestricted. Mark only the actual unresolved boundary `manual: true` and explain the reason in its package. Subdivision remains inside the selected parent package and never crosses a selected range or manual boundary.

Review the bundle, then set `"ready": true` in `runner-manifest.json`. Validate with:

```bash
node docs/implementation-plans/account-settings/run.mjs dry-run
node docs/implementation-plans/account-settings/run.mjs status
node docs/implementation-plans/account-settings/run.mjs preflight --from 01 --to 02 --json
```

For foreground implementation, run `node docs/implementation-plans/account-settings/run.mjs start --from 01 --to 02`. When unattended execution is requested, use the single launch command and retain its session/result path:

```bash
node docs/implementation-plans/account-settings/run.mjs launch --from 01 --to 02 --json
node docs/implementation-plans/account-settings/run.mjs status --json
node docs/implementation-plans/account-settings/run.mjs logs
node docs/implementation-plans/account-settings/run.mjs stop --session SESSION_UUID --json
```

Launch acknowledgment establishes owned startup, not acceptance. Status/results distinguish completed, unfinished/manual, interrupted and unresolved work. A repeated launch uses preserved state rather than resetting budgets. For planning-only or a user-launchable script request, return the relevant command without launching it. No service is installed and no reboot/poweroff/closed-lid survival is promised.

Once execution starts, the manifest, source, shared/worker contracts and package specifications are fingerprinted. Do not edit them to bypass a blocker. Reconcile existing receipts before creating a deliberately revised plan. Keep runtime files fixed while a worker is active. Generated bundles never receive automatic updates from the installed skill. After a separately authorized runtime upgrade, use `status` to inspect the mismatch and the reviewed runtime reconciliation procedure in the worker contract; do not hand-edit saved hashes or counters.
