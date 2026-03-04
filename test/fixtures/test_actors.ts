// test/fixtures/test_actors.ts
// Actor definitions that can be loaded by NodeWorker via actorModules.
// These are required in-process by the worker, so closures/functions survive.

import { createActor } from "../../src";

export const Counter = createActor((ctx, self, initial: number) => {
  let count = initial;
  return self
    .onCall("get", () => count)
    .onCall("increment", () => ++count)
    .onCast("set", (v: number) => {
      count = v;
    });
});
