# Security and private data

The runner invokes Codex CLI against your repository. Worker calls use the selected account/provider and consume its quota or API budget. Review the saved plan, repository instructions, selected range and any host capabilities before starting it.

Workers use Codex's `workspace-write` sandbox; planning/review actors use `read-only`. Host checks are separate, fixed capabilities authorized in the plan. Scrubbing environment variables is not a security sandbox, and repository test scripts can have effects beyond their names. Use only repositories and scripts you trust.

`.codex-plan-runner/` contains private state, raw model/tool output and forensic logs. It is ignored by the generator and must not be committed or shared. Redacted diagnostic output is best effort: inspect it yourself before including it in an issue. Plans and handoffs can also contain private project details even when they live outside the private state directory.

Report vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/aelkayesh/plan-and-run/security/advisories/new) when it is enabled. If that channel is unavailable, open an issue asking for a private contact without including exploit details or sensitive data. Do not post credentials, private logs or private source in public issues.

Security fixes are best effort for the current main branch. There is no support SLA or guarantee that automated acceptance proves correctness. For operational boundaries and recovery behavior, read [the execution contract](references/runner-contract.md).
