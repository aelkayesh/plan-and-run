import { acceptanceForPackage } from './acceptance-policy.mjs';

const resultKeys = ["schema_version", "package_id", "attempt_id", "status", "summary", "validation_file", "handoff_file", "blockers"];

export const resultSchema = {
  type: "object",
  additionalProperties: false,
  required: resultKeys,
  properties: {
    schema_version: { type: "integer", const: 1 },
    package_id: { type: "string", pattern: "^[0-9]{2}$" },
    attempt_id: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["completed", "acceptance-ready", "blocked", "failed", "incomplete"] },
    summary: { type: "string", minLength: 1 },
    validation_file: { type: "string", minLength: 1 },
    handoff_file: { type: "string", minLength: 1 },
    blockers: { type: "array", items: { type: "string" } }
  }
};

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const numeric = value => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
const catalogWarning = /failed to (?:refresh|fetch|list|load).*?(?:available models|model[_ -]?catalog|models response)|(?:available models|model[_ -]?catalog).*?(?:refresh|fetch).*?(?:fail|warn)/i;
const cleanDiagnostic = text => String(text ?? "").split(/\r?\n/).filter(line => !catalogWarning.test(line)).join("\n").trim();
const ignoredKeys = new Set(["item", "items", "text", "output", "aggregated_output", "stdout", "input", "prompt"]);

function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (ignoredKeys.has(key)) continue;
    visit(key, child);
    if (child && typeof child === "object") walk(child, visit, seen);
  }
}

function durationMs(value) {
  if (typeof value !== "string") return null;
  let rest = value.trim(), total = 0, found = false;
  const token = /^(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?=\s|\d|$|[,;.)])/i;
  while (true) {
    const match = rest.match(token);
    if (!match) break;
    const unit = match[2].toLowerCase();
    const scale = /^(ms|millisecond|msec)/.test(unit) ? 1 : /^(s|sec)/.test(unit) ? 1000
      : /^(m|min)/.test(unit) ? 60_000 : /^(h|hr)/.test(unit) ? 3_600_000 : 86_400_000;
    total += Number(match[1]) * scale;
    found = true;
    rest = rest.slice(match[0].length).replace(/^[\s,+]+/, "");
  }
  return found && Number.isFinite(total) ? Math.ceil(total) : null;
}

function dateDelay(value, now) {
  const text = String(value).trim();
  const human = text.match(/^(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)\s+on\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})(?:\s+(UTC|GMT|CET|CEST|[+-]\d{2}:?\d{2}))?/i);
  const date = text.match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/i)?.[0]
    || text.match(/^[A-Za-z]{3},\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT/i)?.[0]
    || (human ? `${human[2]} ${human[1]}${human[3] ? ` ${human[3]}` : ""}` : "")
    || text;
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function retryValue(value, unit, now) {
  if (numeric(value)) {
    const amount = Number(value);
    return amount >= 0 ? Math.ceil(amount * (unit === "ms" ? 1 : 1000)) : null;
  }
  return durationMs(value) ?? (typeof value === "string" ? dateDelay(value, now) : null);
}

function resetValue(value, milliseconds, now) {
  if (numeric(value)) {
    const amount = Number(value);
    const timestamp = milliseconds || amount >= 1e12 ? amount : amount * 1000;
    return amount >= 0 ? Math.max(0, Math.ceil(timestamp - now)) : null;
  }
  return durationMs(value) ?? (typeof value === "string" ? dateDelay(value, now) : null);
}

function retryHints(events, diagnostic) {
  const hints = [], now = Date.now();
  const add = value => { if (Number.isFinite(value) && value >= 0) hints.push(value); };
  const entry = (key, value) => {
    const normalized = key.toLowerCase().replace(/[-_]/g, "");
    if (normalized === "retryafterms") add(retryValue(value, "ms", now));
    else if (normalized === "retryafter") add(retryValue(value, "s", now));
    else if (/^(?:(?:(?:rate|usage|token|request)limit)?resets?(?:at|time|timestamp)?|retryat)(?:ms)?$/.test(normalized)
      || /^xratelimitreset(?:requests|tokens)?$/.test(normalized)) add(resetValue(value, normalized.endsWith("ms"), now));
  };
  for (const event of events) {
    walk(event, entry);
    walk(event, (_key, value) => {
      if (object(value) && typeof value.name === "string" && "value" in value) entry(value.name, value.value);
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") entry(value[0], value[1]);
    });
  }
  for (const match of diagnostic.matchAll(/\bretry-after\s*:\s*([^\r\n]+)/gi)) add(retryValue(match[1].trim(), "s", now));
  for (const match of diagnostic.matchAll(/\b(?:try\s+again\s+(?:in|after)|retry(?:ing)?\s+(?:in|after))\s*:?\s*([^\r\n]+)/gi)) {
    add(retryValue(match[1].trim(), "s", now));
  }
  for (const match of diagnostic.matchAll(/\b(?:limit\s+resets?|reset[_ -](?:at|time|timestamp)|try\s+again\s+at|retry\s+at)\s*(?:at\s+|on\s+|in\s+|:\s*|=\s*)?([^\r\n]+)/gi)) {
    add(resetValue(match[1].trim(), false, now));
  }
  return hints.length ? Math.max(...hints) : null;
}

/** Classify provider diagnostics only. Tool events and worker prose are deliberately ignored. */
export function classifyFailure({ errors = [], stderr = "", code = 1, signal = null } = {}) {
  const events = Array.isArray(errors) ? errors.filter(event => {
    if (!object(event) || !["error", "turn.failed"].includes(event.type)) return false;
    const primary = [event.message, event.error?.message, typeof event.error === "string" ? event.error : ""].filter(nonempty);
    return !primary.length || primary.some(message => cleanDiagnostic(message));
  }) : [];
  const fragments = [];
  for (const event of events) {
    walk(event, (key, value) => {
      if (["message", "reason", "detail", "description", "code", "error_code", "status_code", "status", "type", "error"].includes(key)
        && ["string", "number"].includes(typeof value) && !["error", "turn.failed"].includes(value)) {
        const text = cleanDiagnostic(value);
        if (text) fragments.push(text);
      }
    });
  }
  const cleanedStderr = cleanDiagnostic(stderr);
  if (cleanedStderr) fragments.push(cleanedStderr);
  const diagnostic = [...new Set(fragments)].join("\n");
  // A failure to append CLI rollout logs does not establish that the saved
  // execution session is unavailable. Preserve the diagnostic for evidence,
  // but exclude only this exact ancillary logger line from classification.
  const ancillaryRolloutLog = /(?:^|\s)(?:ERROR|WARN)\s+codex_core::session:\s+failed to record rollout items:\s+thread\s+[a-f0-9-]{36}\s+not found\s*$/i;
  const classifiedDiagnostic = diagnostic.split(/\r?\n/).filter(line => !ancillaryRolloutLog.test(line)).join("\n");
  const authentication = /unauthori[sz]|unauthenticated|authentication|invalid[\s_-]*(?:api[\s_-]*)?key|incorrect[\s_-]*api[\s_-]*key|subscription key|access denied|permission denied|invalid[\s_-]*token|expired[\s_-]*token|\b(?:401|403)\b/i;
  const quota = /insufficient[\s_-]*quota|quota[\s_-]*(?:exceeded|exhausted)|exceeded.{0,30}(?:quota|spending limit)|(?:spending|billing|credit)[\s_-]*limit(?:[\s_-]*(?:reached|exceeded))?|billing[\s_-]*(?:hard[\s_-]*)?limit|(?:credits?|balance).{0,25}(?:exhausted|depleted|insufficient)|(?:exhausted|depleted|insufficient).{0,25}(?:credits?|balance)|out of credits/i;
  const configuration = /unexpected argument|unrecognized (?:argument|option)|unknown (?:argument|option|flag)|invalid (?:configuration|config|value)|config(?:uration)? (?:error|invalid)|failed to (?:load|parse) (?:config|configuration)|unsupported (?:model|parameter|option)|model[\s_-]*not[\s_-]*found|model.{0,30}(?:does not exist|not available)|no such file or directory|\bENOENT\b/i;
  const rate = /rate[\s_-]*limit|(?:usage|subscription|plan)[\s_-]*limit|token[\s_-]*rate|too many requests|\b429\b|throttl/i;
  const transport = /stream (?:disconnected|interrupted)|transport error|connection (?:failed|reset|refused|closed|aborted)|error sending request|network error|fetch failed|socket hang up|unexpected eof|temporarily unavailable|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b|request timed out|service unavailable|\b(?:408|500|502|503|504)\b/i;
  const missingSession = /(?:session|conversation|thread).{0,60}(?:not found|expired|unavailable|does not exist)|no (?:saved )?session/i;
  const kind = authentication.test(classifiedDiagnostic) ? "authentication" : quota.test(classifiedDiagnostic) ? "quota"
    : configuration.test(classifiedDiagnostic) ? "configuration" : rate.test(classifiedDiagnostic) ? "rate-limit"
      : missingSession.test(classifiedDiagnostic) ? "missing-session" : [2, 127].includes(code) ? "configuration" : transport.test(classifiedDiagnostic) || ["SIGKILL", "SIGTERM", "SIGHUP"].includes(signal) ? "transport" : "failure";
  return { kind, message: diagnostic || `Codex exited with code ${code}${signal ? ` (signal ${signal})` : ""}.`, retryAfterMs: retryHints(events, diagnostic) };
}

/** A provider minimum may exceed the local cap; jitter never reduces a requested wait. */
export function retryDelayMs({ attempt = 1, baseMs = 1000, maxMs = 60_000, retryAfterMs = null, random = Math.random } = {}) {
  const base = Number.isFinite(baseMs) ? Math.max(1, baseMs) : 1000;
  const cap = Number.isFinite(maxMs) ? Math.max(1, maxMs) : 60_000;
  const exponent = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt) - 1) : 0;
  const backoff = Math.min(cap, base * 2 ** Math.min(exponent, 1023));
  const sample = random();
  const fraction = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
  const jitter = Math.max(1, Math.ceil(backoff * 0.2 * fraction));
  const minimum = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0;
  return Math.ceil(Math.max(minimum, Math.min(cap, backoff + jitter)));
}

/** Transport reconnects use a short local backoff; explicit provider minima still win.
 * Smaller configured delays remain useful for operators and deterministic fixtures. */
export function transportRetryDelayMs({ baseMs = 10_000, maxMs = 30_000, ...options } = {}) {
  return retryDelayMs({ ...options,
    baseMs: Number.isFinite(baseMs) ? Math.min(baseMs, 10_000) : 10_000,
    maxMs: Number.isFinite(maxMs) ? Math.min(maxMs, 30_000) : 30_000 });
}

/** Validate the worker wire result separately from acceptance. A valid blocked
 * result is a domain outcome; malformed or contradictory output gets correction. */
export function validateWorkerResult(result, { step, attemptId, acceptanceProfile }) {
  const require = (condition, message) => { if (!condition) throw new Error(`Invalid worker result: ${message}`); };
  require(object(result), "result must be a JSON object");
  require(Object.keys(result).length === resultKeys.length && resultKeys.every(key => Object.hasOwn(result, key)), "result must contain exactly the schema keys");
  require(result.schema_version === 1, "schema_version must be 1");
  require(object(step) && result.package_id === step.id && /^[0-9]{2}$/.test(step.id), "package_id does not match the requested package");
  require(nonempty(attemptId) && result.attempt_id === attemptId, "attempt_id does not match this attempt");
  require(resultSchema.properties.status.enum.includes(result.status), "unknown status");
  require(nonempty(result.summary), "summary must be nonempty");
  require(nonempty(step.validation) && result.validation_file === step.validation, "validation_file does not match the required path");
  require(nonempty(step.handoff) && result.handoff_file === step.handoff, "handoff_file does not match the required path");
  require(Array.isArray(result.blockers) && result.blockers.every(nonempty), "blockers must be an array of nonempty strings");
  require(result.status !== "completed" || result.blockers.length === 0, "completed status contradicts unresolved blockers; preserve genuine blockers and return blocked");
  require(result.status !== "blocked" || result.blockers.length > 0, "blocked status requires an actionable blocker");
  if (result.status === "acceptance-ready") {
    require(!step.manual && acceptanceForPackage(acceptanceProfile, step.id), "acceptance-ready requires an existing strict nonmanual package profile");
    require(result.blockers.length === 0, "acceptance-ready contradicts unresolved blockers; preserve genuine blockers and return blocked");
  }
  return result;
}

export function validateCompletion({ result, receipt, handoff, step, attemptId, head }) {
  const require = (condition, message) => { if (!condition) throw new Error(`Invalid completion: ${message}`); };
  require(object(step) && typeof step.id === "string" && /^[0-9]{2}$/.test(step.id), "step has no valid package identity");
  require(nonempty(attemptId) && nonempty(head), "attempt and source identities are required");
  require(object(result), "result must be an object");
  require(Object.keys(result).length === resultKeys.length && resultKeys.every(key => Object.hasOwn(result, key)), "result must contain exactly the schema keys");
  require(result.schema_version === 1, "result schema_version must be 1");
  require(result.package_id === step.id, "result package_id does not match the requested package");
  require(result.attempt_id === attemptId, "result attempt_id does not match this attempt");
  require(result.status === "completed", "result status must be completed");
  require(nonempty(result.summary), "result summary must be nonempty");
  require(nonempty(step.validation) && result.validation_file === step.validation, "result validation_file does not match the required path");
  require(nonempty(step.handoff) && result.handoff_file === step.handoff, "result handoff_file does not match the required path");
  require(Array.isArray(result.blockers) && result.blockers.length === 0, "result blockers must be empty");
  require(object(receipt), "validation receipt must be an object");
  require(receipt.schema_version === 1, "receipt schema_version must be 1");
  require(receipt.package_id === step.id && receipt.attempt_id === attemptId, "receipt identity does not match this package and attempt");
  require(receipt.status === "completed", "receipt status must be completed");
  require(object(receipt.source) && receipt.source.head === head && typeof receipt.source.branch === "string" && typeof receipt.source.dirty === "boolean", "receipt source must match the current head and include branch and dirty state");
  require(Array.isArray(receipt.changed_files) && receipt.changed_files.every(nonempty), "receipt changed_files must be an array of paths");
  require(Array.isArray(receipt.checks) && receipt.checks.length > 0, "receipt checks must be nonempty");
  require(receipt.checks.every(check => object(check) && nonempty(check.command) && check.exit_code === 0 && check.passed === true), "every receipt check must have a command, exit_code 0 and passed true");
  require(Array.isArray(receipt.fixtures) && receipt.fixtures.every(fixture => object(fixture) && ["id", "kind", "location"].every(key => nonempty(fixture[key]))), "receipt fixtures must identify id, kind and location");
  require(Array.isArray(receipt.blockers) && receipt.blockers.length === 0, "receipt blockers must be empty");
  require(nonempty(handoff), "handoff must be nonempty");
  return true;
}
