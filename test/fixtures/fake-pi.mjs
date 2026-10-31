#!/usr/bin/env node
// Stands in for `pi --mode rpc`: it answers commands on stdin, and the prompt text picks the behaviour.
const emit = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
const assistant = (text, stopReason = "stop") => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason, usage: { output: 7 } },
});
const settle = () => emit({ type: "agent_settled", aborted: false });

function onCommand(command) {
  if (command.type === "get_state")
    return emit({ type: "response", command: "get_state", data: { sessionId: "fake-session" } });
  if (command.type === "steer") {
    emit(assistant(`steered: ${command.message}`));
    return settle();
  }
  if (command.type === "extension_ui_response") {
    emit(assistant(`dialog cancelled: ${command.cancelled}`));
    return settle();
  }
  if (command.type !== "prompt") return;

  const brief = command.message;
  if (brief === "ok") {
    emit({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
    emit({ type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "file.txt" }] } });
    emit(assistant("line\u2028separator survives"));
    settle();
  } else if (brief === "split") {
    // One record delivered across two writes.
    const record = JSON.stringify(assistant("from split"));
    process.stdout.write(record.slice(0, 20));
    setTimeout(() => {
      process.stdout.write(`${record.slice(20)}\n`);
      settle();
    }, 20);
  } else if (brief === "exit1") {
    process.stderr.write("boom\n");
    process.exit(1);
  } else if (brief === "exit0-early") {
    process.exit(0);
  } else if (brief === "model-error") {
    emit(assistant("partial", "error"));
    settle();
  } else if (brief === "rejected") {
    emit({ type: "response", command: "prompt", success: false, error: "no model" });
  } else if (brief === "dialog") {
    emit({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Sure?" });
  } else if (brief === "ignores-eof") {
    emit(assistant("done"));
    settle();
    setInterval(() => {}, 1000);
  }
  // Anything else ("hang", "wait-steer") stays silent until stopped or steered.
}

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let i = pending.indexOf("\n");
  while (i >= 0) {
    onCommand(JSON.parse(pending.slice(0, i)));
    pending = pending.slice(i + 1);
    i = pending.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (!process.argv.includes("--keep-alive")) process.exitCode = 0;
});
