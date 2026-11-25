# Contributor instructions

This is the public Plan and Run skill and runner. Preserve authorization boundaries, finite retry budgets, receipt checks and existing bundle compatibility. Do not use real inference to test orchestration; use temporary repositories and fake Codex workers. Do not publish raw execution logs or private state.

Run `npm test` and `npm run check` after implementation changes. For a runner worker, complete only the assigned package; do not initialize or launch a nested plan. Repository release work under `docs/implementation-plans` and `.release-work` stays local.
