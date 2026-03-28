import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Actor,
  ActorSystem,
  Cluster,
  InMemoryTransport,
  LocalRegistry,
  Migratable,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}

  getMembers(): string[] {
    return [this.nodeId];
  }
}

class PlainActor extends Actor {
  handleCall(_msg: unknown): null {
    return null;
  }

  handleCast(_msg: unknown): void {}
}

class MigratableActor extends Actor implements Migratable {
  private value = 0;

  init(initial: number = 0): void {
    this.value = initial;
  }

  handleCall(msg: { type: string }): number | null {
    if (msg.type === "get") return this.value;
    return null;
  }

  handleCast(msg: { type: string; value?: number }): void {
    if (msg.type === "set" && msg.value !== undefined) {
      this.value = msg.value;
    }
  }

  getState(): { value: number } {
    return { value: this.value };
  }

  setState(state: { value: number }): void {
    this.value = state.value;
  }
}

class ParentMigratableActor extends Actor implements Migratable {
  handleCall(msg: { type: string }): number {
    if (msg.type === "spawn-child") {
      this.spawn(PlainActor);
      return this.getChildren().length;
    }
    return this.getChildren().length;
  }

  handleCast(_msg: unknown): void {}

  getState(): { children: number } {
    return { children: this.getChildren().length };
  }

  setState(_state: { children: number }): void {}
}

describe("ActorSystem migrateAll", () => {
  let transport1: InMemoryTransport;
  let transport2: InMemoryTransport;
  let registry1: LocalRegistry;
  let registry2: LocalRegistry;
  let system1: ActorSystem;
  let system2: ActorSystem;

  beforeEach(async () => {
    transport1 = new InMemoryTransport("node1");
    transport2 = new InMemoryTransport("node2");

    transport1.setPeer("node2", transport2);
    transport2.setPeer("node1", transport1);

    await transport1.connect();
    await transport2.connect();

    registry1 = new LocalRegistry();
    registry2 = new LocalRegistry();

    system1 = new ActorSystem(new MockCluster("node1"), transport1, registry1);
    system2 = new ActorSystem(new MockCluster("node2"), transport2, registry2);

    system1.registerActorClasses([PlainActor, MigratableActor, ParentMigratableActor]);
    system2.registerActorClasses([PlainActor, MigratableActor, ParentMigratableActor]);

    await system1.start();
    await system2.start();
  });

  afterEach(async () => {
    await system1.shutdown();
    await system2.shutdown();
    await transport1.disconnect();
    await transport2.disconnect();
  });

  it("migrateAll() migrates all migratable actors to target node", async () => {
    system1.spawn(MigratableActor, { name: "m1", args: [10] });
    system1.spawn(MigratableActor, { name: "m2", args: [20] });
    system1.spawn(MigratableActor, { name: "m3", args: [30] });

    const result = await system1.migrateAll("node2");

    expect(result.migrated).toBe(3);
    expect(result.failed).toEqual([]);
    expect((await registry2.lookup("m1"))?.nodeId).toBe("node2");
    expect((await registry2.lookup("m2"))?.nodeId).toBe("node2");
    expect((await registry2.lookup("m3"))?.nodeId).toBe("node2");
  });

  it("migrateAll() skips non-migratable actors", async () => {
    system1.spawn(MigratableActor, { name: "migratable" });
    system1.spawn(PlainActor, { name: "plain" });

    const result = await system1.migrateAll("node2");

    expect(result.migrated).toBe(1);
    expect(result.failed).toEqual([]);
    expect((await registry2.lookup("migratable"))?.nodeId).toBe("node2");
    expect((await registry1.lookup("plain"))?.nodeId).toBe("node1");
  });

  it("migrateAll() skips actors with children", async () => {
    const parent = system1.spawn(ParentMigratableActor, { name: "parent" });
    system1.spawn(MigratableActor, { name: "leaf" });
    await parent.call({ type: "spawn-child" });

    const result = await system1.migrateAll("node2");

    expect(result.migrated).toBe(1);
    expect(result.failed).toEqual([]);
    expect((await registry2.lookup("leaf"))?.nodeId).toBe("node2");
    expect((await registry1.lookup("parent"))?.nodeId).toBe("node1");
  });

  it("migrateAll() returns correct counts (migrated, failed)", async () => {
    system1.spawn(MigratableActor, { name: "same-node-1" });
    system1.spawn(MigratableActor, { name: "same-node-2" });

    const result = await system1.migrateAll("node1");

    expect(result.migrated).toBe(0);
    expect(result.failed).toHaveLength(2);
    expect(result.failed).toEqual(expect.arrayContaining(["same-node-1", "same-node-2"]));
  });

  it("migrateAll() with no migratable actors returns {0, 0, []}", async () => {
    system1.spawn(PlainActor, { name: "plain-1" });
    system1.spawn(PlainActor, { name: "plain-2" });

    const result = await system1.migrateAll("node2");

    expect(result).toEqual({ migrated: 0, drained: 0, failed: [] });
  });

  it("migrateAll() works with mixed migratable and non-migratable actors", async () => {
    system1.spawn(MigratableActor, { name: "migratable-1" });
    system1.spawn(PlainActor, { name: "plain" });
    const parent = system1.spawn(ParentMigratableActor, { name: "parent" });
    system1.spawn(MigratableActor, { name: "migratable-2" });
    await parent.call({ type: "spawn-child" });

    const result = await system1.migrateAll("node2");

    expect(result.migrated).toBe(2);
    expect(result.failed).toEqual([]);
    expect((await registry2.lookup("migratable-1"))?.nodeId).toBe("node2");
    expect((await registry2.lookup("migratable-2"))?.nodeId).toBe("node2");
    expect((await registry1.lookup("plain"))?.nodeId).toBe("node1");
    expect((await registry1.lookup("parent"))?.nodeId).toBe("node1");
  });
});
