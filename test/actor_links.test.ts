// test/actor_links.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor,
  ActorSystem,
  ActorRef,
  Cluster,
  InMemoryTransport,
  LocalRegistry,
  LinkRef,
  InfoMessage,
  ExitMessage,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

// Actor that can crash on demand
class CrashableActor extends Actor {
  handleCast(message: any): void {
    if (message.type === "crash") {
      throw new Error("Crash requested");
    }
  }

  handleCall(message: any): any {
    if (message.type === "ping") {
      return "pong";
    }
    return null;
  }
}

// Actor that links to another actor
class LinkingActor extends Actor {
  public linkedRef?: ActorRef;
  public linkRef?: LinkRef;

  init(targetRef?: ActorRef) {
    if (targetRef) {
      this.linkedRef = targetRef;
      this.linkRef = this.link(targetRef);
    }
  }

  handleCast(message: any): void {
    if (message.type === "link") {
      this.linkedRef = message.target;
      this.linkRef = this.link(message.target);
    } else if (message.type === "unlink") {
      if (this.linkRef) {
        this.unlink(this.linkRef);
        this.linkRef = undefined;
      }
    } else if (message.type === "crash") {
      throw new Error("LinkingActor crash");
    }
  }

  handleCall(message: any): any {
    if (message.type === "ping") {
      return "pong";
    }
    if (message.type === "get_link") {
      return this.linkRef;
    }
    return null;
  }
}

// Actor that traps exits and records them
class TrapExitActor extends Actor {
  public exitMessages: ExitMessage[] = [];

  init() {
    this.setTrapExit(true);
  }

  handleInfo(message: InfoMessage): void {
    if (message.type === "exit") {
      this.exitMessages.push(message);
    }
  }

  handleCast(message: any): void {
    if (message.type === "link") {
      this.link(message.target);
    } else if (message.type === "crash") {
      throw new Error("TrapExitActor crash");
    }
  }

  handleCall(message: any): any {
    if (message.type === "ping") {
      return "pong";
    }
    if (message.type === "get_exits") {
      return [...this.exitMessages];
    }
    if (message.type === "is_trapping") {
      return this.isTrapExit();
    }
    return null;
  }
}

// Actor that can toggle trap exit
class ToggleTrapActor extends Actor {
  public exitMessages: ExitMessage[] = [];

  handleInfo(message: InfoMessage): void {
    if (message.type === "exit") {
      this.exitMessages.push(message);
    }
  }

  handleCast(message: any): void {
    if (message.type === "set_trap") {
      this.setTrapExit(message.value);
    } else if (message.type === "link") {
      this.link(message.target);
    }
  }

  handleCall(message: any): any {
    if (message.type === "ping") {
      return "pong";
    }
    if (message.type === "get_exits") {
      return [...this.exitMessages];
    }
    return null;
  }
}

describe("Actor Links", () => {
  let system: ActorSystem;
  let transport: InMemoryTransport;

  beforeEach(async () => {
    const cluster = new MockCluster("test-node");
    transport = new InMemoryTransport(cluster.nodeId);
    const registry = new LocalRegistry();
    // Use Stop strategy to make crash propagation observable
    system = new ActorSystem(cluster, transport, registry, {
      strategy: "Stop",
      maxRestarts: 0,
      periodMs: 5000,
    });
    await system.start();
  });

  afterEach(async () => {
    await system.shutdown();
  });

  describe("basic linking", () => {
    it("should create a link between two actors", async () => {
      const actor1 = system.spawn(LinkingActor);
      const actor2 = system.spawn(CrashableActor);

      actor1.cast({ type: "link", target: actor2 });
      await new Promise((r) => setTimeout(r, 20));

      const linkRef = await actor1.call({ type: "get_link" });
      expect(linkRef).toBeDefined();
      expect(linkRef.actor1Id).toBeDefined();
      expect(linkRef.actor2Id).toBeDefined();
    });

    it("should allow unlinking actors", async () => {
      const actor1 = system.spawn(LinkingActor);
      const actor2 = system.spawn(CrashableActor);

      actor1.cast({ type: "link", target: actor2 });
      await new Promise((r) => setTimeout(r, 20));

      let linkRef = await actor1.call({ type: "get_link" });
      expect(linkRef).toBeDefined();

      actor1.cast({ type: "unlink" });
      await new Promise((r) => setTimeout(r, 20));

      linkRef = await actor1.call({ type: "get_link" });
      expect(linkRef).toBeUndefined();
    });
  });

  describe("crash propagation", () => {
    it("should crash linked actor when one crashes", async () => {
      const actor1 = system.spawn(LinkingActor);
      const actor2 = system.spawn(CrashableActor);

      actor1.cast({ type: "link", target: actor2 });
      await new Promise((r) => setTimeout(r, 20));

      // Both actors should be alive
      expect(await actor1.call({ type: "ping" })).toBe("pong");
      expect(await actor2.call({ type: "ping" })).toBe("pong");

      // Crash actor2
      actor2.cast({ type: "crash" });
      await new Promise((r) => setTimeout(r, 50));

      // actor1 should also be dead due to link propagation
      // (system stops it because of the linked crash)
      await expect(actor1.call({ type: "ping" }, 100)).rejects.toThrow();
    });

    it("should not crash linked actor on normal termination", async () => {
      const actor1 = system.spawn(LinkingActor);
      const actor2 = system.spawn(CrashableActor);

      actor1.cast({ type: "link", target: actor2 });
      await new Promise((r) => setTimeout(r, 20));

      // Both actors should be alive
      expect(await actor1.call({ type: "ping" })).toBe("pong");
      expect(await actor2.call({ type: "ping" })).toBe("pong");

      // Gracefully stop actor2
      await system.stop(actor2);
      await new Promise((r) => setTimeout(r, 50));

      // actor1 should still be alive (normal termination doesn't propagate)
      expect(await actor1.call({ type: "ping" })).toBe("pong");
    });

    it("should not propagate crash after unlink", async () => {
      const actor1 = system.spawn(LinkingActor);
      const actor2 = system.spawn(CrashableActor);

      actor1.cast({ type: "link", target: actor2 });
      await new Promise((r) => setTimeout(r, 20));

      // Unlink
      actor1.cast({ type: "unlink" });
      await new Promise((r) => setTimeout(r, 20));

      // Crash actor2
      actor2.cast({ type: "crash" });
      await new Promise((r) => setTimeout(r, 50));

      // actor1 should still be alive (no longer linked)
      expect(await actor1.call({ type: "ping" })).toBe("pong");
    });
  });

  describe("trap exit", () => {
    it("should receive exit message when trapExit is true", async () => {
      const trapper = system.spawn(TrapExitActor);
      const crashable = system.spawn(CrashableActor);

      trapper.cast({ type: "link", target: crashable });
      await new Promise((r) => setTimeout(r, 20));

      // Verify trap exit is enabled
      expect(await trapper.call({ type: "is_trapping" })).toBe(true);

      // Crash the linked actor
      crashable.cast({ type: "crash" });
      await new Promise((r) => setTimeout(r, 50));

      // Trapper should still be alive
      expect(await trapper.call({ type: "ping" })).toBe("pong");

      // Trapper should have received an exit message
      const exits = await trapper.call({ type: "get_exits" });
      expect(exits.length).toBe(1);
      expect(exits[0].type).toBe("exit");
      // Reason is "killed" because supervisor uses Stop strategy with maxRestarts=0
      expect(exits[0].reason.type).toBe("killed");
    });

    it("should crash if trapExit is false", async () => {
      const actor1 = system.spawn(ToggleTrapActor);
      const actor2 = system.spawn(CrashableActor);

      // trapExit defaults to false
      actor1.cast({ type: "link", target: actor2 });
      await new Promise((r) => setTimeout(r, 20));

      // Crash actor2
      actor2.cast({ type: "crash" });
      await new Promise((r) => setTimeout(r, 50));

      // actor1 should be dead (not trapping exits)
      await expect(actor1.call({ type: "ping" }, 100)).rejects.toThrow();
    });

    it("should survive crash when trapExit is enabled", async () => {
      const actor1 = system.spawn(ToggleTrapActor);
      const actor2 = system.spawn(CrashableActor);

      // Enable trap exit
      actor1.cast({ type: "set_trap", value: true });
      actor1.cast({ type: "link", target: actor2 });
      await new Promise((r) => setTimeout(r, 20));

      // Crash actor2
      actor2.cast({ type: "crash" });
      await new Promise((r) => setTimeout(r, 50));

      // actor1 should still be alive
      expect(await actor1.call({ type: "ping" })).toBe("pong");

      // Should have received exit message
      const exits = await actor1.call({ type: "get_exits" });
      expect(exits.length).toBe(1);
    });
  });

  describe("bidirectional links", () => {
    it("should propagate crash in either direction", async () => {
      // Create a new system for this test
      const cluster = new MockCluster("test-bidir");
      const biTransport = new InMemoryTransport(cluster.nodeId);
      const biRegistry = new LocalRegistry();
      const biSystem = new ActorSystem(cluster, biTransport, biRegistry, {
        strategy: "Stop",
        maxRestarts: 0,
        periodMs: 5000,
      });
      await biSystem.start();

      try {
        const actor1 = biSystem.spawn(LinkingActor);
        const actor2 = biSystem.spawn(LinkingActor);

        // Link from actor1 to actor2
        actor1.cast({ type: "link", target: actor2 });
        await new Promise((r) => setTimeout(r, 20));

        // Both should be alive
        expect(await actor1.call({ type: "ping" })).toBe("pong");
        expect(await actor2.call({ type: "ping" })).toBe("pong");

        // Crash actor1 (the initiator of the link)
        actor1.cast({ type: "crash" });
        await new Promise((r) => setTimeout(r, 50));

        // actor2 should also be dead
        await expect(actor2.call({ type: "ping" }, 100)).rejects.toThrow();
      } finally {
        await biSystem.shutdown();
      }
    });
  });

  describe("link cleanup", () => {
    it("should clean up links when actor is stopped", async () => {
      const actor1 = system.spawn(TrapExitActor);
      const actor2 = system.spawn(CrashableActor);

      actor1.cast({ type: "link", target: actor2 });
      await new Promise((r) => setTimeout(r, 20));

      // Gracefully stop actor2
      await system.stop(actor2);
      await new Promise((r) => setTimeout(r, 50));

      // actor1 should receive exit message with normal reason
      const exits = await actor1.call({ type: "get_exits" });
      expect(exits.length).toBe(1);
      expect(exits[0].reason.type).toBe("normal");
    });
  });
});
