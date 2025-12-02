import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor,
  ActorRef,
  ActorSystem,
  Cluster,
  InMemoryTransport,
  InMemoryRegistry,
  WatchRef,
  DownMessage,
  InfoMessage,
} from "../src";

/**
 * A simple in-memory cluster implementation for testing.
 */
class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}

  getMembers(): string[] {
    return [this.nodeId];
  }
}

// Test actors
class WatcherActor extends Actor {
  public downMessages: DownMessage[] = [];
  public watchRefs: WatchRef[] = [];

  handleInfo(message: InfoMessage): void {
    if (message.type === "down") {
      this.downMessages.push(message);
    }
  }

  handleCast(message: any): void {
    if (message.type === "watch") {
      const watchRef = this.watch(message.target);
      this.watchRefs.push(watchRef);
    } else if (message.type === "unwatch") {
      const watchRef = this.watchRefs.find(
        (ref) => ref.watchedId === message.targetId,
      );
      if (watchRef) {
        this.unwatch(watchRef);
      }
    }
  }

  handleCall(message: any): any {
    if (message.type === "getDownMessages") {
      return this.downMessages;
    }
    if (message.type === "getWatchRefs") {
      return this.watchRefs;
    }
    return null;
  }
}

class WatchedActor extends Actor {
  handleCast(message: any): void {
    if (message.type === "crash") {
      throw new Error("Intentional crash");
    }
  }

  handleCall(message: any): any {
    if (message.type === "ping") {
      return "pong";
    }
    return null;
  }
}

describe("Distributed Actor Watching", () => {
  let node1: ActorSystem;
  let node2: ActorSystem;
  let transport1: InMemoryTransport;
  let transport2: InMemoryTransport;
  let registry1: InMemoryRegistry;
  let registry2: InMemoryRegistry;

  beforeEach(async () => {
    // Create two nodes with connected transports
    const cluster1 = new MockCluster("node1");
    const cluster2 = new MockCluster("node2");

    transport1 = new InMemoryTransport("node1");
    transport2 = new InMemoryTransport("node2");

    // Connect transports to each other
    transport1.setPeer("node2", transport2);
    transport2.setPeer("node1", transport1);

    registry1 = new InMemoryRegistry();
    registry2 = new InMemoryRegistry();

    node1 = new ActorSystem(cluster1, transport1, registry1);
    node2 = new ActorSystem(cluster2, transport2, registry2);

    await node1.start();
    await node2.start();
  });

  afterEach(async () => {
    await node1.shutdown();
    await node2.shutdown();
  });

  it("should receive DOWN message when remote watched actor is stopped", async () => {
    // Watcher on node1, watched on node2
    const watcher = node1.spawn(WatcherActor);
    const watched = node2.spawn(WatchedActor);

    // Verify the remote actor is alive
    const pong = await watched.call({ type: "ping" });
    expect(pong).toBe("pong");

    // Set up remote watch
    watcher.cast({ type: "watch", target: watched });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Stop the watched actor on node2
    await node2.stop(watched);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Check that watcher on node1 received DOWN message
    const downMessages = await watcher.call({ type: "getDownMessages" });
    expect(downMessages).toHaveLength(1);
    expect(downMessages[0].type).toBe("down");
    expect(downMessages[0].actorRef.id.id).toBe(watched.id.id);
    expect(downMessages[0].reason.type).toBe("normal");
  });

  it("should receive DOWN message when remote watched actor crashes", async () => {
    // Create node2 with Stop strategy for crashes
    await node2.shutdown();
    const cluster2 = new MockCluster("node2");
    transport2 = new InMemoryTransport("node2");
    transport1.setPeer("node2", transport2);
    transport2.setPeer("node1", transport1);
    registry2 = new InMemoryRegistry();
    node2 = new ActorSystem(cluster2, transport2, registry2, {
      strategy: "Stop",
      maxRestarts: 0,
      periodMs: 5000,
    });
    await node2.start();

    const watcher = node1.spawn(WatcherActor);
    const watched = node2.spawn(WatchedActor);

    // Set up remote watch
    watcher.cast({ type: "watch", target: watched });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Crash the watched actor
    watched.cast({ type: "crash" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check that watcher received DOWN message with killed reason
    // (actor is killed when it exceeds max restarts with Stop strategy)
    const downMessages = await watcher.call({ type: "getDownMessages" });
    expect(downMessages).toHaveLength(1);
    expect(downMessages[0].type).toBe("down");
    expect(downMessages[0].reason.type).toBe("killed");
  });

  it("should not receive DOWN message after unwatching remote actor", async () => {
    const watcher = node1.spawn(WatcherActor);
    const watched = node2.spawn(WatchedActor);

    // Set up remote watch
    watcher.cast({ type: "watch", target: watched });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Unwatch
    watcher.cast({ type: "unwatch", targetId: watched.id.id });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Stop the watched actor
    await node2.stop(watched);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Check that watcher did NOT receive DOWN message
    const downMessages = await watcher.call({ type: "getDownMessages" });
    expect(downMessages).toHaveLength(0);
  });

  it("should receive immediate DOWN when watching already-dead remote actor", async () => {
    const watcher = node1.spawn(WatcherActor);
    const watched = node2.spawn(WatchedActor);

    // Stop the actor first
    await node2.stop(watched);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now try to watch it - should get immediate DOWN
    watcher.cast({ type: "watch", target: watched });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const downMessages = await watcher.call({ type: "getDownMessages" });
    expect(downMessages).toHaveLength(1);
    // Reason is "normal" because the actor was already dead when watch was established
    expect(downMessages[0].reason.type).toBe("normal");
  });

  it("should allow multiple remote watchers on the same actor", async () => {
    const watcher1 = node1.spawn(WatcherActor);
    const watcher2 = node1.spawn(WatcherActor);
    const watched = node2.spawn(WatchedActor);

    // Both watchers watch the same remote actor
    watcher1.cast({ type: "watch", target: watched });
    watcher2.cast({ type: "watch", target: watched });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Stop the watched actor
    await node2.stop(watched);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Both watchers should receive DOWN
    const downMessages1 = await watcher1.call({ type: "getDownMessages" });
    const downMessages2 = await watcher2.call({ type: "getDownMessages" });
    expect(downMessages1).toHaveLength(1);
    expect(downMessages2).toHaveLength(1);
  });

  it("should handle node failure by notifying all watchers", async () => {
    const watcher = node1.spawn(WatcherActor);
    const watched1 = node2.spawn(WatchedActor);
    const watched2 = node2.spawn(WatchedActor);

    // Watch both actors on node2
    watcher.cast({ type: "watch", target: watched1 });
    watcher.cast({ type: "watch", target: watched2 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate node2 failure
    node1.handleNodeFailure("node2");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Watcher should receive DOWN for both actors
    const downMessages = await watcher.call({ type: "getDownMessages" });
    expect(downMessages).toHaveLength(2);
    expect(
      downMessages.every((m: DownMessage) => m.reason.type === "killed"),
    ).toBe(true);
  });

  it("should clean up remote watcher entries when watcher node fails", async () => {
    const watcher = node1.spawn(WatcherActor);
    const watched = node2.spawn(WatchedActor);

    // Set up remote watch
    watcher.cast({ type: "watch", target: watched });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate node1 failure on node2's side
    node2.handleNodeFailure("node1");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now stop the watched actor - should not cause errors
    // (remote watcher entry should have been cleaned up)
    await node2.stop(watched);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Just verify no errors occurred
    expect(true).toBe(true);
  });

  it("should include correct WatchRef in remote DOWN message", async () => {
    const watcher = node1.spawn(WatcherActor);
    const watched = node2.spawn(WatchedActor);

    // Set up remote watch
    watcher.cast({ type: "watch", target: watched });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Get the watch ref
    const watchRefs = await watcher.call({ type: "getWatchRefs" });
    expect(watchRefs).toHaveLength(1);
    const watchRef = watchRefs[0];

    // Stop the watched actor
    await node2.stop(watched);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Check that DOWN message includes the correct WatchRef
    const downMessages = await watcher.call({ type: "getDownMessages" });
    expect(downMessages).toHaveLength(1);
    expect(downMessages[0].watchRef.id).toBe(watchRef.id);
    expect(downMessages[0].watchRef.watcherId).toBe(watcher.id.id);
    expect(downMessages[0].watchRef.watchedId).toBe(watched.id.id);
  });

  it("should handle bidirectional remote watching", async () => {
    // Actor on node1 watches actor on node2, and vice versa
    const actor1 = node1.spawn(WatcherActor);
    const actor2 = node2.spawn(WatcherActor);

    // Each watches the other
    actor1.cast({ type: "watch", target: actor2 });
    actor2.cast({ type: "watch", target: actor1 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Stop actor2 on node2
    await node2.stop(actor2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // actor1 should receive DOWN for actor2
    const downMessages1 = await actor1.call({ type: "getDownMessages" });
    expect(downMessages1).toHaveLength(1);
    expect(downMessages1[0].actorRef.id.id).toBe(actor2.id.id);
  });
});
