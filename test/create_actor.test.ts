import { createSystem, createActor, System, ActorRef, ChildSupervisionOptions } from "../src";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("createActor", () => {
  let system: System;

  beforeEach(() => {
    system = createSystem({ nodeId: "test-node" });
  });

  afterEach(async () => {
    await system.shutdown();
  });

  describe("basic call handlers", () => {
    it("should create an actor with a single call handler", async () => {
      const Counter = createActor((ctx, self, initialValue: number) => {
        let count = initialValue;
        self.call("get", () => count);
      });

      const ref = system.spawn(Counter as any, { args: [42] });
      const result = await ref.call({ method: "get", args: [] });
      expect(result).toBe(42);
    });

    it("should handle call handlers with arguments", async () => {
      const Calculator = createActor((ctx, self) => {
        self.call("add", (a: number, b: number) => a + b);
      });

      const ref = system.spawn(Calculator as any, {});
      const result = await ref.call({ method: "add", args: [3, 5] });
      expect(result).toBe(8);
    });
  });

  describe("basic cast handlers", () => {
    it("should create an actor with a single cast handler", async () => {
      let receivedValue: number | undefined;
      const Receiver = createActor((ctx, self) => {
        self
          .cast("receive", (value: number) => {
            receivedValue = value;
          })
          .call("getValue", () => receivedValue);
      });

      const ref = system.spawn(Receiver as any, {});
      ref.cast({ method: "receive", args: [100] });

      await new Promise((r) => setTimeout(r, 50));

      const result = await ref.call({ method: "getValue", args: [] });
      expect(result).toBe(100);
    });
  });

  describe("multiple handlers", () => {
    it("should create an actor with multiple call handlers", async () => {
      const Counter = createActor((ctx, self, initial: number) => {
        let count = initial;
        self
          .call("get", () => count)
          .call("increment", () => ++count)
          .call("decrement", () => --count)
          .call("add", (n: number) => (count += n));
      });

      const ref = system.spawn(Counter as any, { args: [10] });

      expect(await ref.call({ method: "get", args: [] })).toBe(10);
      expect(await ref.call({ method: "increment", args: [] })).toBe(11);
      expect(await ref.call({ method: "decrement", args: [] })).toBe(10);
      expect(await ref.call({ method: "add", args: [5] })).toBe(15);
    });

    it("should create an actor with multiple cast handlers", async () => {
      const Store = createActor((ctx, self) => {
        let name = "";
        let age = 0;

        self
          .cast("setName", (n: string) => {
            name = n;
          })
          .cast("setAge", (a: number) => {
            age = a;
          })
          .call("getData", () => ({ name, age }));
      });

      const ref = system.spawn(Store as any, {});

      ref.cast({ method: "setName", args: ["Alice"] });
      ref.cast({ method: "setAge", args: [30] });

      await new Promise((r) => setTimeout(r, 50));

      const data = await ref.call({ method: "getData", args: [] });
      expect(data).toEqual({ name: "Alice", age: 30 });
    });
  });

  describe("chainable registration", () => {
    it("should support chainable call and cast registration", async () => {
      const ChainedActor = createActor((ctx, self, initial: number) => {
        let value = initial;

        self
          .call("get", () => value)
          .call("double", () => value * 2)
          .cast("set", (v: number) => {
            value = v;
          })
          .cast("reset", () => {
            value = initial;
          });
      });

      const ref = system.spawn(ChainedActor as any, { args: [5] });

      expect(await ref.call({ method: "get", args: [] })).toBe(5);
      expect(await ref.call({ method: "double", args: [] })).toBe(10);

      ref.cast({ method: "set", args: [20] });
      await new Promise((r) => setTimeout(r, 50));
      expect(await ref.call({ method: "get", args: [] })).toBe(20);

      ref.cast({ method: "reset", args: [] });
      await new Promise((r) => setTimeout(r, 50));
      expect(await ref.call({ method: "get", args: [] })).toBe(5);
    });
  });

  describe("closure state isolation", () => {
    it("should maintain private state via closure", async () => {
      const Counter = createActor((ctx, self) => {
        let count = 0;
        self
          .call("increment", () => ++count)
          .call("get", () => count);
      });

      const ref1 = system.spawn(Counter as any, {});
      const ref2 = system.spawn(Counter as any, {});

      await ref1.call({ method: "increment", args: [] });
      await ref1.call({ method: "increment", args: [] });
      await ref1.call({ method: "increment", args: [] });

      await ref2.call({ method: "increment", args: [] });

      expect(await ref1.call({ method: "get", args: [] })).toBe(3);
      expect(await ref2.call({ method: "get", args: [] })).toBe(1);
    });
  });

  describe("init args", () => {
    it("should pass init args correctly to the factory function", async () => {
      const ConfigActor = createActor(
        (ctx, self, name: string, value: number, enabled: boolean) => {
          self.call("getConfig", () => ({ name, value, enabled }));
        }
      );

      const ref = system.spawn(ConfigActor as any, { args: ["test", 42, true] });
      const config = await ref.call({ method: "getConfig", args: [] });

      expect(config).toEqual({ name: "test", value: 42, enabled: true });
    });

    it("should handle actors with no init args", async () => {
      const SimpleActor = createActor((ctx, self) => {
        self.call("ping", () => "pong");
      });

      const ref = system.spawn(SimpleActor as any, {});
      const result = await ref.call({ method: "ping", args: [] });
      expect(result).toBe("pong");
    });
  });

  describe("ctx.self provides ActorRef", () => {
    it("should provide access to self ActorRef via context", async () => {
      let capturedSelfId: string | undefined;

      const SelfAwareActor = createActor((ctx, self) => {
        capturedSelfId = ctx.self.id.id;
        self.call("getSelfId", () => ctx.self.id.id);
      });

      const ref = system.spawn(SelfAwareActor as any, {});
      const selfId = await ref.call({ method: "getSelfId", args: [] });

      expect(selfId).toBe(ref.id.id);
      expect(capturedSelfId).toBe(ref.id.id);
    });
  });

  describe("ctx.parent for root actors", () => {
    it("should have undefined parent for root actors", async () => {
      let capturedParent: ActorRef | undefined;

      const RootActor = createActor((ctx, self) => {
        capturedParent = ctx.parent;
        self.call("hasParent", () => ctx.parent !== undefined);
      });

      const ref = system.spawn(RootActor as any, {});
      const hasParent = await ref.call({ method: "hasParent", args: [] });

      expect(hasParent).toBe(false);
      expect(capturedParent).toBeUndefined();
    });
  });

  describe("ctx.spawn() spawns child functional actors", () => {
    it("should spawn child functional actors", async () => {
      const ChildActor = createActor((ctx, self, name: string) => {
        self.call("getName", () => name);
      });

      const ParentActor = createActor((ctx, self) => {
        let childRef: ActorRef | null = null;

        self
          .call("spawnChild", (name: string) => {
            childRef = ctx.spawn(ChildActor, { args: [name] });
            return childRef.id.id;
          })
          .call("callChild", async () => {
            if (!childRef) return null;
            return childRef.call({ method: "getName", args: [] });
          });
      });

      const parentRef = system.spawn(ParentActor as any, {});
      const childId = await parentRef.call({
        method: "spawnChild",
        args: ["child1"],
      });

      expect(childId).toBeDefined();

      const childName = await parentRef.call({ method: "callChild", args: [] });
      expect(childName).toBe("child1");
    });
  });

  describe("ctx.watch() and info handler receives down message", () => {
    it("should receive down message when watched system actor terminates", async () => {
      let downReceived = false;
      let downActorId: string | null = null;

      const TargetActor = createActor((ctx, self) => {
        self.call("ping", () => "pong");
      });

      const WatcherActor = createActor((ctx, self) => {
        self
          .call("setTarget", (ref: ActorRef) => {
            ctx.watch(ref);
            return true;
          })
          .call("getDownStatus", () => ({ downReceived, downActorId }))
          .info("down", (msg) => {
            downReceived = true;
            downActorId = msg.actorRef?.id?.id;
          });
      });

      const targetRef = system.spawn(TargetActor as any, {});
      const watcherRef = system.spawn(WatcherActor as any, {});

      await watcherRef.call({ method: "setTarget", args: [targetRef] });

      await system.system.stop(targetRef);

      await new Promise((r) => setTimeout(r, 100));

      const status = await watcherRef.call({
        method: "getDownStatus",
        args: [],
      });
      expect(status.downReceived).toBe(true);
      expect(status.downActorId).toBe(targetRef.id.id);
    });
  });

  describe("ctx.link() and info handler receives exit message", () => {
    it("should receive exit message when linked actor terminates with trapExit", async () => {
      let exitReceived = false;
      let exitReason: any = null;

      const LinkedActor = createActor((ctx, self) => {
        self.call("ping", () => "pong");
      });

      const LinkingActor = createActor((ctx, self) => {
        ctx.setTrapExit(true);

        self
          .call("linkTo", (ref: ActorRef) => {
            ctx.link(ref);
            return true;
          })
          .call("getExitStatus", () => ({ exitReceived, exitReason }))
          .info("exit", (msg) => {
            exitReceived = true;
            exitReason = msg.reason;
          });
      });

      const linkedRef = system.spawn(LinkedActor as any, {});
      const linkingRef = system.spawn(LinkingActor as any, {});

      await linkingRef.call({ method: "linkTo", args: [linkedRef] });

      await system.system.stop(linkedRef);

      await new Promise((r) => setTimeout(r, 100));

      const status = await linkingRef.call({
        method: "getExitStatus",
        args: [],
      });
      expect(status.exitReceived).toBe(true);
    });
  });

  describe("onTerminate handler", () => {
    it("should call onTerminate handler on shutdown", async () => {
      let terminateCalled = false;

      const TerminatingActor = createActor((ctx, self) => {
        self.call("ping", () => "pong").onTerminate(() => {
          terminateCalled = true;
        });
      });

      const ref = system.spawn(TerminatingActor as any, {});

      expect(await ref.call({ method: "ping", args: [] })).toBe("pong");

      await system.system.stop(ref);

      expect(terminateCalled).toBe(true);
    });

    it("should support async onTerminate handler", async () => {
      let cleanupComplete = false;

      const AsyncTerminatingActor = createActor((ctx, self) => {
        self.call("ping", () => "pong").onTerminate(async () => {
          await new Promise((r) => setTimeout(r, 50));
          cleanupComplete = true;
        });
      });

      const ref = system.spawn(AsyncTerminatingActor as any, {});
      await system.system.stop(ref);

      expect(cleanupComplete).toBe(true);
    });
  });

  describe("onContinue", () => {
    it("should run onContinue with a sync handler", async () => {
      let continueCalled = false;

      const SyncContinueActor = createActor((ctx, self) => {
        self.onContinue<{ initialized: boolean }>((data) => {
          continueCalled = data.initialized;
        });

        return { continue: { initialized: true } };
      });

      system.spawn(SyncContinueActor as any, {});

      await new Promise((r) => setTimeout(r, 50));

      expect(continueCalled).toBe(true);
    });

    it("should run onContinue with an async handler", async () => {
      const steps: string[] = [];

      const AsyncContinueActor = createActor((ctx, self) => {
        self.onContinue<string>(async (data) => {
          steps.push(`start:${data}`);
          await new Promise((r) => setTimeout(r, 30));
          steps.push(`done:${data}`);
        });

        return { continue: "async-setup" };
      });

      system.spawn(AsyncContinueActor as any, {});

      await new Promise((r) => setTimeout(r, 80));

      expect(steps).toEqual(["start:async-setup", "done:async-setup"]);
    });

    it("should not run onContinue when factory returns void", async () => {
      let continueCallCount = 0;

      const NoContinueActor = createActor((ctx, self) => {
        self.onContinue(() => {
          continueCallCount++;
        });

        self.call("ping", () => "pong");
      });

      const ref = system.spawn(NoContinueActor as any, {});

      expect(await ref.call({ method: "ping", args: [] })).toBe("pong");
      await new Promise((r) => setTimeout(r, 50));

      expect(continueCallCount).toBe(0);
    });

    it("should pass continue data to the onContinue handler", async () => {
      let receivedData: { token: string; retries: number } | null = null;

      const DataContinueActor = createActor((ctx, self) => {
        self.onContinue<{ token: string; retries: number }>((data) => {
          receivedData = data;
        });

        return { continue: { token: "abc123", retries: 2 } };
      });

      system.spawn(DataContinueActor as any, {});

      await new Promise((r) => setTimeout(r, 50));

      expect(receivedData).toEqual({ token: "abc123", retries: 2 });
    });

    it("should remain functional after continue completes", async () => {
      const ContinueThenOperateActor = createActor((ctx, self) => {
        let count = 0;
        let ready = false;

        self
          .onContinue<number>(async (initial) => {
            await new Promise((r) => setTimeout(r, 30));
            count = initial;
            ready = true;
          })
          .call("isReady", () => ready)
          .call("get", () => count)
          .cast("add", (value: number) => {
            count += value;
          });

        return { continue: 5 };
      });

      const ref = system.spawn(ContinueThenOperateActor as any, {});

      await new Promise((r) => setTimeout(r, 80));

      expect(await ref.call({ method: "isReady", args: [] })).toBe(true);
      expect(await ref.call({ method: "get", args: [] })).toBe(5);

      ref.cast({ method: "add", args: [7] });
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call({ method: "get", args: [] })).toBe(12);
    });
  });

  describe("message stashing", () => {
    it("stash() in cast handler defers message processing", async () => {
      const DeferredActor = createActor((ctx, self) => {
        let blocked = true;
        const processed: string[] = [];

        self
          .cast("work", (value: string) => {
            if (blocked) {
              ctx.stash();
              return;
            }
            processed.push(value);
          })
          .call("release", () => {
            blocked = false;
            ctx.unstashAll();
          })
          .call("getProcessed", () => [...processed]);
      });

      const ref = system.spawn(DeferredActor as any, {});

      ref.cast({ method: "work", args: ["a"] });
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call({ method: "getProcessed", args: [] })).toEqual([]);

      await ref.call({ method: "release", args: [] });
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call({ method: "getProcessed", args: [] })).toEqual(["a"]);
    });

    it("unstashAll() replays all stashed messages in FIFO order", async () => {
      const QueueActor = createActor((ctx, self) => {
        let blocked = true;
        const processed: string[] = [];

        self
          .cast("work", (value: string) => {
            if (blocked) {
              ctx.stash();
              return;
            }
            processed.push(value);
          })
          .call("unstashEverything", () => {
            blocked = false;
            ctx.unstashAll();
          })
          .call("getProcessed", () => [...processed]);
      });

      const ref = system.spawn(QueueActor as any, {});

      ref.cast({ method: "work", args: ["first"] });
      ref.cast({ method: "work", args: ["second"] });
      ref.cast({ method: "work", args: ["third"] });
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call({ method: "getProcessed", args: [] })).toEqual([]);

      await ref.call({ method: "unstashEverything", args: [] });
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call({ method: "getProcessed", args: [] })).toEqual([
        "first",
        "second",
        "third",
      ]);
    });

    it("unstash() replays exactly one deferred message", async () => {
      const OneByOneActor = createActor((ctx, self) => {
        let blocked = true;
        const processed: string[] = [];

        self
          .cast("work", (value: string) => {
            if (blocked) {
              ctx.stash();
              return;
            }
            processed.push(value);
            blocked = true;
          })
          .call("releaseOne", () => {
            blocked = false;
            ctx.unstash();
          })
          .call("getProcessed", () => [...processed]);
      });

      const ref = system.spawn(OneByOneActor as any, {});

      ref.cast({ method: "work", args: ["one"] });
      ref.cast({ method: "work", args: ["two"] });
      ref.cast({ method: "work", args: ["three"] });
      await new Promise((r) => setTimeout(r, 50));

      await ref.call({ method: "releaseOne", args: [] });
      await new Promise((r) => setTimeout(r, 50));
      expect(await ref.call({ method: "getProcessed", args: [] })).toEqual(["one"]);

      await ref.call({ method: "releaseOne", args: [] });
      await new Promise((r) => setTimeout(r, 50));
      expect(await ref.call({ method: "getProcessed", args: [] })).toEqual([
        "one",
        "two",
      ]);

      await ref.call({ method: "releaseOne", args: [] });
      await new Promise((r) => setTimeout(r, 50));
      expect(await ref.call({ method: "getProcessed", args: [] })).toEqual([
        "one",
        "two",
        "three",
      ]);
    });

    it("clearStash() discards all stashed messages", async () => {
      const ClearableActor = createActor((ctx, self) => {
        let blocked = true;
        const processed: string[] = [];

        self
          .cast("work", (value: string) => {
            if (blocked) {
              ctx.stash();
              return;
            }
            processed.push(value);
          })
          .call("clear", () => {
            ctx.clearStash();
            blocked = false;
          })
          .call("unstashEverything", () => {
            ctx.unstashAll();
          })
          .call("getProcessed", () => [...processed]);
      });

      const ref = system.spawn(ClearableActor as any, {});

      ref.cast({ method: "work", args: ["stashed-1"] });
      ref.cast({ method: "work", args: ["stashed-2"] });
      await new Promise((r) => setTimeout(r, 50));

      await ref.call({ method: "clear", args: [] });
      await ref.call({ method: "unstashEverything", args: [] });
      ref.cast({ method: "work", args: ["fresh"] });
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call({ method: "getProcessed", args: [] })).toEqual([
        "fresh",
      ]);
    });

    it("supports stashing during async init and unstashing on onContinue", async () => {
      const InitDeferredActor = createActor((ctx, self) => {
        let ready = false;
        const processed: string[] = [];

        self
          .onContinue<string>(async () => {
            await new Promise((r) => setTimeout(r, 40));
            ready = true;
            ctx.unstashAll();
          })
          .cast("work", (value: string) => {
            if (!ready) {
              ctx.stash();
              return;
            }
            processed.push(value);
          })
          .call("getProcessed", () => [...processed]);

        return { continue: "boot" };
      });

      const ref = system.spawn(InitDeferredActor as any, {});

      ref.cast({ method: "work", args: ["during-init-1"] });
      ref.cast({ method: "work", args: ["during-init-2"] });

      await new Promise((r) => setTimeout(r, 20));
      expect(await ref.call({ method: "getProcessed", args: [] })).toEqual([]);

      await new Promise((r) => setTimeout(r, 80));
      expect(await ref.call({ method: "getProcessed", args: [] })).toEqual([
        "during-init-1",
        "during-init-2",
      ]);
    });

    it("rejects stashed call when clearStash() is invoked", async () => {
      const CallStashActor = createActor((ctx, self) => {
        let ready = false;

        self
          .call("request", (value: string) => {
            if (!ready) {
              ctx.stash();
              return;
            }
            return `processed:${value}`;
          })
          .call("clear", () => {
            ctx.clearStash();
          })
          .call("setReady", () => {
            ready = true;
            ctx.unstashAll();
          });
      });

      const ref = system.spawn(CallStashActor as any, {});

      const pending = ref.call({ method: "request", args: ["hello"] }, 5000);

      await new Promise((r) => setTimeout(r, 20));
      await ref.call({ method: "clear", args: [] });

      await expect(pending).rejects.toThrow("Stashed message discarded");
    });
  });

  describe("actor with both call and cast handlers", () => {
    it("should support both call and cast handlers on the same actor", async () => {
      const StatefulActor = createActor((ctx, self) => {
        let messages: string[] = [];
        let processedCount = 0;

        self
          .call("getMessages", () => [...messages])
          .call("getProcessedCount", () => processedCount)
          .call("processMessage", (msg: string) => {
            messages.push(msg);
            processedCount++;
            return processedCount;
          })
          .cast("addMessage", (msg: string) => {
            messages.push(msg);
          })
          .cast("clearMessages", () => {
            messages = [];
          });
      });

      const ref = system.spawn(StatefulActor as any, {});

      expect(await ref.call({ method: "processMessage", args: ["hello"] })).toBe(
        1
      );
      expect(await ref.call({ method: "getProcessedCount", args: [] })).toBe(1);

      ref.cast({ method: "addMessage", args: ["world"] });
      ref.cast({ method: "addMessage", args: ["!"] });

      await new Promise((r) => setTimeout(r, 50));

      const messages = await ref.call({ method: "getMessages", args: [] });
      expect(messages).toEqual(["hello", "world", "!"]);

      ref.cast({ method: "clearMessages", args: [] });
      await new Promise((r) => setTimeout(r, 50));

      const clearedMessages = await ref.call({
        method: "getMessages",
        args: [],
      });
      expect(clearedMessages).toEqual([]);
    });
  });

  describe("unknown method throws error", () => {
    it("should throw error for unknown call method", async () => {
      const SimpleActor = createActor((ctx, self) => {
        self.call("known", () => "ok");
      });

      const ref = system.spawn(SimpleActor as any, {});

      await expect(
        ref.call({ method: "unknown", args: [] })
      ).rejects.toThrow("Unknown call method: unknown");
    });

    it("should not throw for unknown cast method (silent ignore)", async () => {
      const SimpleActor = createActor((ctx, self) => {
        self
          .cast("known", () => {})
          .call("ping", () => "pong");
      });

      const ref = system.spawn(SimpleActor as any, {});

      ref.cast({ method: "unknown", args: [] });

      await new Promise((r) => setTimeout(r, 50));
      const result = await ref.call({ method: "ping", args: [] });
      expect(result).toBe("pong");
    });
  });

  describe("complex scenarios", () => {
    it("should handle actors returning promises from call handlers", async () => {
      const AsyncActor = createActor((ctx, self) => {
        self.call("asyncOperation", async (delay: number) => {
          await new Promise((r) => setTimeout(r, delay));
          return "done";
        });
      });

      const ref = system.spawn(AsyncActor as any, { args: [50] });
      const result = await ref.call({ method: "asyncOperation", args: [50] });
      expect(result).toBe("done");
    });

    it("should handle errors thrown in call handlers", async () => {
      const ErrorActor = createActor((ctx, self) => {
        self.call("fail", () => {
          throw new Error("intentional error");
        });
      });

      const ref = system.spawn(ErrorActor as any, {});

      await expect(ref.call({ method: "fail", args: [] })).rejects.toThrow(
        "intentional error"
      );
    });

    it("should handle multiple actors of the same definition", async () => {
      const Counter = createActor((ctx, self, initial: number) => {
        let count = initial;
        self
          .call("get", () => count)
          .cast("add", (n: number) => {
            count += n;
          });
      });

      const refs = [
        system.spawn(Counter as any, { args: [0] }),
        system.spawn(Counter as any, { args: [100] }),
        system.spawn(Counter as any, { args: [1000] }),
      ];

      refs[0].cast({ method: "add", args: [1] });
      refs[1].cast({ method: "add", args: [10] });
      refs[2].cast({ method: "add", args: [100] });

      await new Promise((r) => setTimeout(r, 50));

      expect(await refs[0].call({ method: "get", args: [] })).toBe(1);
      expect(await refs[1].call({ method: "get", args: [] })).toBe(110);
      expect(await refs[2].call({ method: "get", args: [] })).toBe(1100);
    });
  });

  describe("childSupervision", () => {
    const restartEvents: string[] = [];
    const terminationEvents: string[] = [];

    beforeEach(() => {
      restartEvents.length = 0;
      terminationEvents.length = 0;
    });

    const CrashableChild = createActor((ctx, self, name: string) => {
      restartEvents.push(`init:${name}`);
      self
        .call("getName", () => name)
        .cast("crash", () => {
          throw new Error(`${name} crashed`);
        })
        .onTerminate(() => {
          terminationEvents.push(`terminate:${name}`);
        });
    });

    it("should use default one-for-one supervision when not set", async () => {
      const Parent = createActor((ctx, self) => {
        self.call("spawnChild", (name: string) => {
          return ctx.spawn(CrashableChild, { args: [name] });
        });
      });

      const parentRef = system.spawn(Parent as any, {});

      const child1 = await parentRef.call({ method: "spawnChild", args: ["w1"] });
      const child2 = await parentRef.call({ method: "spawnChild", args: ["w2"] });
      const child3 = await parentRef.call({ method: "spawnChild", args: ["w3"] });

      restartEvents.length = 0;
      terminationEvents.length = 0;

      // Crash child2 - with default one-for-one, only child2 should restart
      child2.cast({ method: "crash", args: [] });
      await new Promise((r) => setTimeout(r, 300));

      expect(restartEvents).toContain("init:w2");
      expect(restartEvents).not.toContain("init:w1");
      expect(restartEvents).not.toContain("init:w3");
    });

    it("should use custom one-for-all strategy", async () => {
      const OneForAllParent = createActor((ctx, self) => {
        self
          .childSupervision({
            strategy: "one-for-all",
            maxRestarts: 3,
            periodMs: 5000,
          })
          .call("spawnChild", (name: string) => {
            return ctx.spawn(CrashableChild, { args: [name] });
          });
      });

      const parentRef = system.spawn(OneForAllParent as any, {});

      const child1 = await parentRef.call({ method: "spawnChild", args: ["w1"] });
      await parentRef.call({ method: "spawnChild", args: ["w2"] });
      await parentRef.call({ method: "spawnChild", args: ["w3"] });

      restartEvents.length = 0;
      terminationEvents.length = 0;

      child1.cast({ method: "crash", args: [] });
      await new Promise((r) => setTimeout(r, 300));

      expect(terminationEvents).toContain("terminate:w1");
      expect(terminationEvents).toContain("terminate:w2");
      expect(terminationEvents).toContain("terminate:w3");

      expect(restartEvents).toContain("init:w1");
      expect(restartEvents).toContain("init:w2");
      expect(restartEvents).toContain("init:w3");
    });

    it("should use custom rest-for-one strategy", async () => {
      const RestForOneParent = createActor((ctx, self) => {
        self
          .childSupervision({
            strategy: "rest-for-one",
            maxRestarts: 3,
            periodMs: 5000,
          })
          .call("spawnChild", (name: string) => {
            return ctx.spawn(CrashableChild, { args: [name] });
          });
      });

      const parentRef = system.spawn(RestForOneParent as any, {});

      await parentRef.call({ method: "spawnChild", args: ["w1"] });
      const child2 = await parentRef.call({ method: "spawnChild", args: ["w2"] });
      await parentRef.call({ method: "spawnChild", args: ["w3"] });

      restartEvents.length = 0;
      terminationEvents.length = 0;

      child2.cast({ method: "crash", args: [] });
      await new Promise((r) => setTimeout(r, 300));

      expect(terminationEvents).toContain("terminate:w2");
      expect(terminationEvents).toContain("terminate:w3");
      expect(terminationEvents).not.toContain("terminate:w1");

      expect(restartEvents).toContain("init:w2");
      expect(restartEvents).toContain("init:w3");
      expect(restartEvents).not.toContain("init:w1");
    });

    it("should enforce max restart limit", async () => {
      const LimitedParent = createActor((ctx, self) => {
        self
          .childSupervision({
            strategy: "one-for-one",
            maxRestarts: 2,
            periodMs: 10000,
          })
          .call("spawnChild", (name: string) => {
            return ctx.spawn(CrashableChild, { args: [name] });
          })
          .call("crashChild", () => {
            const parentActor = system.system.getActor(ctx.self.id.id);
            if (parentActor && parentActor.context.children.size > 0) {
              const child = Array.from(parentActor.context.children)[0];
              child.cast({ method: "crash", args: [] });
              return true;
            }
            return false;
          })
          .call("childCount", () => {
            const parentActor = system.system.getActor(ctx.self.id.id);
            return parentActor ? parentActor.context.children.size : 0;
          });
      });

      const parentRef = system.spawn(LimitedParent as any, {});
      await parentRef.call({ method: "spawnChild", args: ["doomed"] });

      restartEvents.length = 0;

      await parentRef.call({ method: "crashChild", args: [] });
      await new Promise((r) => setTimeout(r, 300));

      await parentRef.call({ method: "crashChild", args: [] });
      await new Promise((r) => setTimeout(r, 300));

      await parentRef.call({ method: "crashChild", args: [] });
      await new Promise((r) => setTimeout(r, 300));

      expect(restartEvents.filter((e) => e === "init:doomed").length).toBe(2);

      const remaining = await parentRef.call({ method: "childCount", args: [] });
      expect(remaining).toBe(0);
    });
  });
});
