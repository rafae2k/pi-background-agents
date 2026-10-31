import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Semaphore } from "../src/semaphore.ts";

describe("Semaphore", () => {
  it("grants up to the limit and hands slots over in order", async () => {
    const s = new Semaphore(1);
    await s.acquire().ready;
    const order: string[] = [];
    const b = s.acquire().ready.then(() => order.push("b"));
    const c = s.acquire().ready.then(() => order.push("c"));
    s.release();
    await b;
    assert.equal(s.live, 1);
    s.release();
    await c;
    assert.deepEqual(order, ["b", "c"]);
  });

  it("a cancelled waiter rejects and never takes a slot", async () => {
    const s = new Semaphore(1);
    await s.acquire().ready;
    const waiter = s.acquire();
    waiter.cancel("stopped");
    await assert.rejects(waiter.ready, /stopped/);
    s.release();
    assert.equal(s.live, 0);
  });
});
