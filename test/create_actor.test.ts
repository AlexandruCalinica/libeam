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

      const ref = system.spawn(Counter, { args: [42] });
      const result = await ref.call("get");
      expect(result).toBe(42);
    });

    it("should handle call handlers with arguments", async () => {
      const Calculator = createActor((ctx, self) => {
        self.call("add", (a: number, b: number) => a + b);
      });

      const ref = system.spawn(Calculator, {});
      const result = await ref.call("add", 3, 5);
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

      const ref = system.spawn(Receiver, {});
      ref.cast("receive", 100);

      await new Promise((r) => setTimeout(r, 50));

      const result = await ref.call("getValue");
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

      const ref = system.spawn(Counter, { args: [10] });

      expect(await ref.call("get")).toBe(10);
      expect(await ref.call("increment")).toBe(11);
      expect(await ref.call("decrement")).toBe(10);
      expect(await ref.call("add", 5)).toBe(15);
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

      const ref = system.spawn(Store, {});

      ref.cast("setName", "Alice");
      ref.cast("setAge", 30);

      await new Promise((r) => setTimeout(r, 50));

      const data = await ref.call("getData");
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

      const ref = system.spawn(ChainedActor, { args: [5] });

      expect(await ref.call("get")).toBe(5);
      expect(await ref.call("double")).toBe(10);

      ref.cast("set", 20);
      await new Promise((r) => setTimeout(r, 50));
      expect(await ref.call("get")).toBe(20);

      ref.cast("reset");
      await new Promise((r) => setTimeout(r, 50));
      expect(await ref.call("get")).toBe(5);
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

      const ref1 = system.spawn(Counter, {});
      const ref2 = system.spawn(Counter, {});

      await ref1.call("increment");
      await ref1.call("increment");
      await ref1.call("increment");

      await ref2.call("increment");

      expect(await ref1.call("get")).toBe(3);
      expect(await ref2.call("get")).toBe(1);
    });
  });

  describe("init args", () => {
    it("should pass init args correctly to the factory function", async () => {
      const ConfigActor = createActor(
        (ctx, self, name: string, value: number, enabled: boolean) => {
          self.call("getConfig", () => ({ name, value, enabled }));
        }
      );

      const ref = system.spawn(ConfigActor, { args: ["test", 42, true] });
      const config = await ref.call("getConfig");

      expect(config).toEqual({ name: "test", value: 42, enabled: true });
    });

    it("should handle actors with no init args", async () => {
      const SimpleActor = createActor((ctx, self) => {
        self.call("ping", () => "pong");
      });

      const ref = system.spawn(SimpleActor, {});
      const result = await ref.call("ping");
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

      const ref = system.spawn(SelfAwareActor, {});
      const selfId = await ref.call("getSelfId");

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

      const ref = system.spawn(RootActor, {});
      const hasParent = await ref.call("hasParent");

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
            return childRef.call("getName");
          });
      });

      const parentRef = system.spawn(ParentActor, {});
      const childId = await parentRef.call("spawnChild", "child1");

      expect(childId).toBeDefined();

      const childName = await parentRef.call("callChild");
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

      const targetRef = system.spawn(TargetActor, {});
      const watcherRef = system.spawn(WatcherActor, {});

      await watcherRef.call("setTarget", targetRef);

      await system.system.stop(targetRef);

      await new Promise((r) => setTimeout(r, 100));

      const status = await watcherRef.call("getDownStatus");
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

      const linkedRef = system.spawn(LinkedActor, {});
      const linkingRef = system.spawn(LinkingActor, {});

      await linkingRef.call("linkTo", linkedRef);

      await system.system.stop(linkedRef);

      await new Promise((r) => setTimeout(r, 100));

      const status = await linkingRef.call("getExitStatus");
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

      const ref = system.spawn(TerminatingActor, {});

      expect(await ref.call("ping")).toBe("pong");

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

      const ref = system.spawn(AsyncTerminatingActor, {});
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

      system.spawn(SyncContinueActor, {});

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

      system.spawn(AsyncContinueActor, {});

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

      const ref = system.spawn(NoContinueActor, {});

      expect(await ref.call("ping")).toBe("pong");
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

      system.spawn(DataContinueActor, {});

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

      const ref = system.spawn(ContinueThenOperateActor, {});

      await new Promise((r) => setTimeout(r, 80));

      expect(await ref.call("isReady")).toBe(true);
      expect(await ref.call("get")).toBe(5);

      ref.cast("add", 7);
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call("get")).toBe(12);
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

      const ref = system.spawn(DeferredActor, {});

      ref.cast("work", "a");
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call("getProcessed")).toEqual([]);

      await ref.call("release");
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call("getProcessed")).toEqual(["a"]);
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

      const ref = system.spawn(QueueActor, {});

      ref.cast("work", "first");
      ref.cast("work", "second");
      ref.cast("work", "third");
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call("getProcessed")).toEqual([]);

      await ref.call("unstashEverything");
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call("getProcessed")).toEqual([
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

      const ref = system.spawn(OneByOneActor, {});

      ref.cast("work", "one");
      ref.cast("work", "two");
      ref.cast("work", "three");
      await new Promise((r) => setTimeout(r, 50));

      await ref.call("releaseOne");
      await new Promise((r) => setTimeout(r, 50));
      expect(await ref.call("getProcessed")).toEqual(["one"]);

      await ref.call("releaseOne");
      await new Promise((r) => setTimeout(r, 50));
      expect(await ref.call("getProcessed")).toEqual([
        "one",
        "two",
      ]);

      await ref.call("releaseOne");
      await new Promise((r) => setTimeout(r, 50));
      expect(await ref.call("getProcessed")).toEqual([
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

      const ref = system.spawn(ClearableActor, {});

      ref.cast("work", "stashed-1");
      ref.cast("work", "stashed-2");
      await new Promise((r) => setTimeout(r, 50));

      await ref.call("clear");
      await ref.call("unstashEverything");
      ref.cast("work", "fresh");
      await new Promise((r) => setTimeout(r, 50));

      expect(await ref.call("getProcessed")).toEqual([
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

      const ref = system.spawn(InitDeferredActor, {});

      ref.cast("work", "during-init-1");
      ref.cast("work", "during-init-2");

      await new Promise((r) => setTimeout(r, 20));
      expect(await ref.call("getProcessed")).toEqual([]);

      await new Promise((r) => setTimeout(r, 80));
      expect(await ref.call("getProcessed")).toEqual([
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

      const ref = system.spawn(CallStashActor, {});

      const pending = ref.call("request", "hello");

      await new Promise((r) => setTimeout(r, 20));
      await ref.call("clear");

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

      const ref = system.spawn(StatefulActor, {});

      expect(await ref.call("processMessage", "hello")).toBe(
        1
      );
      expect(await ref.call("getProcessedCount")).toBe(1);

      ref.cast("addMessage", "world");
      ref.cast("addMessage", "!");

      await new Promise((r) => setTimeout(r, 50));

      const messages = await ref.call("getMessages");
      expect(messages).toEqual(["hello", "world", "!"]);

      ref.cast("clearMessages");
      await new Promise((r) => setTimeout(r, 50));

      const clearedMessages = await ref.call("getMessages");
      expect(clearedMessages).toEqual([]);
    });
  });

  describe("unknown method throws error", () => {
    it("should throw error for unknown call method", async () => {
      const SimpleActor = createActor((ctx, self) => {
        self.call("known", () => "ok");
      });

      const ref = system.spawn(SimpleActor, {});

      await expect(
        ref.call("unknown")
      ).rejects.toThrow("Unknown call method: unknown");
    });

    it("should not throw for unknown cast method (silent ignore)", async () => {
      const SimpleActor = createActor((ctx, self) => {
        self
          .cast("known", () => {})
          .call("ping", () => "pong");
      });

      const ref = system.spawn(SimpleActor, {});

      ref.cast("unknown");

      await new Promise((r) => setTimeout(r, 50));
      const result = await ref.call("ping");
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

      const ref = system.spawn(AsyncActor, { args: [50] });
      const result = await ref.call("asyncOperation", 50);
      expect(result).toBe("done");
    });

    it("should handle errors thrown in call handlers", async () => {
      const ErrorActor = createActor((ctx, self) => {
        self.call("fail", () => {
          throw new Error("intentional error");
        });
      });

      const ref = system.spawn(ErrorActor, {});

      await expect(ref.call("fail")).rejects.toThrow(
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
        system.spawn(Counter, { args: [0] }),
        system.spawn(Counter, { args: [100] }),
        system.spawn(Counter, { args: [1000] }),
      ];

      refs[0].cast("add", 1);
      refs[1].cast("add", 10);
      refs[2].cast("add", 100);

      await new Promise((r) => setTimeout(r, 50));

      expect(await refs[0].call("get")).toBe(1);
      expect(await refs[1].call("get")).toBe(110);
      expect(await refs[2].call("get")).toBe(1100);
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

      const parentRef = system.spawn(Parent, {});

      const child1 = await parentRef.call("spawnChild", "w1");
      const child2 = await parentRef.call("spawnChild", "w2");
      const child3 = await parentRef.call("spawnChild", "w3");

      restartEvents.length = 0;
      terminationEvents.length = 0;

      // Crash child2 - with default one-for-one, only child2 should restart
      child2.cast("crash");
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

      const parentRef = system.spawn(OneForAllParent, {});

      const child1 = await parentRef.call("spawnChild", "w1");
      await parentRef.call("spawnChild", "w2");
      await parentRef.call("spawnChild", "w3");

      restartEvents.length = 0;
      terminationEvents.length = 0;

      child1.cast("crash");
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

      const parentRef = system.spawn(RestForOneParent, {});

      await parentRef.call("spawnChild", "w1");
      const child2 = await parentRef.call("spawnChild", "w2");
      await parentRef.call("spawnChild", "w3");

      restartEvents.length = 0;
      terminationEvents.length = 0;

      child2.cast("crash");
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
              child.cast("crash");
              return true;
            }
            return false;
          })
          .call("childCount", () => {
            const parentActor = system.system.getActor(ctx.self.id.id);
            return parentActor ? parentActor.context.children.size : 0;
          });
      });

      const parentRef = system.spawn(LimitedParent, {});
      await parentRef.call("spawnChild", "doomed");

      restartEvents.length = 0;

      await parentRef.call("crashChild");
      await new Promise((r) => setTimeout(r, 300));

      await parentRef.call("crashChild");
      await new Promise((r) => setTimeout(r, 300));

      await parentRef.call("crashChild");
      await new Promise((r) => setTimeout(r, 300));

      expect(restartEvents.filter((e) => e === "init:doomed").length).toBe(2);

      const remaining = await parentRef.call("childCount");
      expect(remaining).toBe(0);
    });
  });
});
