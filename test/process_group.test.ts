import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Actor } from "../src/actor";
import { ActorSystem } from "../src/actor_system";
import { InMemoryTransport } from "../src/in_memory_transport";
import { LocalCluster } from "../src/local_cluster";
import { LocalRegistry } from "../src/local_registry";
import { ProcessGroupManager } from "../src/process_group";

class EchoActor extends Actor {
  public received: any[] = [];

  handleCall(message: any): any {
    return message;
  }

  handleCast(message: any): void {
    this.received.push(message);
  }
}

describe("process groups", () => {
  let system: ActorSystem;
  let processGroups: ProcessGroupManager;

  beforeEach(async () => {
    const cluster = new LocalCluster("test-node");
    const transport = new InMemoryTransport("test-node");
    const registry = new LocalRegistry();
    processGroups = new ProcessGroupManager("test-node", transport, cluster);

    await transport.connect();
    await processGroups.connect();

    system = new ActorSystem(
      cluster,
      transport,
      registry,
      undefined,
      undefined,
      undefined,
      undefined,
      processGroups,
    );
    system.registerActorClass(EchoActor);
    await system.start();
  });

  afterEach(async () => {
    await system.shutdown();
  });

  it("join and get group", () => {
    const ref = system.spawn(EchoActor);
    system.joinGroup("workers", ref);

    const group = system.getGroup("workers");
    expect(group).toHaveLength(1);
    expect(group[0]?.id.id).toBe(ref.id.id);
    expect(group[0]?.id.systemId).toBe("test-node");
  });

  it("leave group", () => {
    const ref = system.spawn(EchoActor);
    system.joinGroup("workers", ref);
    system.leaveGroup("workers", ref);

    expect(system.getGroup("workers")).toEqual([]);
  });

  it("multiple groups", () => {
    const ref = system.spawn(EchoActor);
    system.joinGroup("workers", ref);
    system.joinGroup("admins", ref);

    expect(system.getGroup("workers")).toHaveLength(1);
    expect(system.getGroup("admins")).toHaveLength(1);
    expect(system.getGroup("workers")[0]?.id.id).toBe(ref.id.id);
    expect(system.getGroup("admins")[0]?.id.id).toBe(ref.id.id);
  });

  it("multiple actors in one group", () => {
    const ref1 = system.spawn(EchoActor);
    const ref2 = system.spawn(EchoActor);
    const ref3 = system.spawn(EchoActor);

    system.joinGroup("workers", ref1);
    system.joinGroup("workers", ref2);
    system.joinGroup("workers", ref3);

    const members = system.getGroup("workers");
    expect(members).toHaveLength(3);

    const ids = new Set(members.map((m) => m.id.id));
    expect(ids.has(ref1.id.id)).toBe(true);
    expect(ids.has(ref2.id.id)).toBe(true);
    expect(ids.has(ref3.id.id)).toBe(true);
  });

  it("broadcast", async () => {
    const ref1 = system.spawn(EchoActor);
    const ref2 = system.spawn(EchoActor);
    const ref3 = system.spawn(EchoActor);
    const message = { type: "ping", payload: 42 };

    system.joinGroup("workers", ref1);
    system.joinGroup("workers", ref2);
    system.joinGroup("workers", ref3);

    system.broadcast("workers", message);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const actor1 = system.getActor(ref1.id.id) as EchoActor;
    const actor2 = system.getActor(ref2.id.id) as EchoActor;
    const actor3 = system.getActor(ref3.id.id) as EchoActor;

    expect(actor1.received).toContainEqual(message);
    expect(actor2.received).toContainEqual(message);
    expect(actor3.received).toContainEqual(message);
  });

  it("auto-cleanup on actor stop", async () => {
    const ref = system.spawn(EchoActor);
    system.joinGroup("workers", ref);

    await system.stop(ref);

    expect(system.getGroup("workers")).toEqual([]);
  });

  it("idempotent join", () => {
    const ref = system.spawn(EchoActor);

    system.joinGroup("workers", ref);
    system.joinGroup("workers", ref);

    const members = system.getGroup("workers");
    expect(members).toHaveLength(1);
    expect(members[0]?.id.id).toBe(ref.id.id);
  });

  it("leave non-existent group", () => {
    const ref = system.spawn(EchoActor);
    expect(() => system.leaveGroup("missing", ref)).not.toThrow();
  });

  it("get empty group", () => {
    expect(system.getGroup("missing")).toEqual([]);
  });

  it("actor in multiple groups stop removes from all", async () => {
    const ref = system.spawn(EchoActor);

    system.joinGroup("workers", ref);
    system.joinGroup("admins", ref);
    system.joinGroup("ops", ref);

    await system.stop(ref);

    expect(system.getGroup("workers")).toEqual([]);
    expect(system.getGroup("admins")).toEqual([]);
    expect(system.getGroup("ops")).toEqual([]);
  });
});
