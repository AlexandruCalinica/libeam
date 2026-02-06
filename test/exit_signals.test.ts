import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor,
  ActorSystem,
  ActorRef,
  Cluster,
  InMemoryTransport,
  LocalRegistry,
  InfoMessage,
  ExitMessage,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

// Worker that can be killed
class WorkerActor extends Actor {
  public name: string = "";

  init(name: string) {
    this.name = name;
  }

  handleCast(message: any) {
    if (message.type === "work") {
      // do work
    }
  }

  handleCall(message: any) {
    if (message.type === "getName") {
      return this.name;
    }
    return null;
  }

  terminate() {
    // cleanup
  }
}

// Worker that traps exits
class TrapExitWorker extends Actor {
  public exits: ExitMessage[] = [];

  init() {
    this.setTrapExit(true);
  }

  handleCast(_message: any) {}

  handleCall(message: any) {
    if (message.type === "getExits") {
      return this.exits;
    }
    return null;
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "exit") {
      this.exits.push(message as ExitMessage);
    }
  }
}

// Manager that sends exit signals
class ManagerActor extends Actor {
  public workers: ActorRef[] = [];

  handleCast(message: any) {
    if (message.type === "addWorker") {
      this.workers.push(message.workerRef);
    } else if (message.type === "exitWorker") {
      const worker = this.workers[message.index];
      if (worker) {
        this.exit(worker, message.reason);
      }
    } else if (message.type === "exitAll") {
      for (const worker of this.workers) {
        this.exit(worker, message.reason);
      }
    }
  }

  handleCall(message: any) {
    if (message.type === "getWorkerCount") {
      return this.workers.length;
    }
    return null;
  }
}

describe("Exit Signals", () => {
  let system: ActorSystem;

  beforeEach(async () => {
    const cluster = new MockCluster("test-node");
    const transport = new InMemoryTransport(cluster.nodeId);
    const registry = new LocalRegistry();
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

  describe("basic exit signals", () => {
    it("should terminate actor when exit signal is sent", async () => {
      const worker = system.spawn(WorkerActor, { args: ["Worker-1"] });
      const manager = system.spawn(ManagerActor);

      manager.cast({ type: "addWorker", workerRef: worker });
      await new Promise((r) => setTimeout(r, 50));

      // Worker should be alive
      const name = await worker.call({ type: "getName" });
      expect(name).toBe("Worker-1");

      // Send exit signal
      manager.cast({ type: "exitWorker", index: 0, reason: "shutdown" });
      await new Promise((r) => setTimeout(r, 100));

      // Worker should be gone
      const actors = system.getLocalActorIds();
      expect(actors).not.toContain(worker.id.id);
      expect(actors).toContain(manager.id.id);
    });

    it("should not affect actor when reason is 'normal'", async () => {
      const worker = system.spawn(WorkerActor, { args: ["Worker-1"] });
      const manager = system.spawn(ManagerActor);

      manager.cast({ type: "addWorker", workerRef: worker });
      await new Promise((r) => setTimeout(r, 50));

      // Send normal exit signal
      manager.cast({ type: "exitWorker", index: 0, reason: "normal" });
      await new Promise((r) => setTimeout(r, 100));

      // Worker should still be alive
      const name = await worker.call({ type: "getName" });
      expect(name).toBe("Worker-1");
    });

    it("should force terminate with 'kill' even if trapping exits", async () => {
      const worker = system.spawn(TrapExitWorker);
      const manager = system.spawn(ManagerActor);

      manager.cast({ type: "addWorker", workerRef: worker });
      await new Promise((r) => setTimeout(r, 50));

      // Send kill signal
      manager.cast({ type: "exitWorker", index: 0, reason: "kill" });
      await new Promise((r) => setTimeout(r, 100));

      // Worker should be gone despite trapping exits
      const actors = system.getLocalActorIds();
      expect(actors).not.toContain(worker.id.id);
    });
  });

  describe("trapExit behavior", () => {
    it("should deliver exit as message when trapExit is enabled", async () => {
      const worker = system.spawn(TrapExitWorker);
      const manager = system.spawn(ManagerActor);

      manager.cast({ type: "addWorker", workerRef: worker });
      await new Promise((r) => setTimeout(r, 50));

      // Send exit signal (not kill)
      manager.cast({ type: "exitWorker", index: 0, reason: "shutdown" });
      await new Promise((r) => setTimeout(r, 100));

      // Worker should still be alive
      const actors = system.getLocalActorIds();
      expect(actors).toContain(worker.id.id);

      // Worker should have received exit message
      const exits = await worker.call({ type: "getExits" });
      expect(exits.length).toBe(1);
      expect(exits[0].type).toBe("exit");
      expect(exits[0].actorRef.id.id).toBe(manager.id.id);
      expect(exits[0].linkRef).toBeUndefined(); // Not a link-based exit
    });

    it("should receive multiple exit signals", async () => {
      const worker = system.spawn(TrapExitWorker);
      const manager1 = system.spawn(ManagerActor);
      const manager2 = system.spawn(ManagerActor);

      manager1.cast({ type: "addWorker", workerRef: worker });
      manager2.cast({ type: "addWorker", workerRef: worker });
      await new Promise((r) => setTimeout(r, 50));

      // Send exit signals from both managers
      manager1.cast({ type: "exitWorker", index: 0, reason: "reason1" });
      manager2.cast({ type: "exitWorker", index: 0, reason: "reason2" });
      await new Promise((r) => setTimeout(r, 100));

      // Worker should have received both
      const exits = await worker.call({ type: "getExits" });
      expect(exits.length).toBe(2);
    });
  });

  describe("exit non-existent actor", () => {
    it("should handle exit to non-existent actor gracefully", async () => {
      const worker = system.spawn(WorkerActor, { args: ["Worker-1"] });
      const manager = system.spawn(ManagerActor);

      manager.cast({ type: "addWorker", workerRef: worker });
      await new Promise((r) => setTimeout(r, 50));

      // Stop worker first
      await system.stop(worker);

      // Send exit to already-stopped actor - should not throw
      manager.cast({ type: "exitWorker", index: 0, reason: "shutdown" });
      await new Promise((r) => setTimeout(r, 50));

      // Manager should still be alive
      const actors = system.getLocalActorIds();
      expect(actors).toContain(manager.id.id);
    });
  });
});
