import fs from "node:fs";

const toolTypes = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);
const checkCommand = /\b(vitest|pytest|tsc|prettier)\b|\bnpm\s+(test|run\s+(check|lint|test))\b|\bgit\s+diff\s+--check\b/;

export function redact(text) {
  let value = String(text ?? "");
  for (const [key, secret] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && secret.length >= 8) value = value.split(secret).join("[redacted]");
  }
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/((?:[\w-]*(?:api[_-]?key|secret|password|access[_-]?token))["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
}

export function failureReport({ taskId, attempt, result, reason, kind, logFile }) {
  const tools = new Map(), errors = [], messages = [];
  let malformedLines = 0;
  let lastToolId = null;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { malformedLines++; continue; }
    const item = event.item;
    if (item && toolTypes.has(item.type) && item.id && ["item.started", "item.updated", "item.completed"].includes(event.type)) {
      const prior = tools.get(item.id) || {};
      tools.set(item.id, { ...prior, ...item, finished: prior.finished || event.type === "item.completed" });
      lastToolId = item.id;
    }
    const error = event.type === "turn.failed" ? event.error?.message : event.type === "error" ? event.message : null;
    if (error && !errors.includes(error)) errors.push(error);
    if (event.type === "item.completed" && item?.type === "agent_message") messages.push(item.text || "");
  }
  const entries = [...tools.values()].map(item => ({
    id: item.id, type: item.type, status: item.status || "unknown", finished: Boolean(item.finished),
    exitCode: item.exit_code ?? null,
    command: redact(item.command),
    name: redact(item.tool || item.tool_name || item.query || ""),
    changedFiles: (item.changes || []).map(change => redact(change.path)),
    outputExcerpt: redact(item.aggregated_output || item.error?.message || "").slice(-2000)
  }));
  const failed = entries.filter(item => item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0));
  const unfinished = entries.filter(item => !item.finished);
  const successfulChecks = entries.filter(item => item.finished && item.exitCode === 0 && checkCommand.test(item.command));
  const changedFiles = [...new Set(entries.flatMap(item => item.changedFiles))];
  const report = {
    taskId, attempt, kind: kind || "implementation", reason: redact(reason).slice(0, 2000),
    workerExitCode: result.code, timedOut: result.timedOut, sourceLog: logFile,
    threadId: result.threadId || null, resumed: Boolean(result.resumed),
    providerErrors: errors.map(redact), tools: entries, failedTools: failed,
    successfulCheckCommands: successfulChecks, unfinishedTools: unfinished, changedFiles,
    lastTool: entries.find(item => item.id === lastToolId) || null, lastWorkerMessage: redact(messages.at(-1)).slice(0, 1000), malformedLines,
    interpretation: "Command exit codes and file-change events are recorded observations. Successful commands do not establish task completion. Unfinished calls have unknown outcomes. Shell-based edits may not appear in changedFiles."
  };
  const label = item => `${item.id}: ${item.command || item.name || item.type} (status=${item.status}, exit=${item.exitCode ?? "unknown"})`;
  const summary = [
    `Previous attempt ${attempt} for ${taskId}: ${report.kind}; worker exit ${result.code}.`,
    report.providerErrors.length ? `Provider errors: ${report.providerErrors.join("; ")}` : report.reason.slice(0, 500),
    `Failed tools (${failed.length}):`, ...failed.slice(-3).map(item => `${label(item).slice(0, 300)}\n${item.outputExcerpt.slice(-600)}`),
    `Successful check commands (${successfulChecks.length}; exit 0, not task completion):`, ...successfulChecks.slice(-5).map(item => label(item).slice(0, 300)),
    `Changed files observed: ${changedFiles.slice(0, 12).join(", ") || "none recorded; inspect shell-based edits/checkpoints"}.`,
    `Unfinished tools (${unfinished.length}; outcomes unknown):`, ...unfinished.slice(-3).map(item => label(item).slice(0, 300)),
    `Last tool: ${report.lastTool ? label(report.lastTool).slice(0, 300) : "none recorded"}.`,
    `Last worker note: ${report.lastWorkerMessage.slice(0, 500) || "none"}.`,
    "Resume from existing files/checkpoints. Inspect the failed checks and unfinished calls first. Reuse prior successful checks only if their inputs remain unchanged. Do not treat a provider rate limit as proof the task needs further expansion."
  ].join("\n").slice(0, 6000);
  return { report, summary };
}

export function saveFailureReport(input) {
  const { report, summary } = failureReport(input);
  const stem = input.logFile.replace(/\.jsonl$/, "");
  const jsonPath = `${stem}-failure.json`, markdownPath = `${stem}-failure.md`;
  report.recordedAt = new Date().toISOString();
  const sections = report.tools.map(tool => [
    `### ${tool.id}: ${tool.type} — ${tool.status}`,
    `Exit code: ${tool.exitCode ?? "unknown"}; terminal event: ${tool.finished ? "recorded" : "missing"}.`,
    "```text", (tool.command || tool.name || "No command text").replaceAll("```", "'''"), "```",
    ...(tool.changedFiles.length ? [`Changed files: ${tool.changedFiles.join(", ")}`] : []),
    ...(tool.outputExcerpt ? ["Output excerpt:", "```text", tool.outputExcerpt.replaceAll("```", "'''"), "```"] : [])
  ].join("\n")).join("\n\n");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  fs.writeFileSync(markdownPath, `# Task ${input.taskId}: failed attempt ${input.attempt}\n\n${summary}\n\n${report.interpretation}\n\nSource event log: ${input.logFile}\n\n## Recorded tool calls\n\n${sections}\n`, { mode: 0o600 });
  const suffix = `\nFull local failure report: ${markdownPath}`;
  return { summary: summary.slice(0, Math.max(0, 6000 - suffix.length)) + suffix, jsonPath, markdownPath, report };
}
