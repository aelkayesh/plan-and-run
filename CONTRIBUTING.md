# Contributing

Bug reports and small, focused pull requests are welcome. Describe the expected behavior, what happened, your OS, Node version and Codex CLI version. Include a minimal synthetic reproduction. Remove credentials, private source, account identifiers and local execution logs before sharing.

The runner uses Node's standard library and test runner. From a clone:

```sh
npm run check
npm run demo
npm test
```

No `npm install` is required. Tests create temporary repositories and fake Codex executables; they must not call a model or depend on a real account. Runtime changes need a behavioral regression test. Documentation changes need a check that the described commands and boundaries are accurate.

Preserve selected package ranges, authorization boundaries, finite budgets, accepted evidence and interrupted state. Do not make a failed or skipped acceptance gate pass by relaxing the receipt checks. Treat changes to state formats, authentication, host execution and runtime reconciliation as compatibility changes and explain their migration impact.

Generated bundles contain pinned runtime copies. Updating this repository does not upgrade someone else's saved plan. Review [the runtime contract](references/runner-contract.md) before changing that lifecycle.

Please open an issue before a broad adapter or architecture change. This is an early project; response times and support are best effort. Contributions are under the repository's [MIT license](LICENSE).
