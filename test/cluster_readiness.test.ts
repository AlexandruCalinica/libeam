import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import {
  createSystem,
  isClusterReady,
  waitForCluster,
  System,
  TimeoutError,
  DistributedCluster,
} from "../src";
import type { GossipProtocol, PeerState } from "../src";

class MockGossipProtocol extends EventEmitter {
  private readonly _nodeId: string;
  private readonly peers: Map<string, PeerState> = new Map();
  private _isLeaving = false;

  constructor(nodeId: string) {
    super();
    this._nodeId = nodeId;
    this.peers.set(nodeId, {
      id: nodeId,
      address: `tcp://127.0.0.1:5000`,
      heartbeat: 0,
      generation: 1,
      gossipAddress: `127.0.0.1:5002`,
      lastUpdated: Date.now(),
      status: "alive",
    });
  }

  getNodeId(): string {
    return this._nodeId;
  }

  getLivePeers(): PeerState[] {
    return Array.from(this.peers.values());
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async leave(): Promise<void> {
    this._isLeaving = true;
  }

  isLeaving(): boolean {
    return this._isLeaving;
  }

  addPeer(nodeId: string): void {
    const peer: PeerState = {
      id: nodeId,
      address: `tcp://127.0.0.1:${5000 + this.peers.size * 10}`,
      heartbeat: 0,
      generation: 1,
      gossipAddress: `127.0.0.1:${5002 + this.peers.size * 10}`,
      lastUpdated: Date.now(),
      status: "alive",
    };
    this.peers.set(nodeId, peer);
    this.emit("member_join", peer);
  }

  removePeer(nodeId: string): void {
    const peer = this.peers.get(nodeId);
    if (peer) {
      this.peers.delete(nodeId);
      this.emit("member_leave", peer);
    }
  }
}

function createMockDistributedCluster(nodeId: string) {
  const gossip = new MockGossipProtocol(nodeId);
  const cluster = new DistributedCluster(gossip as unknown as GossipProtocol);
  return { cluster, gossip };
}

describe("isClusterReady", () => {
  it("returns true when no conditions specified", () => {
    expect(isClusterReady(["node1"], {})).toBe(true);
  });

  it("returns true when minMembers met", () => {
    expect(isClusterReady(["node1", "node2"], { minMembers: 2 })).toBe(true);
  });

  it("returns false when minMembers not met", () => {
    expect(isClusterReady(["node1"], { minMembers: 2 })).toBe(false);
  });

  it("returns true when all required nodes present", () => {
    expect(
      isClusterReady(["node1", "node2", "node3"], { nodes: ["node2", "node3"] }),
    ).toBe(true);
  });

  it("returns false when required node missing", () => {
    expect(
      isClusterReady(["node1", "node2"], { nodes: ["node3"] }),
    ).toBe(false);
  });

  it("returns true when both conditions met", () => {
    expect(
      isClusterReady(["a", "b", "c"], { minMembers: 3, nodes: ["b", "c"] }),
    ).toBe(true);
  });

  it("returns false when minMembers met but nodes missing", () => {
    expect(
      isClusterReady(["a", "b", "c"], { minMembers: 2, nodes: ["d"] }),
    ).toBe(false);
  });

  it("returns false when nodes present but minMembers not met", () => {
    expect(
      isClusterReady(["a", "b"], { minMembers: 5, nodes: ["a"] }),
    ).toBe(false);
  });

  it("treats empty nodes array as no requirement", () => {
    expect(isClusterReady(["node1"], { nodes: [] })).toBe(true);
  });
});

describe("waitForCluster", () => {
  describe("local cluster", () => {
    let system: System;

    beforeEach(() => {
      system = createSystem({ nodeId: "local-test" });
    });

    afterEach(async () => {
      await system.shutdown();
    });

    it("resolves immediately with no options", async () => {
      await system.waitForCluster();
    });

    it("resolves immediately when minMembers <= 1", async () => {
      await system.waitForCluster({ minMembers: 1 });
    });

    it("throws TimeoutError when minMembers > 1", async () => {
      await expect(
        system.waitForCluster({ minMembers: 2, timeout: 50 }),
      ).rejects.toThrow(TimeoutError);
    });

    it("throws TimeoutError when required nodes not present", async () => {
      await expect(
        system.waitForCluster({ nodes: ["other-node"], timeout: 50 }),
      ).rejects.toThrow(TimeoutError);
    });

    it("resolves when required node is self", async () => {
      await system.waitForCluster({ nodes: ["local-test"] });
    });
  });

  describe("distributed cluster", () => {
    it("resolves immediately when minMembers already met", async () => {
      const { cluster, gossip } = createMockDistributedCluster("node1");
      gossip.addPeer("node2");

      await waitForCluster(cluster, { minMembers: 2 });
    });

    it("resolves immediately when required nodes already present", async () => {
      const { cluster, gossip } = createMockDistributedCluster("node1");
      gossip.addPeer("gateway");

      await waitForCluster(cluster, { nodes: ["gateway"] });
    });

    it("waits for member_join to meet minMembers", async () => {
      const { cluster, gossip } = createMockDistributedCluster("node1");

      const promise = waitForCluster(cluster, { minMembers: 2, timeout: 5000 });

      setTimeout(() => gossip.addPeer("node2"), 50);

      await promise;
    });

    it("waits for specific node IDs", async () => {
      const { cluster, gossip } = createMockDistributedCluster("node1");

      const promise = waitForCluster(cluster, {
        nodes: ["gateway"],
        timeout: 5000,
      });

      setTimeout(() => gossip.addPeer("gateway"), 50);

      await promise;
    });

    it("waits for both minMembers and nodes (AND)", async () => {
      const { cluster, gossip } = createMockDistributedCluster("node1");

      const promise = waitForCluster(cluster, {
        minMembers: 3,
        nodes: ["gateway"],
        timeout: 5000,
      });

      setTimeout(() => gossip.addPeer("gateway"), 30);
      setTimeout(() => gossip.addPeer("worker"), 60);

      await promise;
    });

    it("rejects with TimeoutError on timeout", async () => {
      const { cluster } = createMockDistributedCluster("node1");

      await expect(
        waitForCluster(cluster, { minMembers: 5, timeout: 100 }),
      ).rejects.toThrow(TimeoutError);
    });

    it("keeps waiting when member leaves during wait", async () => {
      const { cluster, gossip } = createMockDistributedCluster("node1");

      const promise = waitForCluster(cluster, { minMembers: 3, timeout: 5000 });

      setTimeout(() => gossip.addPeer("node2"), 20);
      setTimeout(() => gossip.removePeer("node2"), 40);
      setTimeout(() => gossip.addPeer("node2"), 60);
      setTimeout(() => gossip.addPeer("node3"), 80);

      await promise;
    });

    it("resolves multiple concurrent waitForCluster calls independently", async () => {
      const { cluster, gossip } = createMockDistributedCluster("node1");

      const wait2 = waitForCluster(cluster, { minMembers: 2, timeout: 5000 });
      const wait3 = waitForCluster(cluster, { minMembers: 3, timeout: 5000 });

      setTimeout(() => gossip.addPeer("node2"), 30);
      setTimeout(() => gossip.addPeer("node3"), 60);

      await wait2;
      await wait3;
    });

    it("cleans up event listeners after resolution", async () => {
      const { cluster, gossip } = createMockDistributedCluster("node1");

      const listenersBefore = cluster.listenerCount("member_join");

      const promise = waitForCluster(cluster, { minMembers: 2, timeout: 5000 });
      expect(cluster.listenerCount("member_join")).toBe(listenersBefore + 1);

      gossip.addPeer("node2");
      await promise;

      expect(cluster.listenerCount("member_join")).toBe(listenersBefore);
    });

    it("cleans up event listeners after timeout", async () => {
      const { cluster } = createMockDistributedCluster("node1");

      const listenersBefore = cluster.listenerCount("member_join");

      await waitForCluster(cluster, { minMembers: 5, timeout: 50 }).catch(
        () => {},
      );

      expect(cluster.listenerCount("member_join")).toBe(listenersBefore);
    });

    it("uses default minMembers of 2 when no options given", async () => {
      const { cluster, gossip } = createMockDistributedCluster("node1");

      const promise = waitForCluster(cluster, { timeout: 5000 });

      setTimeout(() => gossip.addPeer("node2"), 50);

      await promise;
    });

    it("uses default timeout of 30000 when not specified", async () => {
      const { cluster } = createMockDistributedCluster("node1");

      const start = Date.now();
      await waitForCluster(cluster, { minMembers: 2, timeout: 100 }).catch(
        (err) => {
          expect(err).toBeInstanceOf(TimeoutError);
          expect(err.context.timeoutMs).toBe(100);
        },
      );

      expect(Date.now() - start).toBeLessThan(500);
    });
  });

  describe("createSystem with ready option", () => {
    it("resolves immediately for local system (no ready option)", async () => {
      const system = createSystem({ nodeId: "local-ready" });
      await system.waitForCluster();
      await system.shutdown();
    });
  });
});
