import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyEvent,
  buildChildArgs,
  createRecord,
  DEFAULT_MAX_PARALLEL,
  parseMaxParallel,
  reportText,
  runAgent,
} from "../src/agent-runner.ts";
import { Semaphore } from "../src/semaphore.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const reportDir = join(tmpdir(), "pi-background-agents-test");

function run(brief: string, name = "a", semaphore = new Semaphore(3)) {
  const spec = { name, brief };
  const rec = createRecord(spec, process.cwd());
  const options = { semaphore, command: { cmd: process.execPath, prefix: [fake] }, reportDir, approve: false };
  return { rec, report: runAgent(spec, rec, options) };
}

describe("applyEvent", () => {
  it("tracks the running tool, then goes back to waiting", () => {
    const rec = createRecord({ name: "a", brief: "" }, "/", 0);
    applyEvent(rec, { type: "tool_execution_start", toolName: "bash", args: { command: "pnpm  test" } }, 10);
    assert.equal(rec.activity, "bash pnpm test");
    assert.equal(rec.toolRunning, true);
    assert.equal(rec.toolCalls, 1);
    applyEvent(rec, { type: "tool_execution_end", toolName: "bash" }, 20);
    assert.equal(rec.toolRunning, false);
    assert.equal(rec.activitySince, 20);
  });

  it("does not restart the activity clock on repeated deltas", () => {
    const rec = createRecord({ name: "a", brief: "" }, "/", 0);
    const delta = { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } };
    applyEvent(rec, delta, 5);
    applyEvent(rec, delta, 9);
    assert.equal(rec.activitySince, 5);
    assert.equal(rec.lastEventAt, 9);
  });

  it("keeps the last assistant text and sums output tokens", () => {
    const rec = createRecord({ name: "a", brief: "" }, "/");
    const end = (text: string) => ({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { output: 4 } },
    });
    applyEvent(rec, end("first"));
    applyEvent(rec, end("second"));
    applyEvent(rec, { type: "message_end", message: { role: "user", content: "ignored" } });
    assert.equal(rec.finalText, "second");
    assert.equal(rec.outputTokens, 8);
  });

  it("builds the transcript from deltas without repeating the final text", () => {
    const rec = createRecord({ name: "a", brief: "the brief" }, "/");
    applyEvent(rec, { type: "message_start", message: { role: "assistant" } });
    for (const delta of ["hel", "lo"]) {
      applyEvent(rec, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
    }
    applyEvent(rec, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" },
    });
    assert.deepEqual(rec.transcript, [
      { kind: "user", text: "the brief" },
      { kind: "text", text: "hello" },
    ]);
  });

  it("adds the final text when the provider sent no deltas, and shows tool output", () => {
    const rec = createRecord({ name: "a", brief: "b" }, "/");
    applyEvent(rec, { type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
    applyEvent(rec, {
      type: "tool_execution_end",
      toolName: "bash",
      result: { content: [{ type: "text", text: "x" }] },
    });
    applyEvent(rec, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "whole" }], stopReason: "stop" },
    });
    assert.deepEqual(
      rec.transcript.slice(1).map((e) => e.kind),
      ["tool", "result", "text"],
    );
  });

  it("shows provider retries", () => {
    const rec = createRecord({ name: "a", brief: "" }, "/");
    applyEvent(rec, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "529 overloaded" });
    assert.match(rec.activity, /provider retry 1\/3: 529 overloaded/);
  });
});

describe("buildChildArgs", () => {
  it("names a new agent and never puts the brief on the command line", () => {
    const args = buildChildArgs({ name: "a", brief: "--not-a-flag" }, { approve: true });
    assert.deepEqual(args, ["--mode", "rpc", "--name", "agent:a", "--approve"]);
  });

  it("resumes a session instead of naming a new one", () => {
    const args = buildChildArgs({ name: "a", brief: "b", resume_session: "s1" }, { approve: false });
    assert.ok(args.includes("s1"));
    assert.ok(!args.includes("--name"));
    assert.ok(args.includes("--no-approve"));
  });

  it("inherits the parent model unless the agent names its own", () => {
    const inherited = buildChildArgs({ name: "a", brief: "b" }, { approve: true, defaultModel: "p/m" });
    assert.equal(inherited[inherited.indexOf("--model") + 1], "p/m");
    const own = buildChildArgs({ name: "a", brief: "b", model: "x/y" }, { approve: true, defaultModel: "p/m" });
    assert.equal(own[own.indexOf("--model") + 1], "x/y");
  });
});

describe("parseMaxParallel", () => {
  it("accepts positive integers and falls back otherwise", () => {
    assert.equal(parseMaxParallel("5"), 5);
    for (const bad of [undefined, "", "0", "-1", "2.5", "many"])
      assert.equal(parseMaxParallel(bad), DEFAULT_MAX_PARALLEL);
  });
});

describe("runAgent against a real child process", () => {
  it("reports success with session, tools and the final text", async () => {
    const { rec, report } = run("ok");
    const r = await report;
    assert.equal(r.status, "done");
    assert.equal(r.session_id, "fake-session");
    assert.equal(r.tool_calls, 1);
    assert.equal(rec.outputTokens, 7);
    assert.match(await readFile(r.report_path as string, "utf8"), /status: done/);
  });

  it("splits records on LF only, so U+2028 inside a record survives", async () => {
    const r = await run("ok").report;
    assert.equal(r.final_text, "line separator survives");
  });

  it("rebuilds a record split across writes", async () => {
    const r = await run("split").report;
    assert.equal(r.status, "done");
    assert.equal(r.final_text, "from split");
  });

  it("does not call a run done when the child exits before settling", async () => {
    const r = await run("exit0-early").report;
    assert.equal(r.status, "failed");
    assert.match(r.error as string, /before finishing/);
  });

  it("fails when the prompt is rejected", async () => {
    const r = await run("rejected").report;
    assert.equal(r.status, "failed");
    assert.equal(r.error, "no model");
  });

  it("answers extension dialogs so a background child cannot wait forever", async () => {
    const r = await run("dialog").report;
    assert.equal(r.status, "done");
    assert.equal(r.final_text, "dialog cancelled: true");
  });

  it("delivers a message to a running agent and records it", async () => {
    const { rec, report } = run("wait-steer");
    while (rec.sessionId === undefined) await new Promise((res) => setTimeout(res, 10));
    rec.steer?.("change of plan");
    const r = await report;
    assert.equal(r.final_text, "steered: change of plan");
    assert.ok(rec.transcript.some((e) => e.kind === "user" && e.text === "change of plan"));
    assert.equal(rec.steer, undefined);
    assert.match(reportText(r), /The user messaged this agent directly during the run:\n- change of plan/);
  });

  it("ends a child that ignores end of input once the run settled", async () => {
    const r = await run("ignores-eof").report;
    assert.equal(r.status, "done");
  });

  it("fails on a non-zero exit and hands back stderr", async () => {
    const r = await run("exit1").report;
    assert.equal(r.status, "failed");
    assert.match(r.error as string, /code 1/);
    assert.match(r.final_text, /boom/);
  });

  it("fails when the model turn ended in error, even with exit 0", async () => {
    const r = await run("model-error").report;
    assert.equal(r.status, "failed");
    assert.match(r.error as string, /stopReason error/);
  });

  it("stops a running child and marks it aborted", async () => {
    const { rec, report } = run("hang");
    while (rec.sessionId === undefined) await new Promise((res) => setTimeout(res, 10));
    rec.stop?.("stopped by user");
    const r = await report;
    assert.equal(r.status, "aborted");
    assert.equal(r.error, "stopped by user");
  });

  it("holds extra agents in the queue, and a queued agent can be stopped", async () => {
    const semaphore = new Semaphore(1);
    const first = run("hang", "first", semaphore);
    const second = run("ok", "second", semaphore);
    while (first.rec.sessionId === undefined) await new Promise((res) => setTimeout(res, 10));
    assert.equal(second.rec.status, "queued");
    second.rec.stop?.("stopped by user");
    assert.equal((await second.report).status, "aborted");
    first.rec.stop?.("stopped by user");
    await first.report;
    assert.equal(semaphore.live, 0);
  });

  it("releases the slot so the next queued agent runs", async () => {
    const semaphore = new Semaphore(1);
    const [a, b] = await Promise.all([run("ok", "a", semaphore).report, run("ok", "b", semaphore).report]);
    assert.equal(a.status, "done");
    assert.equal(b.status, "done");
  });

  it("does not let an agent name escape the report directory", async () => {
    const r = await run("ok", "../../evil").report;
    assert.equal(dirname(r.report_path as string), reportDir);
  });

  it("reports a command that cannot start instead of throwing", async () => {
    const spec = { name: "a", brief: "x" };
    const rec = createRecord(spec, process.cwd());
    const options = {
      semaphore: new Semaphore(1),
      command: { cmd: "/nonexistent/pi", prefix: [] },
      reportDir,
      approve: false,
    };
    const r = await runAgent(spec, rec, options);
    assert.equal(r.status, "failed");
    assert.match(r.error as string, /ENOENT/);
  });
});

describe("reportText", () => {
  it("keeps the tail of a long report", () => {
    const text = reportText({
      name: "a",
      status: "done",
      tool_calls: 1,
      duration_s: 2,
      final_text: `${"x".repeat(7000)}END`,
    });
    assert.match(text, /truncated/);
    assert.ok(text.endsWith("END"));
  });
});
