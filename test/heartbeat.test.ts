// test/heartbeat.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import {
  HeartbeatManager,
  HeartbeatConfig,
  HeartbeatPing,
  HeartbeatPong,
  DEFAULT_HEARTBEAT_CONFIG,
} from "../src/heartbeat";
import { Transport } from "../src/transport";
import { Cluster, ClusterPeer } from "../src/cluster";

/**
 * Mock transport for testing
 */
class MockTransport implements Transport {
  private requestHandler?: (message: any) => Promise<any>;
  private messageHandler?: (message: any) => void;
  public sentRequests: Array<{
    nodeId: string;
    message: any;
    timeout: number;
  }> = [];
  public pendingRequests: Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  > = new Map();
  private requestCounter = 0;

  constructor(private nodeId: string) {}

  getNodeId(): string {
    return this.nodeId;
  }

  async request(nodeId: string, message: any, timeout: number): Promise<any> {
    const requestId = `req-${this.requestCounter++}`;
    this.sentRequests.push({ nodeId, message, timeout });

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });

      // Store the requestId in the message for easy lookup
      (message as any)._requestId = requestId;

      // Timeout handling
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error(`Timeout after ${timeout}ms`));
        }
      }, timeout);
    });
  }

  // Helper to respond to the last request
  respondToLastRequest(response: any): void {
    const lastRequest = this.sentRequests[this.sentRequests.length - 1];
    if (lastRequest) {
      const requestId = (lastRequest.message as any)._requestId;
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        this.pendingRequests.delete(requestId);
        pending.resolve(response);
      }
    }
  }

  // Helper to respond to a specific peer's request
  respondToPeerRequest(nodeId: string, response: any): void {
    const request = this.sentRequests.find(
      (r) =>
        r.nodeId === nodeId && this.pendingRequests.has(r.message._requestId),
    );
    if (request) {
      const requestId = request.message._requestId;
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        this.pendingRequests.delete(requestId);
        pending.resolve(response);
      }
    }
  }

  async send(nodeId: string, message: any): Promise<void> {
    // Fire and forget
  }

  async publish(topic: string, message: any): Promise<void> {}

  async subscribe(
    topic: string,
    handler: (message: any) => void,
  ): Promise<any> {
    return { unsubscribe: async () => {} };
  }

  onRequest(handler: (message: any) => Promise<any>): void {
    this.requestHandler = handler;
  }

  onMessage(handler: (message: any) => void): void {
    this.messageHandler = handler;
  }

  updatePeers(peers: Array<[string, string]>): void {}

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}
}

/**
 * Mock cluster for testing
 */
class MockCluster extends EventEmitter implements Cluster {
  readonly nodeId: string;
  private peers: ClusterPeer[] = [];

  constructor(nodeId: string) {
    super();
    this.nodeId = nodeId;
    this.peers = [{ id: nodeId }]; // Self
  }

  getMembers(): string[] {
    return this.peers.map((p) => p.id);
  }

  getLivePeers(): ClusterPeer[] {
    return this.peers;
  }

  addPeer(peerId: string, status?: string): void {
    this.peers.push({ id: peerId, status });
    this.emit("member_join", peerId);
  }

  removePeer(peerId: string, status?: string): void {
    this.peers = this.peers.filter((p) => p.id !== peerId);
    this.emit("member_leave", status ? { id: peerId, status } : peerId);
  }
}

describe("HeartbeatManager", () => {
  let transport: MockTransport;
  let cluster: MockCluster;
  let heartbeat: HeartbeatManager;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new MockTransport("node1");
    cluster = new MockCluster("node1");
  });

  afterEach(async () => {
    if (heartbeat) {
      await heartbeat.stop();
    }
    vi.useRealTimers();
  });

  describe("configuration", () => {
    it("should use default configuration when none provided", async () => {
      heartbeat = new HeartbeatManager("node1", transport, cluster);
      expect(heartbeat.isRunning()).toBe(false);
    });

    it("should merge custom config with defaults", async () => {
      heartbeat = new HeartbeatManager("node1", transport, cluster, {
        intervalMs: 500,
        maxMissedHeartbeats: 5,
      });

      // Just verify it was created without errors
      expect(heartbeat).toBeDefined();
    });

    it("should not start when disabled", async () => {
      heartbeat = new HeartbeatManager("node1", transport, cluster, {
        enabled: false,
      });

      await heartbeat.start();
      expect(heartbeat.isRunning()).toBe(false);
    });
  });

  describe("lifecycle", () => {
    it("should start and stop correctly", async () => {
      heartbeat = new HeartbeatManager("node1", transport, cluster);

      await heartbeat.start();
      expect(heartbeat.isRunning()).toBe(true);

      await heartbeat.stop();
      expect(heartbeat.isRunning()).toBe(false);
    });

    it("should be idempotent for start", async () => {
      heartbeat = new HeartbeatManager("node1", transport, cluster);

      await heartbeat.start();
      await heartbeat.start(); // Second call should be no-op

      expect(heartbeat.isRunning()).toBe(true);
    });

    it("should be idempotent for stop", async () => {
      heartbeat = new HeartbeatManager("node1", transport, cluster);

      await heartbeat.start();
      await heartbeat.stop();
      await heartbeat.stop(); // Second call should be no-op

      expect(heartbeat.isRunning()).toBe(false);
    });
  });

  describe("ping/pong", () => {
    it("should handle ping and return pong", () => {
      heartbeat = new HeartbeatManager("node1", transport, cluster);

      const ping: HeartbeatPing = {
        type: "heartbeat:ping",
        timestamp: 1234567890,
        senderId: "node2",
      };

      const pong = heartbeat.handlePing(ping);

      expect(pong.type).toBe("heartbeat:pong");
      expect(pong.timestamp).toBe(1234567890);
      expect(pong.responderId).toBe("node1");
    });

    it("should send pings to all peers at interval", async () => {
      cluster.addPeer("node2");
      cluster.addPeer("node3");

      heartbeat = new HeartbeatManager("node1", transport, cluster, {
        intervalMs: 1000,
        staggerPings: false, // Disable staggering for simpler test
      });

      await heartbeat.start();

      // First heartbeat runs immediately
      expect(transport.sentRequests.length).toBe(2);
      expect(transport.sentRequests[0].nodeId).toBe("node2");
      expect(transport.sentRequests[1].nodeId).toBe("node3");

      // Respond to pings
      transport.respondToPeerRequest("node2", {
        type: "heartbeat:pong",
        timestamp: Date.now(),
        responderId: "node2",
      });
      transport.respondToPeerRequest("node3", {
        type: "heartbeat:pong",
        timestamp: Date.now(),
        responderId: "node3",
      });

      // Advance time to next interval
      vi.advanceTimersByTime(1000);

      expect(transport.sentRequests.length).toBe(4);
    });

    it("should stagger pings when enabled", async () => {
      cluster.addPeer("node2");
      cluster.addPeer("node3");
      cluster.addPeer("node4");

      heartbeat = new HeartbeatManager("node1", transport, cluster, {
        intervalMs: 1000,
        staggerPings: true,
      });

      await heartbeat.start();

      // With staggering, first ping is scheduled at delay 0, second at ~333ms, third at ~666ms
      // Need to advance timers to trigger the setTimeout(..., 0)
      vi.advanceTimersByTime(1);
      expect(transport.sentRequests.length).toBe(1);

      // Advance by 1/3 of interval (333ms)
      vi.advanceTimersByTime(333);
      expect(transport.sentRequests.length).toBe(2);

      // Advance by another 1/3
      vi.advanceTimersByTime(333);
      expect(transport.sentRequests.length).toBe(3);
    });
  });

  describe("failure detection", () => {
    it("should emit node_failed after maxMissedHeartbeats", async () => {
      cluster.addPeer("node2");

      heartbeat = new HeartbeatManager("node1", transport, cluster, {
        intervalMs: 1000,
        timeoutMs: 500,
        maxMissedHeartbeats: 3,
        staggerPings: false,
      });

      const failedNodes: string[] = [];
      heartbeat.on("node_failed", (nodeId: string) => {
        failedNodes.push(nodeId);
      });

      await heartbeat.start();

      // First ping sent, let it timeout
      expect(transport.sentRequests.length).toBe(1);

      // Advance past timeout and to next interval - missed count = 1
      vi.advanceTimersByTime(1000);
      expect(failedNodes.length).toBe(0);

      // Second interval - missed count = 2
      vi.advanceTimersByTime(1000);
      expect(failedNodes.length).toBe(0);

      // Third interval - missed count = 3, should trigger failure
      vi.advanceTimersByTime(1000);
      expect(failedNodes).toContain("node2");
    });

    it("should reset missed count on pong", async () => {
      // Use real timers for this test since we need async promise resolution
      vi.useRealTimers();

      cluster.addPeer("node2");

      heartbeat = new HeartbeatManager("node1", transport, cluster, {
        intervalMs: 100,
        timeoutMs: 50,
        maxMissedHeartbeats: 3,
        staggerPings: false,
      });

      const failedNodes: string[] = [];
      heartbeat.on("node_failed", (nodeId: string) => {
        failedNodes.push(nodeId);
      });

      await heartbeat.start();

      // Wait a bit for first ping to be sent
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Respond to the ping
      transport.respondToPeerRequest("node2", {
        type: "heartbeat:pong",
        timestamp: Date.now(),
        responderId: "node2",
      });

      // Wait for the response to be processed
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Verify the peer state shows missed count is 0
      const state = heartbeat.getPeerState("node2");
      expect(state).toBeDefined();
      expect(state!.missedCount).toBe(0);
      expect(state!.pendingPing).toBe(false);

      // No failures should have occurred
      expect(failedNodes.length).toBe(0);

      // Re-enable fake timers for afterEach cleanup
      vi.useFakeTimers();
    });
  });

  describe("peer lifecycle", () => {
    it("should track new peers from member_join events", async () => {
      heartbeat = new HeartbeatManager("node1", transport, cluster, {
        staggerPings: false,
      });

      await heartbeat.start();

      // Initially no peers (only self)
      expect(heartbeat.getTrackedPeers()).toEqual([]);

      // Add a peer
      cluster.addPeer("node2");

      expect(heartbeat.getTrackedPeers()).toContain("node2");
    });

    it("should remove peers from member_leave events", async () => {
      cluster.addPeer("node2");

      heartbeat = new HeartbeatManager("node1", transport, cluster, {
        staggerPings: false,
      });

      await heartbeat.start();
      expect(heartbeat.getTrackedPeers()).toContain("node2");

      // Remove peer
      cluster.removePeer("node2");

      expect(heartbeat.getTrackedPeers()).not.toContain("node2");
    });

    it("should not emit node_failed for gracefully leaving peers", async () => {
      cluster.addPeer("node2");

      heartbeat = new HeartbeatManager("node1", transport, cluster, {
        intervalMs: 1000,
        timeoutMs: 500,
        maxMissedHeartbeats: 2,
        staggerPings: false,
      });

      const failedNodes: string[] = [];
      heartbeat.on("node_failed", (nodeId: string) => {
        failedNodes.push(nodeId);
      });

      await heartbeat.start();

      // First ping timeout - missed = 1
      vi.advanceTimersByTime(1000);

      // Before second timeout, peer gracefully leaves
      cluster.removePeer("node2", "leaving");

      // Advance time - should NOT trigger failure
      vi.advanceTimersByTime(5000);
      expect(failedNodes.length).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("should handle no peers gracefully", async () => {
      heartbeat = new HeartbeatManager("node1", transport, cluster);

      await heartbeat.start();

      // Advance time - should not throw
      vi.advanceTimersByTime(5000);

      expect(transport.sentRequests.length).toBe(0);
    });

    it("should not ping self", async () => {
      // Self is already in cluster
      heartbeat = new HeartbeatManager("node1", transport, cluster, {
        staggerPings: false,
      });

      await heartbeat.start();

      vi.advanceTimersByTime(5000);

      // Should not have sent any pings to self
      const selfPings = transport.sentRequests.filter(
        (r) => r.nodeId === "node1",
      );
      expect(selfPings.length).toBe(0);
    });

    it("should clear pending state on stop", async () => {
      cluster.addPeer("node2");

      heartbeat = new HeartbeatManager("node1", transport, cluster, {
        staggerPings: false,
      });

      await heartbeat.start();
      expect(heartbeat.getTrackedPeers().length).toBe(1);

      await heartbeat.stop();
      expect(heartbeat.getTrackedPeers().length).toBe(0);
    });
  });
});

describe("DEFAULT_HEARTBEAT_CONFIG", () => {
  it("should have sensible defaults", () => {
    expect(DEFAULT_HEARTBEAT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_HEARTBEAT_CONFIG.intervalMs).toBe(1000);
    expect(DEFAULT_HEARTBEAT_CONFIG.timeoutMs).toBe(2000);
    expect(DEFAULT_HEARTBEAT_CONFIG.maxMissedHeartbeats).toBe(3);
    expect(DEFAULT_HEARTBEAT_CONFIG.staggerPings).toBe(true);
  });
});
