import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDuration, formatTokens, shortArgs, textOf } from "../src/format.ts";

describe("format", () => {
  it("formats durations", () => {
    assert.equal(formatDuration(-5), "0s");
    assert.equal(formatDuration(59_000), "59s");
    assert.equal(formatDuration(61_000), "1m01s");
    assert.equal(formatDuration(3_660_000), "1h01m");
  });

  it("formats tokens", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1500), "1.5k");
  });

  it("puts tool arguments on one line", () => {
    assert.equal(shortArgs({ command: "a\n  b" }), "a b");
    assert.equal(shortArgs(null), "");
  });

  it("extracts message text", () => {
    assert.equal(textOf({ content: "x" }), "x");
    assert.equal(
      textOf({ content: [{ type: "text", text: "a" }, { type: "thinking" }, { type: "text", text: "b" }] }),
      "a\nb",
    );
    assert.equal(textOf({}), "");
  });
});
