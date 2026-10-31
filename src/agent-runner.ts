import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shortArgs, textOf } from "./format.ts";
import type { Semaphore } from "./semaphore.ts";
import type { AgentRecord, AgentReport, AgentSpec, AgentStatus, TranscriptKind } from "./types.ts";

export const DEFAULT_TIMEOUT_MINUTES = 45;
export const DEFAULT_MAX_PARALLEL = 3;
export const DEPTH_ENV = "PI_DISPATCH_DEPTH";
const RESULT_TAIL_CHARS = 6000;
const TRANSCRIPT_ENTRIES = 1000;
const TRANSCRIPT_ENTRY_CHARS = 8000;
const TOOL_RESULT_CHARS = 1200;
const KILL_GRACE_MS = 5000;
const SETTLE_EXIT_GRACE_MS = 2000;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function parseMaxParallel(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_PARALLEL;
}

export function createRecord(spec: AgentSpec, defaultCwd: string, now = Date.now()): AgentRecord {
  return {
    name: spec.name,
    cwd: spec.cwd ?? defaultCwd,
    status: "queued",
    toolCalls: 0,
    outputTokens: 0,
    activity: "queued",
    activitySince: now,
    toolRunning: false,
    lastEventAt: now,
    transcript: [{ kind: "user", text: spec.brief }],
    userMessages: [],
    streamedText: false,
    finalText: "",
  };
}

export function isActive(rec: { status: AgentStatus }): boolean {
  return rec.status === "queued" || rec.status === "running";
}

function setActivity(rec: AgentRecord, activity: string, now: number, toolRunning = false): void {
  rec.toolRunning = toolRunning;
  if (rec.activity === activity) return;
  rec.activity = activity;
  rec.activitySince = now;
}

export function addTranscript(rec: AgentRecord, kind: TranscriptKind, text: string): void {
  rec.transcript.push({ kind, text: text.slice(0, TRANSCRIPT_ENTRY_CHARS) });
  if (rec.transcript.length > TRANSCRIPT_ENTRIES) rec.transcript.shift();
}

function appendTranscript(rec: AgentRecord, kind: TranscriptKind, delta: string): void {
  const last = rec.transcript.at(-1);
  if (last?.kind !== kind) {
    addTranscript(rec, kind, delta);
    return;
  }
  if (last.text.length < TRANSCRIPT_ENTRY_CHARS) last.text += delta;
}

/** Folds one record of the child's event stream into the agent's state. */
export function applyEvent(rec: AgentRecord, ev: Record<string, any>, now = Date.now()): void {
  rec.lastEventAt = now;
  switch (ev.type) {
    case "message_start":
      if (ev.message?.role === "assistant") rec.streamedText = false;
      break;
    case "message_update": {
      const inner = ev.assistantMessageEvent;
      const kind = inner?.type as string | undefined;
      if (kind?.startsWith("thinking")) {
        setActivity(rec, "thinking", now);
        if (kind === "thinking_delta") appendTranscript(rec, "thinking", String(inner.delta ?? ""));
      } else if (kind?.startsWith("text")) {
        setActivity(rec, "writing", now);
        if (kind === "text_delta") {
          rec.streamedText = true;
          appendTranscript(rec, "text", String(inner.delta ?? ""));
        }
      } else if (kind?.startsWith("toolcall")) {
        setActivity(rec, "preparing a tool call", now);
      }
      break;
    }
    case "tool_execution_start": {
      rec.toolCalls++;
      const tool = `${ev.toolName} ${shortArgs(ev.args)}`.trim();
      setActivity(rec, tool, now, true);
      addTranscript(rec, "tool", tool);
      break;
    }
    case "tool_execution_end": {
      const output = textOf(ev.result ?? {}).trim();
      if (output) addTranscript(rec, ev.isError ? "error" : "result", output.slice(0, TOOL_RESULT_CHARS));
      else if (ev.isError) addTranscript(rec, "error", `${ev.toolName} failed`);
      setActivity(rec, "waiting for the model", now);
      break;
    }
    case "message_end":
      if (ev.message?.role === "assistant") {
        const text = textOf(ev.message);
        if (text) {
          rec.finalText = text;
          if (!rec.streamedText) addTranscript(rec, "text", text);
        }
        rec.stopReason = ev.message.stopReason;
        rec.outputTokens += ev.message.usage?.output ?? 0;
      }
      break;
    case "auto_retry_start":
      setActivity(
        rec,
        `provider retry ${ev.attempt}/${ev.maxAttempts}: ${String(ev.errorMessage ?? "").slice(0, 80)}`,
        now,
      );
      addTranscript(rec, "notice", rec.activity);
      break;
    case "compaction_start":
      setActivity(rec, "compacting context", now);
      addTranscript(rec, "notice", "compacting context");
      break;
  }
}

export interface ChildOptions {
  approve: boolean;
  defaultModel?: string;
}

export function buildChildArgs(spec: AgentSpec, options: ChildOptions): string[] {
  const args = ["--mode", "rpc"];
  if (spec.resume_session) args.push("--session", spec.resume_session);
  else args.push("--name", `agent:${spec.name}`);
  const model = spec.model ?? options.defaultModel;
  if (model) args.push("--model", model);
  if (spec.thinking) args.push("--thinking", spec.thinking);
  // Inherit the parent's trust decision: a fresh worktree path has no saved decision,
  // and a background child cannot prompt.
  args.push(options.approve ? "--approve" : "--no-approve");
  return args;
}

export interface RunOptions extends ChildOptions {
  semaphore: Semaphore;
  command: { cmd: string; prefix: string[] };
  reportDir: string;
  onChange?: () => void;
}

/** Runs one agent until it settles. Never rejects: every failure becomes a report. */
export async function runAgent(spec: AgentSpec, rec: AgentRecord, options: RunOptions): Promise<AgentReport> {
  let stderr = "";
  let code: number | null = null;
  let settled = false;
  let hasSlot = false;

  try {
    const slot = options.semaphore.acquire();
    rec.stop = (why) => {
      rec.error = why;
      slot.cancel(why);
    };
    await slot.ready;
    hasSlot = true;
    rec.status = "running";
    rec.startedAt = Date.now();
    setActivity(rec, "starting", rec.startedAt);
    rec.lastEventAt = rec.startedAt;
    options.onChange?.();

    const depth = Number(process.env[DEPTH_ENV] ?? "0") + 1;
    const timeoutMinutes = spec.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(options.command.cmd, [...options.command.prefix, ...buildChildArgs(spec, options)], {
        cwd: rec.cwd,
        env: { ...process.env, [DEPTH_ENV]: String(depth) },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const send = (command: Record<string, unknown>) => {
        if (child.stdin.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
      };
      // A child that exits while we write reports through "close", not through this stream.
      child.stdin.on("error", () => {});

      const kill = (why: string) => {
        rec.error = why;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
      };
      rec.stop = kill;
      rec.steer = (message) => {
        rec.userMessages.push(message);
        addTranscript(rec, "user", message);
        send({ type: "steer", message });
      };

      const finish = () => {
        settled = true;
        rec.steer = undefined;
        child.stdin.end();
        // The run is over: a child that ignores end of input must not hold the report back.
        setTimeout(() => child.kill("SIGTERM"), SETTLE_EXIT_GRACE_MS).unref();
      };

      const onRecord = (line: string) => {
        if (!line) return;
        let ev: Record<string, any>;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === "response") {
          if (ev.command === "get_state" && typeof ev.data?.sessionId === "string") rec.sessionId = ev.data.sessionId;
          if (ev.command === "prompt" && ev.success === false) kill(String(ev.error ?? "prompt rejected"));
          return;
        }
        if (ev.type === "extension_ui_request") {
          // Nobody can answer a dialog from a background child; without a reply it would wait forever.
          if (DIALOG_METHODS.has(ev.method)) send({ type: "extension_ui_response", id: ev.id, cancelled: true });
          return;
        }
        applyEvent(rec, ev);
        if (ev.type === "agent_settled") finish();
      };

      // JSONL framing: split on LF only (readline would also split on U+2028/2029).
      let pending = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        pending += chunk;
        let i = pending.indexOf("\n");
        while (i >= 0) {
          onRecord(pending.slice(0, i).replace(/\r$/, ""));
          pending = pending.slice(i + 1);
          i = pending.indexOf("\n");
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => {
        stderr = (stderr + d).slice(-8000);
      });

      const timer = setTimeout(() => kill(`timeout after ${timeoutMinutes} min`), timeoutMinutes * 60_000);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        onRecord(pending.trim());
        code = exitCode;
        resolve();
      });

      send({ id: "state", type: "get_state" });
      send({ id: "prompt", type: "prompt", message: spec.brief });
    });
  } catch (err) {
    rec.error ??= err instanceof Error ? err.message.split("\n")[0] : String(err);
  } finally {
    rec.stop = undefined;
    rec.steer = undefined;
    if (hasSlot) options.semaphore.release();
  }

  rec.endedAt = Date.now();
  rec.startedAt ??= rec.endedAt;
  const failed = rec.error !== undefined || !settled || rec.stopReason === "error" || rec.stopReason === "aborted";
  rec.status = rec.error?.startsWith("stopped") ? "aborted" : failed ? "failed" : "done";
  if (failed && !rec.error) {
    rec.error = settled ? `stopReason ${rec.stopReason ?? "?"}` : `exited with code ${code} before finishing`;
  }
  addTranscript(rec, "notice", `${rec.status}${rec.error ? `: ${rec.error}` : ""}`);

  await mkdir(options.reportDir, { recursive: true });
  // The name comes from the model, so it must not be able to choose the directory.
  const safeName = spec.name.replace(/[^\w-]+/g, "_");
  rec.reportPath = join(options.reportDir, `${safeName}-${rec.startedAt}.md`);
  await writeFile(
    rec.reportPath,
    `# ${spec.name}\n\n- status: ${rec.status}\n- session: ${rec.sessionId ?? "?"}\n- cwd: ${rec.cwd}\n- exit: ${code}\n- stopReason: ${rec.stopReason ?? "?"}\n\n## Brief\n\n${spec.brief}\n\n## Final report\n\n${rec.finalText || "(no assistant text)"}\n\n## stderr tail\n\n${stderr}\n`,
  );

  return {
    name: spec.name,
    status: rec.status,
    session_id: rec.sessionId,
    report_path: rec.reportPath,
    tool_calls: rec.toolCalls,
    duration_s: Math.round((rec.endedAt - rec.startedAt) / 1000),
    error: rec.error,
    user_messages: rec.userMessages,
    final_text: rec.finalText || (failed ? `stderr tail:\n${stderr.slice(-2000)}` : ""),
  };
}

export function reportText(r: AgentReport): string {
  const tail =
    r.final_text.length > RESULT_TAIL_CHARS
      ? `…(truncated, full text in report)\n${r.final_text.slice(-RESULT_TAIL_CHARS)}`
      : r.final_text;
  // The orchestrator wrote the brief but did not see these, so a changed plan must not read as a disobedient agent.
  const steered = r.user_messages?.length
    ? `\n\nThe user messaged this agent directly during the run:\n${r.user_messages.map((m) => `- ${m}`).join("\n")}`
    : "";
  return (
    `Agent ${r.name}: ${r.status.toUpperCase()}${r.error ? ` (${r.error})` : ""} · ${r.tool_calls} tool calls · ${r.duration_s}s\n` +
    `session_id: ${r.session_id ?? "?"} (pass as resume_session to continue this agent)\n` +
    `report: ${r.report_path}${steered}\n\nFinal report:\n${tail}`
  );
}
