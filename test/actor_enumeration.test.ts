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

  handleCall(msg: { type: string }): number | null {
    if (msg.type === "get") return this.value;
    return null;
  }

  handleCast(_msg: unknown): void {}

  getState(): { value: number } {
    return { value: this.value };
  }

  setState(state: { value: number }): void {
    this.value = state.value;
  }
}

class ParentActor extends Actor {
  handleCall(msg: { type: string }): number | null {
    if (msg.type === "spawn-child") {
      this.spawn(PlainActor);
      return this.getChildren().length;
    }
    return null;
  }

  handleCast(_msg: unknown): void {}
}

describe("ActorSystem getActors", () => {
  let system: ActorSystem;
  const nodeId = "test-node";

  beforeEach(async () => {
    const cluster = new MockCluster(nodeId);
    const transport = new InMemoryTransport(nodeId);
    const registry = new LocalRegistry();
    system = new ActorSystem(cluster, transport, registry);
    await system.start();
  });

  afterEach(async () => {
    if (system.isRunning() || system.isDraining()) {
      await system.shutdown();
    }
  });

  it("getActors() returns empty array when no actors", () => {
    expect(system.getActors()).toEqual([]);
  });

  it("getActors() returns all spawned actors", () => {
    system.spawn(PlainActor);
    system.spawn(PlainActor);
    system.spawn(MigratableActor);

    expect(system.getActors()).toHaveLength(3);
  });

  it("getActors() includes actor name when named", () => {
    const ref = system.spawn(PlainActor, { name: "named-actor" });
    const actor = system.getActors().find((a) => a.actorId === ref.id.id);

    expect(actor?.name).toBe("named-actor");
  });

  it("getActors() includes className from actor class", () => {
    const ref = system.spawn(PlainActor, { name: "plain" });
    const actor = system.getActors().find((a) => a.actorId === ref.id.id);

    expect(actor?.className).toBe("PlainActor");
  });

  it("getActors() marks migratable actors correctly", () => {
    const plain = system.spawn(PlainActor, { name: "plain" });
    const migratable = system.spawn(MigratableActor, { name: "migratable" });
    const actors = system.getActors();

    expect(actors.find((a) => a.actorId === plain.id.id)?.migratable).toBe(false);
    expect(actors.find((a) => a.actorId === migratable.id.id)?.migratable).toBe(true);
  });

  it("getActors() includes childCount", async () => {
    const parent = system.spawn(ParentActor, { name: "parent" });
    await parent.call({ type: "spawn-child" });

    const actor = system.getActors().find((a) => a.actorId === parent.id.id);
    expect(actor?.childCount).toBe(1);
  });

  it("getActors() updates after actor stops", async () => {
    const actor = system.spawn(PlainActor, { name: "to-stop" });
    expect(system.getActors().some((a) => a.actorId === actor.id.id)).toBe(true);

    await system.stop(actor);

    expect(system.getActors().some((a) => a.actorId === actor.id.id)).toBe(false);
  });
});
