import assert from "node:assert/strict";
import test from "node:test";

import { ReadWriteCoordinator } from "../src/mcp/coordinator.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("independent reads run concurrently", async () => {
  const coordinator = new ReadWriteCoordinator();
  const release = deferred();
  const bothStarted = deferred();
  let activeReaders = 0;
  let maximumReaders = 0;
  const read = () =>
    coordinator.read(async () => {
      activeReaders += 1;
      maximumReaders = Math.max(maximumReaders, activeReaders);
      if (activeReaders === 2) bothStarted.resolve();
      await release.promise;
      activeReaders -= 1;
    });

  const reads = [read(), read()];
  await bothStarted.promise;
  assert.equal(maximumReaders, 2);
  release.resolve();
  await Promise.all(reads);
});

test("writers are exclusive and a failed writer releases the queue", async () => {
  const coordinator = new ReadWriteCoordinator();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const events: string[] = [];
  const first = coordinator.write(async () => {
    events.push("first-started");
    firstStarted.resolve();
    await releaseFirst.promise;
    events.push("first-finished");
  });
  await firstStarted.promise;
  const second = coordinator.write(async () => {
    events.push("second-started");
    throw new Error("Injected writer failure.");
  });
  const read = coordinator.read(async () => {
    events.push("read-started");
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["first-started"]);

  releaseFirst.resolve();
  await first;
  await assert.rejects(second, /Injected writer failure/);
  await read;
  assert.deepEqual(events, [
    "first-started",
    "first-finished",
    "second-started",
    "read-started",
  ]);
});
