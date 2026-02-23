import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Actor,
  ActorSystem,
  BoundedMailbox,
  Cluster,
  InMemoryTransport,
  LocalRegistry,
  MailboxFullError,
  System,
  createSystem,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}

  getMembers(): string[] {
    return [this.nodeId];
  }
}

class CounterActor extends Actor {
  private count = 0;

  handleCast(message: any): void {
    if (message.type === "inc") {
      this.count += 1;
    }
  }

  handleCall(message: any): any {
    if (message.type === "get") {
      return this.count;
    }
    return null;
  }
}

class SlowCounterActor extends Actor {
  private count = 0;

  async handleCast(message: any): Promise<void> {
    if (message.type === "inc") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.count += 1;
    }
  }

  handleCall(message: any): any {
    if (message.type === "get") {
      return this.count;
    }
    return null;
  }
}

describe("BoundedMailbox", () => {
  it("supports unbounded mailbox by default", () => {
    const mailbox = new BoundedMailbox();

    for (let i = 0; i < 1000; i++) {
      expect(mailbox.enqueue({ type: "cast", message: { i } })).toBe(true);
    }

    expect(mailbox.capacity).toBeUndefined();
    expect(mailbox.length).toBe(1000);
    expect(mailbox.dropped).toBe(0);
    expect(mailbox.isFull).toBe(false);
  });

  it("drop-newest rejects incoming message when full", () => {
    const mailbox = new BoundedMailbox({ maxSize: 1, overflowStrategy: "drop-newest" });

    expect(mailbox.enqueue({ type: "cast", message: "first" })).toBe(true);
    expect(mailbox.enqueue({ type: "cast", message: "second" })).toBe(false);
    expect(mailbox.toArray().map((m) => m.message)).toEqual(["first"]);
    expect(mailbox.dropped).toBe(1);
  });

  it("drop-oldest evicts oldest and accepts newest", () => {
    const mailbox = new BoundedMailbox({ maxSize: 2, overflowStrategy: "drop-oldest" });

    mailbox.enqueue({ type: "cast", message: "first" });
    mailbox.enqueue({ type: "cast", message: "second" });
    expect(mailbox.enqueue({ type: "cast", message: "third" })).toBe(true);

    expect(mailbox.toArray().map((m) => m.message)).toEqual(["second", "third"]);
    expect(mailbox.dropped).toBe(1);
  });

  it("error strategy throws MailboxFullError", () => {
    const mailbox = new BoundedMailbox({ maxSize: 1, overflowStrategy: "error" });

    mailbox.enqueue({ type: "cast", message: "first" });
    expect(() => mailbox.enqueue({ type: "cast", message: "second" })).toThrow(
      MailboxFullError,
    );
    expect(mailbox.dropped).toBe(1);
  });

  it("drop-oldest rejects dropped call message promise", () => {
    const mailbox = new BoundedMailbox({ maxSize: 1, overflowStrategy: "drop-oldest" });
    const reject = vi.fn();

    mailbox.enqueue({
      type: "call",
      message: { type: "work" },
      reject,
    });

    mailbox.enqueue({ type: "cast", message: { type: "new" } });

    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]?.[0]).toBeInstanceOf(MailboxFullError);
  });

  it("unshift bypasses capacity checks for already accepted messages", () => {
    const mailbox = new BoundedMailbox({ maxSize: 1, overflowStrategy: "drop-newest" });
    mailbox.enqueue({ type: "cast", message: "queued" });

    mailbox.unshift(
      { type: "cast", message: "stashed-1" },
      { type: "cast", message: "stashed-2" },
    );

    expect(mailbox.length).toBe(3);
    expect(mailbox.toArray().map((m) => m.message)).toEqual([
      "stashed-1",
      "stashed-2",
      "queued",
    ]);
  });

  it("drain returns all messages and empties mailbox", () => {
    const mailbox = new BoundedMailbox({ maxSize: 2 });
    mailbox.enqueue({ type: "cast", message: "a" });
    mailbox.enqueue({ type: "cast", message: "b" });

    const drained = mailbox.drain();

    expect(drained.map((m) => m.message)).toEqual(["a", "b"]);
    expect(mailbox.length).toBe(0);
  });
});

describe("ActorSystem mailbox integration", () => {
  let system: ActorSystem;
  let transport: InMemoryTransport;
  let registry: LocalRegistry;

  beforeEach(async () => {
    transport = new InMemoryTransport("mailbox-node");
    registry = new LocalRegistry();
    system = new ActorSystem(new MockCluster("mailbox-node"), transport, registry);
    await system.start();
  });

  afterEach(async () => {
    await system.shutdown();
  });

  it("drop-newest keeps casts fire-and-forget and rejects call when full", async () => {
    const ref = system.spawn(CounterActor, {
      mailbox: { maxSize: 1, overflowStrategy: "drop-newest" },
    });

    expect(system.pauseMailbox(ref.id.id)).toBe(true);

    ref.cast({ type: "inc" });
    ref.cast({ type: "inc" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(system.getPendingMessages(ref.id.id)).toHaveLength(1);

    await expect(ref.call({ type: "get" }, 100)).rejects.toBeInstanceOf(
      MailboxFullError,
    );
  });

  it("can run with bounded mailbox under cast flood", async () => {
    const ref = system.spawn(SlowCounterActor, {
      mailbox: { maxSize: 5, overflowStrategy: "drop-oldest" },
    });

    for (let i = 0; i < 100; i++) {
      ref.cast({ type: "inc" });
    }

    await new Promise((resolve) => setTimeout(resolve, 300));

    const count = await ref.call({ type: "get" });
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("rejects call when mailbox is full", async () => {
    const ref = system.spawn(CounterActor, {
      mailbox: { maxSize: 1, overflowStrategy: "drop-newest" },
    });

    expect(system.pauseMailbox(ref.id.id)).toBe(true);
    ref.cast({ type: "inc" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(ref.call({ type: "get" }, 100)).rejects.toBeInstanceOf(
      MailboxFullError,
    );
  });
});

describe("createSystem mailbox defaults", () => {
  let local: System;

  beforeEach(() => {
    local = createSystem({
      nodeId: "mailbox-default-node",
      mailbox: { maxSize: 1, overflowStrategy: "drop-newest" },
    });
  });

  afterEach(async () => {
    await local.shutdown();
  });

  it("applies system-level default mailbox config", async () => {
    const ref = local.spawn(CounterActor);

    expect(local.system.pauseMailbox(ref.id.id)).toBe(true);
    ref.cast({ type: "inc" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(ref.call({ type: "get" }, 100)).rejects.toBeInstanceOf(
      MailboxFullError,
    );
  });
});
