import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor,
  ActorSystem,
  Cluster,
  InMemoryTransport,
  InMemoryRegistry,
  isMigratable,
  Migratable,
  InfoMessage,
  MovedMessage,
  ActorRef,
  WatchRef,
  LinkRef,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

class NonMigratableActor extends Actor {
  private value = 0;

  init(initial: number = 0) {
    this.value = initial;
  }

  handleCall(message: { type: string }): number {
    if (message.type === "get") return this.value;
    return 0;
  }

  handleCast(message: { type: string; amount?: number }): void {
    if (message.type === "set" && message.amount !== undefined) {
      this.value = message.amount;
    }
  }
}

class MigratableActor extends Actor implements Migratable {
  private value = 0;
  private data: Record<string, unknown> = {};

  init(initial: number = 0) {
    this.value = initial;
  }

  handleCall(message: { type: string }): number | Record<string, unknown> {
    if (message.type === "get") return this.value;
    if (message.type === "getData") return this.data;
    return 0;
  }

  handleCast(message: { type: string; amount?: number; key?: string; val?: unknown }): void {
    if (message.type === "set" && message.amount !== undefined) {
      this.value = message.amount;
    }
    if (message.type === "setData" && message.key !== undefined) {
      this.data[message.key] = message.val;
    }
  }

  getState(): { value: number; data: Record<string, unknown> } {
    return { value: this.value, data: { ...this.data } };
  }

  setState(state: { value: number; data: Record<string, unknown> }): void {
    this.value = state.value;
    this.data = { ...state.data };
  }
}

class AsyncMigratableActor extends Actor implements Migratable {
  private items: string[] = [];

  handleCall(message: { type: string }): string[] {
    if (message.type === "getItems") return this.items;
    return [];
  }

  handleCast(message: { type: string; item?: string }): void {
    if (message.type === "addItem" && message.item) {
      this.items.push(message.item);
    }
  }

  async getState(): Promise<{ items: string[] }> {
    await new Promise((r) => setTimeout(r, 1));
    return { items: [...this.items] };
  }

  async setState(state: { items: string[] }): Promise<void> {
    await new Promise((r) => setTimeout(r, 1));
    this.items = [...state.items];
  }
}

describe("Actor Migration", () => {
  let system: ActorSystem;
  let transport: InMemoryTransport;
  let registry: InMemoryRegistry;

  beforeEach(async () => {
    const cluster = new MockCluster("test-node");
    transport = new InMemoryTransport("test-node");
    registry = new InMemoryRegistry();

    await transport.connect();
    system = new ActorSystem(cluster, transport, registry);
    system.registerActorClasses([NonMigratableActor, MigratableActor, AsyncMigratableActor]);
    await system.start();
  });

  afterEach(async () => {
    await system.shutdown();
    await transport.disconnect();
  });

  describe("isMigratable type guard", () => {
    it("should return false for actor without getState/setState", async () => {
      const ref = system.spawn(NonMigratableActor, { args: [10] });
      const actor = system.getActor(ref.id.id);

      expect(actor).toBeDefined();
      expect(isMigratable(actor!)).toBe(false);
    });

    it("should return true for actor with getState/setState", async () => {
      const ref = system.spawn(MigratableActor, { args: [42] });
      const actor = system.getActor(ref.id.id);

      expect(actor).toBeDefined();
      expect(isMigratable(actor!)).toBe(true);
    });

    it("should return true for actor with async getState/setState", async () => {
      const ref = system.spawn(AsyncMigratableActor);
      const actor = system.getActor(ref.id.id);

      expect(actor).toBeDefined();
      expect(isMigratable(actor!)).toBe(true);
    });
  });

  describe("Migratable state serialization", () => {
    it("should serialize and restore sync state correctly", async () => {
      const ref = system.spawn(MigratableActor, { args: [100] });
      ref.cast({ type: "setData", key: "name", val: "test" });
      ref.cast({ type: "set", amount: 200 });

      await new Promise((r) => setTimeout(r, 10));

      const actor = system.getActor(ref.id.id) as MigratableActor;
      const state = actor.getState() as { value: number; data: Record<string, unknown> };

      expect(state.value).toBe(200);
      expect(state.data.name).toBe("test");

      const newActor = new MigratableActor();
      newActor.setState(state);

      const restored = newActor.getState() as { value: number; data: Record<string, unknown> };
      expect(restored.value).toBe(200);
      expect(restored.data.name).toBe("test");
    });

    it("should serialize and restore async state correctly", async () => {
      const ref = system.spawn(AsyncMigratableActor);
      ref.cast({ type: "addItem", item: "one" });
      ref.cast({ type: "addItem", item: "two" });

      await new Promise((r) => setTimeout(r, 10));

      const actor = system.getActor(ref.id.id) as AsyncMigratableActor;
      const state = (await actor.getState()) as { items: string[] };

      expect(state.items).toEqual(["one", "two"]);

      const newActor = new AsyncMigratableActor();
      await newActor.setState(state);

      const restored = (await newActor.getState()) as { items: string[] };
      expect(restored.items).toEqual(["one", "two"]);
    });

    it("should produce JSON-serializable state", async () => {
      const ref = system.spawn(MigratableActor, { args: [50] });
      ref.cast({ type: "setData", key: "nested", val: { a: 1, b: [2, 3] } });

      await new Promise((r) => setTimeout(r, 10));

      const actor = system.getActor(ref.id.id) as MigratableActor;
      const state = actor.getState();

      const json = JSON.stringify(state);
      const parsed = JSON.parse(json);

      expect(parsed.value).toBe(50);
      expect(parsed.data.nested).toEqual({ a: 1, b: [2, 3] });
    });
  });

  describe("Mailbox pause/resume", () => {
    it("should pause mailbox processing", async () => {
      const ref = system.spawn(NonMigratableActor, { args: [0] });
      await new Promise((r) => setTimeout(r, 5));

      system.pauseMailbox(ref.id.id);
      expect(system.isMailboxPaused(ref.id.id)).toBe(true);

      ref.cast({ type: "set", amount: 100 });
      await new Promise((r) => setTimeout(r, 10));

      const value = await ref.call({ type: "get" }, 100).catch(() => "timeout");
      expect(value).toBe("timeout");

      expect(system.getPendingMessages(ref.id.id).length).toBeGreaterThanOrEqual(1);
    });

    it("should resume mailbox processing", async () => {
      const ref = system.spawn(NonMigratableActor, { args: [0] });
      await new Promise((r) => setTimeout(r, 5));

      system.pauseMailbox(ref.id.id);
      ref.cast({ type: "set", amount: 50 });
      await new Promise((r) => setTimeout(r, 5));

      system.resumeMailbox(ref.id.id);
      expect(system.isMailboxPaused(ref.id.id)).toBe(false);

      await new Promise((r) => setTimeout(r, 10));

      const value = await ref.call({ type: "get" });
      expect(value).toBe(50);
    });

    it("should return false for non-existent actor", () => {
      expect(system.pauseMailbox("non-existent")).toBe(false);
      expect(system.resumeMailbox("non-existent")).toBe(false);
    });
  });

  describe("Mailbox drain", () => {
    it("should drain pending messages from mailbox", async () => {
      const ref = system.spawn(NonMigratableActor, { args: [0] });
      await new Promise((r) => setTimeout(r, 5));

      system.pauseMailbox(ref.id.id);

      ref.cast({ type: "set", amount: 10 });
      ref.cast({ type: "set", amount: 20 });
      ref.cast({ type: "set", amount: 30 });

      const pending = await system.drainMailbox(ref.id.id);

      expect(pending.length).toBe(3);
      expect(pending[0].type).toBe("cast");
      expect(pending[0].message.amount).toBe(10);
      expect(pending[1].message.amount).toBe(20);
      expect(pending[2].message.amount).toBe(30);

      expect(system.getPendingMessages(ref.id.id).length).toBe(0);
    });

    it("should wait for current message to finish processing", async () => {
      class SlowActor extends Actor {
        private value = 0;

        handleCall(msg: { type: string }): Promise<number> | number {
          if (msg.type === "slow") {
            return new Promise((r) => setTimeout(() => r(this.value), 50));
          }
          return this.value;
        }

        handleCast(msg: { type: string; v?: number }): void {
          if (msg.type === "set" && msg.v !== undefined) this.value = msg.v;
        }
      }

      system.registerActorClass(SlowActor);
      const ref = system.spawn(SlowActor);
      await new Promise((r) => setTimeout(r, 5));

      const callPromise = ref.call({ type: "slow" });

      await new Promise((r) => setTimeout(r, 5));

      const drainStart = Date.now();
      const pending = await system.drainMailbox(ref.id.id, 200);
      const drainDuration = Date.now() - drainStart;

      await callPromise;

      expect(pending.length).toBe(0);
      expect(drainDuration).toBeLessThan(100);
    });

    it("should return empty array for non-existent actor", async () => {
      const pending = await system.drainMailbox("non-existent");
      expect(pending).toEqual([]);
    });
  });

  describe("Mailbox inject", () => {
    it("should inject messages at front of mailbox", async () => {
      const ref = system.spawn(NonMigratableActor, { args: [0] });
      await new Promise((r) => setTimeout(r, 5));

      system.pauseMailbox(ref.id.id);

      ref.cast({ type: "set", amount: 100 });

      system.injectMessages(ref.id.id, [
        { type: "cast", message: { type: "set", amount: 1 } },
        { type: "cast", message: { type: "set", amount: 2 } },
      ]);

      const pending = system.getPendingMessages(ref.id.id);
      expect(pending.length).toBe(3);
      expect(pending[0].message.amount).toBe(1);
      expect(pending[1].message.amount).toBe(2);
      expect(pending[2].message.amount).toBe(100);
    });

    it("should return false for non-existent actor", () => {
      expect(
        system.injectMessages("non-existent", [
          { type: "cast", message: {} },
        ]),
      ).toBe(false);
    });
  });
});

describe("Distributed Actor Migration", () => {
  let transport1: InMemoryTransport;
  let transport2: InMemoryTransport;
  let registry1: InMemoryRegistry;
  let registry2: InMemoryRegistry;
  let system1: ActorSystem;
  let system2: ActorSystem;

  class MockCluster implements Cluster {
    constructor(public readonly nodeId: string) {}
    getMembers(): string[] {
      return [this.nodeId];
    }
  }

  beforeEach(async () => {
    transport1 = new InMemoryTransport("node1");
    transport2 = new InMemoryTransport("node2");

    transport1.setPeer("node2", transport2);
    transport2.setPeer("node1", transport1);

    await transport1.connect();
    await transport2.connect();

    registry1 = new InMemoryRegistry();
    registry2 = new InMemoryRegistry();

    const cluster1 = new MockCluster("node1");
    const cluster2 = new MockCluster("node2");

    system1 = new ActorSystem(cluster1, transport1, registry1);
    system2 = new ActorSystem(cluster2, transport2, registry2);

    system1.registerActorClasses([MigratableActor, NonMigratableActor]);
    system2.registerActorClasses([MigratableActor, NonMigratableActor]);

    await system1.start();
    await system2.start();
  });

  afterEach(async () => {
    await system1.shutdown();
    await system2.shutdown();
    await transport1.disconnect();
    await transport2.disconnect();
  });

  it("should migrate actor between nodes", async () => {
    const ref = system1.spawn(MigratableActor, { name: "migrating-actor", args: [100] });
    await new Promise((r) => setTimeout(r, 10));

    ref.cast({ type: "set", amount: 200 });
    ref.cast({ type: "setData", key: "test", val: "value" });
    await new Promise((r) => setTimeout(r, 10));

    const result = await system1.migrate("migrating-actor", "node2");

    expect(result.success).toBe(true);
    expect(result.newNodeId).toBe("node2");
    expect(result.newActorId).toBeDefined();

    const location = await registry2.lookup("migrating-actor");
    expect(location?.nodeId).toBe("node2");

    const newRef = system2.getRef({
      systemId: "node2",
      id: result.newActorId!,
      name: "migrating-actor",
    } as any);

    const state = await newRef.call({ type: "get" });
    expect(state).toBe(200);

    const data = await newRef.call({ type: "getData" });
    expect(data.test).toBe("value");
  });

  it("should preserve pending messages during migration", async () => {
    const ref = system1.spawn(MigratableActor, { name: "pending-actor", args: [0] });
    await new Promise((r) => setTimeout(r, 10));

    system1.pauseMailbox(ref.id.id);

    ref.cast({ type: "set", amount: 10 });
    ref.cast({ type: "set", amount: 20 });
    ref.cast({ type: "set", amount: 30 });

    system1.resumeMailbox(ref.id.id);

    const result = await system1.migrate("pending-actor", "node2");
    expect(result.success).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    const newRef = system2.getRef({
      systemId: "node2",
      id: result.newActorId!,
      name: "pending-actor",
    } as any);

    const finalValue = await newRef.call({ type: "get" });
    expect(finalValue).toBe(30);
  });

  it("should fail to migrate non-migratable actor", async () => {
    system1.spawn(NonMigratableActor, { name: "non-migratable" });
    await new Promise((r) => setTimeout(r, 10));

    await expect(system1.migrate("non-migratable", "node2")).rejects.toThrow(
      "ACTOR_NOT_MIGRATABLE",
    );
  });

  it("should fail to migrate to same node", async () => {
    system1.spawn(MigratableActor, { name: "same-node-actor" });
    await new Promise((r) => setTimeout(r, 10));

    const result = await system1.migrate("same-node-actor", "node1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("same node");
  });

  it("should fail to migrate non-existent actor", async () => {
    const result = await system1.migrate("non-existent", "node2");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("should fail if actor class not registered on target", async () => {
    class UnregisteredActor extends Actor implements Migratable {
      private v = 0;
      handleCall(m: any) { return this.v; }
      handleCast(m: any) { this.v = m.v; }
      getState() { return { v: this.v }; }
      setState(s: any) { this.v = s.v; }
    }

    system1.registerActorClass(UnregisteredActor);
    system1.spawn(UnregisteredActor, { name: "unregistered-class-actor" });
    await new Promise((r) => setTimeout(r, 10));

    const result = await system1.migrate("unregistered-class-actor", "node2");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not registered");
  });

  it("should cleanup source actor after migration", async () => {
    const ref = system1.spawn(MigratableActor, { name: "cleanup-test" });
    await new Promise((r) => setTimeout(r, 10));

    const originalId = ref.id.id;

    const result = await system1.migrate("cleanup-test", "node2");
    expect(result.success).toBe(true);

    expect(system1.getActor(originalId)).toBeUndefined();
    expect(system1.getPendingMessages(originalId)).toEqual([]);
  });
});

describe("Migration Watcher/Link Notifications", () => {
  let transport1: InMemoryTransport;
  let transport2: InMemoryTransport;
  let registry1: InMemoryRegistry;
  let registry2: InMemoryRegistry;
  let system1: ActorSystem;
  let system2: ActorSystem;

  class MockCluster implements Cluster {
    constructor(public readonly nodeId: string) {}
    getMembers(): string[] {
      return [this.nodeId];
    }
  }

  class WatcherActor extends Actor {
    public receivedMessages: InfoMessage[] = [];

    handleCall(message: { type: string }): InfoMessage[] | number {
      if (message.type === "getMessages") return this.receivedMessages;
      if (message.type === "getCount") return this.receivedMessages.length;
      return [];
    }

    handleCast(): void {}

    handleInfo(message: InfoMessage): void {
      this.receivedMessages.push(message);
    }

    watchActor(target: ActorRef): WatchRef {
      return this.watch(target);
    }

    linkActor(target: ActorRef): LinkRef {
      this.setTrapExit(true);
      return this.link(target);
    }
  }

  class MigratableActor extends Actor implements Migratable {
    private value = 0;

    handleCall(message: { type: string }): number {
      if (message.type === "get") return this.value;
      return 0;
    }

    handleCast(message: { type: string; amount?: number }): void {
      if (message.type === "set" && message.amount !== undefined) {
        this.value = message.amount;
      }
    }

    getState(): { value: number } {
      return { value: this.value };
    }

    setState(state: { value: number }): void {
      this.value = state.value;
    }
  }

  beforeEach(async () => {
    transport1 = new InMemoryTransport("node1");
    transport2 = new InMemoryTransport("node2");

    transport1.setPeer("node2", transport2);
    transport2.setPeer("node1", transport1);

    await transport1.connect();
    await transport2.connect();

    registry1 = new InMemoryRegistry();
    registry2 = new InMemoryRegistry();

    const cluster1 = new MockCluster("node1");
    const cluster2 = new MockCluster("node2");

    system1 = new ActorSystem(cluster1, transport1, registry1);
    system2 = new ActorSystem(cluster2, transport2, registry2);

    system1.registerActorClasses([MigratableActor, WatcherActor]);
    system2.registerActorClasses([MigratableActor, WatcherActor]);

    await system1.start();
    await system2.start();
  });

  afterEach(async () => {
    await system1.shutdown();
    await system2.shutdown();
    await transport1.disconnect();
    await transport2.disconnect();
  });

  it("should notify local watcher with MovedMessage when actor migrates", async () => {
    const targetRef = system1.spawn(MigratableActor, { name: "watched-actor" });
    const watcherRef = system1.spawn(WatcherActor, { name: "watcher" });
    await new Promise((r) => setTimeout(r, 10));

    const watcherActor = system1.getActor(watcherRef.id.id) as WatcherActor;
    watcherActor.watchActor(targetRef);

    await new Promise((r) => setTimeout(r, 10));

    const result = await system1.migrate("watched-actor", "node2");
    expect(result.success).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    const messages = await watcherRef.call({ type: "getMessages" }) as InfoMessage[];
    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe("moved");

    const movedMsg = messages[0] as MovedMessage;
    expect(movedMsg.oldNodeId).toBe("node1");
    expect(movedMsg.newNodeId).toBe("node2");
    expect(movedMsg.newActorId).toBe(result.newActorId);
    expect(movedMsg.watchRef).toBeDefined();
  });

  it("should notify remote watcher with MovedMessage when actor migrates", async () => {
    const targetRef = system1.spawn(MigratableActor, { name: "remote-watched" });
    const watcherRef = system2.spawn(WatcherActor, { name: "remote-watcher" });
    await new Promise((r) => setTimeout(r, 20));

    const watcherActor = system2.getActor(watcherRef.id.id) as WatcherActor;
    watcherActor.watchActor(targetRef);

    await new Promise((r) => setTimeout(r, 50));

    const result = await system1.migrate("remote-watched", "node2");
    expect(result.success).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    const messages = await watcherRef.call({ type: "getMessages" }) as InfoMessage[];
    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe("moved");

    const movedMsg = messages[0] as MovedMessage;
    expect(movedMsg.oldNodeId).toBe("node1");
    expect(movedMsg.newNodeId).toBe("node2");
    expect(movedMsg.newActorId).toBe(result.newActorId);
  });

  it("should notify local linked actor with MovedMessage when actor migrates", async () => {
    const targetRef = system1.spawn(MigratableActor, { name: "linked-actor" });
    const linkerRef = system1.spawn(WatcherActor, { name: "linker" });
    await new Promise((r) => setTimeout(r, 10));

    const linkerActor = system1.getActor(linkerRef.id.id) as WatcherActor;
    linkerActor.linkActor(targetRef);

    await new Promise((r) => setTimeout(r, 10));

    const result = await system1.migrate("linked-actor", "node2");
    expect(result.success).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    const messages = await linkerRef.call({ type: "getMessages" }) as InfoMessage[];
    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe("moved");

    const movedMsg = messages[0] as MovedMessage;
    expect(movedMsg.oldNodeId).toBe("node1");
    expect(movedMsg.newNodeId).toBe("node2");
    expect(movedMsg.newActorId).toBe(result.newActorId);
    expect(movedMsg.linkRef).toBeDefined();
  });

  it("should notify remote linked actor with MovedMessage when actor migrates", async () => {
    const targetRef = system1.spawn(MigratableActor, { name: "remote-linked" });
    const linkerRef = system2.spawn(WatcherActor, { name: "remote-linker" });
    await new Promise((r) => setTimeout(r, 20));

    const linkerActor = system2.getActor(linkerRef.id.id) as WatcherActor;
    linkerActor.linkActor(targetRef);

    await new Promise((r) => setTimeout(r, 50));

    const result = await system1.migrate("remote-linked", "node2");
    expect(result.success).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    const messages = await linkerRef.call({ type: "getMessages" }) as InfoMessage[];
    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe("moved");

    const movedMsg = messages[0] as MovedMessage;
    expect(movedMsg.oldNodeId).toBe("node1");
    expect(movedMsg.newNodeId).toBe("node2");
    expect(movedMsg.newActorId).toBe(result.newActorId);
  });

  it("should clean up watch after migration notification", async () => {
    const targetRef = system1.spawn(MigratableActor, { name: "cleanup-watch" });
    const watcherRef = system1.spawn(WatcherActor, { name: "cleanup-watcher" });
    await new Promise((r) => setTimeout(r, 10));

    const watcherActor = system1.getActor(watcherRef.id.id) as WatcherActor;
    watcherActor.watchActor(targetRef);

    await new Promise((r) => setTimeout(r, 10));

    const result = await system1.migrate("cleanup-watch", "node2");
    expect(result.success).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    expect(watcherActor.context.watches.size).toBe(0);
  });

  it("should clean up link after migration notification", async () => {
    const targetRef = system1.spawn(MigratableActor, { name: "cleanup-link" });
    const linkerRef = system1.spawn(WatcherActor, { name: "cleanup-linker" });
    await new Promise((r) => setTimeout(r, 10));

    const linkerActor = system1.getActor(linkerRef.id.id) as WatcherActor;
    linkerActor.linkActor(targetRef);

    await new Promise((r) => setTimeout(r, 10));

    const result = await system1.migrate("cleanup-link", "node2");
    expect(result.success).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    expect(linkerActor.context.links.size).toBe(0);
  });
});
