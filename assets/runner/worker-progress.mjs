/** Codex emits activity events, not a reliable completion percentage. */
export function workerProgress(taskId, { intervalSeconds = 15, output = process.stdout, log = console.log } = {}) {
  if (!(intervalSeconds > 0)) return { push() {}, clear() {}, stop() {} };
  const startedAt = Date.now();
  let lastEventAt = startedAt, activity = "Starting worker", completedTools = 0, buffer = "", frame = 0;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const elapsed = () => Math.floor((Date.now() - startedAt) / 1000);
  const clear = () => { if (output.isTTY) output.write("\r\x1b[2K"); };
  const draw = () => {
    const idle = Math.floor((Date.now() - lastEventAt) / 1000);
    const text = `Task ${taskId} | ${elapsed()}s elapsed | ${activity} | ${completedTools} tools finished | ${idle}s since last event`;
    if (output.isTTY) {
      clear();
      const width = Math.max(20, (output.columns || 120) - 1);
      output.write(`${frames[frame++ % frames.length]} ${text}`.slice(0, width));
    } else log(`Worker running: ${text}`);
  };
  const push = chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      lastEventAt = Date.now();
      const item = event.item;
      if (event.type === "thread.started") activity = "Session started";
      else if (event.type === "turn.started") activity = "Waiting for model";
      else if (event.type === "turn.completed") activity = "Model turn completed";
      else if (event.type === "turn.failed" || event.type === "error") activity = "Provider reported an error";
      else if (item && event.type.startsWith("item.")) {
        const labels = { command_execution: "Running command", file_change: "Editing files", mcp_tool_call: "Calling tool", web_search: "Searching", reasoning: "Reasoning", agent_message: "Worker message", plan: "Updating plan" };
        activity = labels[item.type] || "Worker activity";
        if (event.type === "item.completed") {
          if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) completedTools++;
          activity = item.status === "failed" ? "Tool failed" : `${activity} finished; waiting for next event`;
        }
      }
    }
  };
  draw();
  const timer = setInterval(draw, output.isTTY ? 250 : intervalSeconds * 1000);
  return {
    push, clear,
    stop(code) {
      clearInterval(timer);
      clear();
      log(`Worker exited: task ${taskId}, code ${code}, ${elapsed()}s elapsed, ${completedTools} tools finished.`);
    }
  };
}
