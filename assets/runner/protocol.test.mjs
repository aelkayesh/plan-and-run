import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, retryDelayMs, transportRetryDelayMs, resultSchema, validateCompletion } from "./protocol.mjs";

const error = (message, extra = {}) => ({ type: "turn.failed", error: { message, ...extra } });
const classify = (message, extra = {}) => classifyFailure({ errors: [error(message, extra)], stderr: "", code: 1 });

test("provider failures ignore tool and agent text and catalog refresh warnings", () => {
  assert.equal(classifyFailure({ errors: [
    { type: "item.completed", item: { type: "command_execution", aggregated_output: "rate limit 429" } },
    { type: "item.completed", item: { type: "agent_message", text: "authentication 401" } },
    { type: "error", item: { type: "agent_message", text: "insufficient_quota" } },
    error("failed to refresh available models", { status_code: 401, retry_after: 600 })
  ], stderr: "failed to refresh available models: status 429", code: 1 }).kind, "failure");
  const mixed = classifyFailure({ errors: [error("stream disconnected")], stderr: "failed to refresh available models: 401\nnetwork error", code: 1 });
  assert.equal(mixed.kind, "transport");
  assert.doesNotMatch(mixed.message, /401|refresh/);
});

test("authentication, quota and configuration override misleading rate hints", () => {
  assert.equal(classify("429: invalid API key, please retry").kind, "authentication");
  assert.equal(classify("rate_limit_exceeded", { code: "insufficient_quota" }).kind, "quota");
  assert.equal(classify("usage_limit_reached", { code: "billing_hard_limit_reached" }).kind, "quota");
  assert.equal(classify("429: Your credits are exhausted.").kind, "quota");
  assert.equal(classify("429; unknown option --bad").kind, "configuration");
  assert.equal(classify("Session not found; invalid configuration: unknown option --bad").kind, "configuration");
  assert.equal(classify("rate_limit_exceeded").kind, "rate-limit");
  assert.equal(classify("Too many requests", { status_code: 429 }).kind, "rate-limit");
  assert.equal(classifyFailure({ errors: [], stderr: "", code: 127 }).kind, "configuration");
  assert.equal(classify("connection reset ECONNRESET").kind, "transport");
  assert.equal(classify("HTTP 500: temporarily unavailable").kind, "transport");
  assert.equal(classifyFailure({ signal: "SIGTERM" }).kind, "transport");
  assert.equal(classify("Session not found: the saved conversation is unavailable").kind, "missing-session");
});

test("subscription usage caps retry at human dates or fall back to backoff", t => {
  const now = new Date(2026, 10, 12, 10, 0, 0).getTime();
  t.mock.method(Date, "now", () => now);
  const human = classify("You've hit your usage limit. Try again at 10:00 AM on Nov 13, 2026.");
  assert.equal(human.kind, "rate-limit");
  assert.equal(human.retryAfterMs, new Date(2026, 10, 13, 10, 0, 0).getTime() - now);
  const explicitZone = classify("You've hit your usage limit. Try again at 10:00 AM on Nov 13, 2026 UTC.");
  assert.equal(explicitZone.retryAfterMs, Date.UTC(2026, 10, 13, 10, 0, 0) - now);
  const iso = classify("You've hit your usage limit. Try again at 2026-11-13T10:00:00+01:00.");
  assert.equal(iso.retryAfterMs, Date.parse("2026-11-13T10:00:00+01:00") - now);
  assert.equal(classify("You've hit your usage limit. Try again in 2h.").kind, "rate-limit");
  assert.equal(classify("usage_limit_reached").kind, "rate-limit");
  assert.equal(classify("usage_limit_reached").retryAfterMs, null);
  assert.equal(classify("insufficient_quota: You've hit your usage limit.").kind, "quota");
});

test("retry fields and headers preserve the largest provider minimum", () => {
  const result = classify("rate limited", { retry_after: 2, details: { retry_after_ms: 5000 }, headers: { "Retry-After": "8" } });
  assert.equal(result.retryAfterMs, 8000);
  assert.equal(classify("rate limited", { headers: [["Retry-After", "3"]] }).retryAfterMs, 3000);
  assert.equal(classify("rate limited", { headers: [{ name: "Retry-After", value: "4" }] }).retryAfterMs, 4000);
  assert.equal(classify("rate limited", { retry_after_ms: -1 }).retryAfterMs, null);
});

test("HTTP dates and reset timestamps become remaining delays", t => {
  const now = Date.UTC(2026, 10, 12, 10, 0, 0);
  t.mock.method(Date, "now", () => now);
  assert.equal(classify("rate limited", { headers: { "Retry-After": "Thu, 12 Nov 2026 10:02:00 GMT" } }).retryAfterMs, 120_000);
  assert.equal(classify("rate limited", { reset_at: "2026-11-12T10:03:00Z" }).retryAfterMs, 180_000);
  assert.equal(classify("rate limited", { reset_timestamp: (now + 90_000) / 1000 }).retryAfterMs, 90_000);
  assert.equal(classify("usage_limit_reached", { resets_at: (now + 91_000) / 1000 }).retryAfterMs, 91_000);
  assert.equal(classify("rate limited", { reset_at_ms: now + 95_000 }).retryAfterMs, 95_000);
  assert.equal(classify("rate limit resets at 2026-11-12T10:04:00Z. Try later.").retryAfterMs, 240_000);
  assert.equal(classify("rate limited", { headers: { "x-ratelimit-reset-tokens": "2m5s" } }).retryAfterMs, 125_000);
  assert.equal(classify("rate limited", { headers: { "Retry-After": "Thu, 12 Nov 2026 09:00:00 GMT" } }).retryAfterMs, 0);
});

test("textual delays distinguish milliseconds from minutes and sum durations", () => {
  assert.equal(classify("Too many requests; try again in 2m 5s").retryAfterMs, 125_000);
  assert.equal(classify("429: retry after 1000 ms.").retryAfterMs, 1000);
  assert.equal(classify("429: Please try again in 5.458s.").retryAfterMs, 5458);
  assert.equal(classify("429\nRetry-After: 12").retryAfterMs, 12_000);
  assert.equal(classify("429: try again in 1 hour, 2 minutes and later").retryAfterMs, 3_720_000);
  assert.equal(classify("429: try again in nonsense").retryAfterMs, null);
});

test("backoff is positive, capped, adds positive jitter and never shortens provider delays", () => {
  assert.equal(retryDelayMs({ attempt: 1, baseMs: 100, maxMs: 1000, random: () => 0 }), 101);
  assert.equal(retryDelayMs({ attempt: 3, baseMs: 100, maxMs: 1000, random: () => 0.5 }), 440);
  assert.equal(retryDelayMs({ attempt: 10000, baseMs: 100, maxMs: 1000, random: () => 1 }), 1000);
  assert.equal(retryDelayMs({ attempt: 2, baseMs: 100, maxMs: 1000, retryAfterMs: 120_000, random: () => 0 }), 120_000);
  assert.equal(retryDelayMs({ baseMs: 0, maxMs: 0, random: () => 0 }), 1);
  assert.ok(Number.isFinite(retryDelayMs({ attempt: Infinity, baseMs: NaN, maxMs: Infinity, random: () => NaN })));
});

test("transport backoff has a short base and ceiling while rate delays and provider minima remain independent", () => {
  const configured = { baseMs: 60_000, maxMs: 900_000, random: () => 0 };
  assert.equal(transportRetryDelayMs({ ...configured, attempt: 1 }), 10_001);
  assert.equal(transportRetryDelayMs({ ...configured, attempt: 2 }), 20_001);
  assert.equal(transportRetryDelayMs({ ...configured, attempt: 3 }), 30_000);
  assert.equal(transportRetryDelayMs({ ...configured, attempt: 10000 }), 30_000);
  assert.equal(retryDelayMs({ ...configured, attempt: 1 }), 60_001);
  assert.equal(retryDelayMs({ ...configured, attempt: 7 }), 900_000);
  assert.equal(transportRetryDelayMs({ ...configured, retryAfterMs: 120_000 }), 120_000);
  assert.equal(transportRetryDelayMs({ baseMs: 20, maxMs: 40, attempt: 3, random: () => 1 }), 40);
  assert.equal(transportRetryDelayMs({ baseMs: NaN, maxMs: Infinity, random: () => 0 }), 10_001);
});

function completion() {
  const step = { id: "01", validation: "docs/plans/01-validation.json", handoff: "docs/plans/01-handoff.md" };
  return {
    step, attemptId: "nonce-1", head: "abc123", handoff: "Package 01 handoff",
    result: { schema_version: 1, package_id: "01", attempt_id: "nonce-1", status: "completed", summary: "Implemented and checked.", validation_file: step.validation, handoff_file: step.handoff, blockers: [] },
    receipt: { schema_version: 1, package_id: "01", attempt_id: "nonce-1", status: "completed", source: { head: "abc123", branch: "candidate", dirty: true }, changed_files: [], checks: [{ command: "node --test test.mjs", exit_code: 0, passed: true }], fixtures: [{ id: "synthetic-user", kind: "synthetic", location: "fixtures/user.json" }], blockers: [] }
  };
}

test("schema requires exactly the requested structured result fields", () => {
  assert.equal(resultSchema.additionalProperties, false);
  assert.deepEqual([...resultSchema.required].sort(), Object.keys(completion().result).sort());
  assert.equal(resultSchema.properties.schema_version.const, 1);
  assert.deepEqual(resultSchema.properties.status.enum, ["completed", "acceptance-ready", "blocked", "failed", "incomplete"]);
  assert.equal(validateCompletion(completion()), true);
  const noFixtures = completion();
  noFixtures.receipt.fixtures = [];
  assert.equal(validateCompletion(noFixtures), true);
});

test("completion rejects stale, wrong-package and extra-field results", () => {
  for (const mutate of [
    x => { x.result.extra = true; }, x => { delete x.result.summary; },
    x => { x.result.schema_version = "1"; }, x => { x.result.package_id = "02"; },
    x => { x.result.attempt_id = "old-nonce"; }, x => { x.receipt.attempt_id = "old-nonce"; },
    x => { x.receipt.package_id = "02"; }, x => { x.result.status = "blocked"; },
    x => { x.result.validation_file = "../other.json"; }, x => { x.result.handoff_file = "other.md"; },
    x => { x.result.summary = " "; }, x => { x.result.blockers = ["unfinished"]; },
    x => { x.receipt.source.head = "other-head"; }
  ]) {
    const value = completion(); mutate(value);
    assert.throws(() => validateCompletion(value), /Invalid completion:/);
  }
});

test("completion requires substantive successful checks, source, fixtures and handoff", () => {
  for (const mutate of [
    x => { x.receipt.schema_version = 2; }, x => { x.receipt.status = "failed"; },
    x => { delete x.receipt.source; }, x => { x.receipt.source.branch = null; },
    x => { x.receipt.source.dirty = "true"; }, x => { x.receipt.changed_files = "file.mjs"; },
    x => { x.receipt.changed_files = [""]; }, x => { x.receipt.checks = []; },
    x => { x.receipt.checks[0].exit_code = "0"; }, x => { x.receipt.checks[0].exit_code = 1; },
    x => { x.receipt.checks[0].passed = false; }, x => { x.receipt.checks[0].command = " "; },
    x => { x.receipt.fixtures = null; }, x => { x.receipt.fixtures[0].location = ""; },
    x => { x.receipt.blockers = ["pending"]; }, x => { x.handoff = "\n  "; }
  ]) {
    const value = completion(); mutate(value);
    assert.throws(() => validateCompletion(value), /Invalid completion:/);
  }
});

const ancillarySessionLog = "2026-11-14T10:30:53.679494Z ERROR codex_core::session: failed to record rollout items: thread 01a1d98d-ea2b-7320-b9d3-279f2aa783cd not found";

test("ancillary rollout logging cannot replace primary transport or rate classification", () => {
  const transport = classifyFailure({ errors: [error("stream disconnected before completion: Transport error: network error")], stderr: ancillarySessionLog, code: 1 });
  assert.equal(transport.kind, "transport");
  assert.match(transport.message, /failed to record rollout items/);
  const rate = classifyFailure({ errors: [error("Your requests have exceeded token rate limit", { retry_after_ms: 92000 })], stderr: ancillarySessionLog, code: 1 });
  assert.equal(rate.kind, "rate-limit");
  assert.equal(rate.retryAfterMs, 92000);
  assert.match(rate.message, /failed to record rollout items/);
  assert.equal(classifyFailure({ stderr: ancillarySessionLog, code: 1 }).kind, "failure");
});

test("genuine missing sessions remain recoverable after rate cooldown and protected failures take precedence", () => {
  const missing = "Saved thread 01a1d98d-ea2b-7320-b9d3-279f2aa783cd not found";
  assert.equal(classify(missing).kind, "missing-session");
  assert.equal(classifyFailure({ stderr: missing, code: 1 }).kind, "missing-session");
  const both = classifyFailure({ errors: [error(missing), error("rate limit exceeded", { retry_after: 17 })], code: 1 });
  assert.equal(both.kind, "rate-limit");
  assert.equal(both.retryAfterMs, 17000);
  for (const [message, kind] of [["invalid API key", "authentication"], ["insufficient_quota", "quota"], ["unknown option --bad", "configuration"]]) {
    assert.equal(classifyFailure({ errors: [error(message + "; rate limit; " + missing)], stderr: ancillarySessionLog, code: 1 }).kind, kind);
  }
  assert.equal(classify("failed to load configuration: thread not found").kind, "configuration");
});

// CLI exit codes are a fallback after explicit retryable diagnostics.
test("explicit cooldown and missing-session diagnostics take precedence over exit-code fallback", () => {
  const missing = "Saved thread 01a1d98d-ea2b-7320-b9d3-279f2aa783cd not found";
  for (const code of [2, 127]) {
    assert.equal(classifyFailure({ stderr: missing, code }).kind, "missing-session");
    const limited = classifyFailure({ errors: [error("rate limit exceeded", { retry_after_ms: 29000 })], stderr: ancillarySessionLog, code });
    assert.equal(limited.kind, "rate-limit");
    assert.equal(limited.retryAfterMs, 29000);
    assert.equal(classifyFailure({ stderr: "unknown option --bad; rate limit exceeded", code }).kind, "configuration");
    assert.equal(classifyFailure({ code }).kind, "configuration");
  }
});
