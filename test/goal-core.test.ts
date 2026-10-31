import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  lastAssistantText,
  parseGoalArgs,
  parseVerdict,
  TRANSCRIPT_BUDGET_CHARS,
  transcriptTail,
  withTimeout,
} from "../src/goal-core.ts";

describe("parseGoalArgs", () => {
  it("reads flags in any order and keeps the rest as the objective", () => {
    assert.deepEqual(parseGoalArgs(`--max 3 --check "pnpm test" fix the build`), {
      check: "pnpm test",
      max: 3,
      objective: "fix the build",
    });
    assert.deepEqual(parseGoalArgs(`--check='a b' x`), { check: "a b", max: undefined, objective: "x" });
    assert.deepEqual(parseGoalArgs("--max=2 x"), { check: undefined, max: 2, objective: "x" });
  });

  it("leaves flags inside the objective alone", () => {
    assert.equal(parseGoalArgs("run with --max 3 please").objective, "run with --max 3 please");
  });
});

describe("parseVerdict", () => {
  it("reads a verdict surrounded by prose", () => {
    assert.deepEqual(parseVerdict('Sure.\n{"done": false, "reason": "tests fail"}\n'), {
      done: false,
      reason: "tests fail",
    });
  });

  it("rejects anything that is not a boolean verdict", () => {
    for (const bad of ["no json", '{"done": "yes"}', '{"done": tru}']) assert.equal(parseVerdict(bad), null);
  });
});

describe("transcriptTail", () => {
  it("keeps the newest content inside the budget, oldest first", () => {
    const messages = [
      { role: "user", content: "old".repeat(TRANSCRIPT_BUDGET_CHARS) },
      { role: "assistant", content: "NEWEST" },
    ];
    const tail = transcriptTail(messages);
    assert.ok(tail.length <= TRANSCRIPT_BUDGET_CHARS);
    assert.ok(tail.endsWith("NEWEST"));
  });

  it("shows tool calls and caps tool results", () => {
    const tail = transcriptTail([
      { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
      { role: "toolResult", toolName: "bash", content: "r".repeat(5000) },
    ]);
    assert.match(tail, /\[tool bash/);
    assert.ok(tail.length < 2500);
  });
});

describe("lastAssistantText", () => {
  it("skips assistant messages with no text", () => {
    const messages = [
      { role: "assistant", content: "BLOCKED: which one?" },
      { role: "assistant", content: [] },
      { role: "user", content: "hi" },
    ];
    assert.equal(lastAssistantText(messages), "BLOCKED: which one?");
  });
});

describe("withTimeout", () => {
  it("rejects with a clear message when the work never ends", async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 5, "the judge"), /the judge gave no answer/);
  });

  it("rejects on abort even when the work ignores its signal", async () => {
    const controller = new AbortController();
    const pending = withTimeout(new Promise(() => {}), 60_000, "the judge", controller.signal);
    controller.abort();
    await assert.rejects(pending, /the judge was cancelled/);
  });

  it("passes the result through", async () => {
    assert.equal(await withTimeout(Promise.resolve(1), 1000, "x"), 1);
  });
});
