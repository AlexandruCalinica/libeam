// test/gossip_protocol.test.ts

import { vi } from "vitest";
import {
  GossipProtocol,
  GossipUDP,
  PeerState,
  CustomGossipCluster,
  GossipMessage,
} from "../src";
import { EventEmitter } from "events";

// Mock GossipUDP to simulate the network without real UDP sockets
const networkBus = new EventEmitter();

class MockGossipUDP extends EventEmitter {
  private address: string;
  constructor(config: { address: string; port: number }) {
    super();
    this.address = `${config.address}:${config.port}`;
  }
  async start() {
    networkBus.on(this.address, (msg: GossipMessage, rinfo: any) => {
      this.emit("message", msg, rinfo);
    });
  }
  async stop() {
    networkBus.removeAllListeners(this.address);
  }
  async send(
    message: GossipMessage,
    targetAddress: string,
    targetPort: number,
  ) {
    const target = `${targetAddress}:${targetPort}`;
    const rinfo = {
      address: this.address.split(":")[0],
      port: parseInt(this.address.split(":")[1], 10),
    };
    // Simulate async network call
    setTimeout(() => {
      networkBus.emit(target, message, rinfo);
    }, 0);
  }
}

describe("GossipProtocol", () => {
  const node1Id = "node1";
  const node2Id = "node2";
  const node3Id = "node3";
  const node1Rpc = "tcp://127.0.0.1:5001";
  const node1Gossip = "127.0.0.1:6001";
  const node2Rpc = "tcp://127.0.0.1:5002";
  const node2Gossip = "127.0.0.1:6002";
  const node3Rpc = "tcp://127.0.0.1:5003";
  const node3Gossip = "127.0.0.1:6003";

  beforeEach(() => {
    vi.useFakeTimers();
    networkBus.removeAllListeners();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should discover a peer via a seed node", async () => {
    const commonOptions = {
      gossipIntervalMs: 100,
      cleanupIntervalMs: 200,
      failureTimeoutMs: 1000,
      gossipFanout: 1,
    };

    const udp1 = new MockGossipUDP({ address: "127.0.0.1", port: 6001 });
    const proto1 = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      udp1 as any,
      { ...commonOptions, seedNodes: [] },
    );

    const udp2 = new MockGossipUDP({ address: "127.0.0.1", port: 6002 });
    const proto2 = new GossipProtocol(
      node2Id,
      node2Rpc,
      node2Gossip,
      udp2 as any,
      { ...commonOptions, seedNodes: [node1Gossip] },
    );

    await proto1.start();
    await proto2.start();

    const node1Sees2 = new Promise<void>((resolve) =>
      proto1.once("member_join", (peer: PeerState) => {
        if (peer.id === node2Id) resolve();
      }),
    );
    const node2Sees1 = new Promise<void>((resolve) =>
      proto2.once("member_join", (peer: PeerState) => {
        if (peer.id === node1Id) resolve();
      }),
    );

    // Run the first gossip loop for node2, which sends to the seed (node1)
    vi.advanceTimersByTime(100);
    await vi.runAllTicks(); // allow mock UDP to deliver message

    // Run the first gossip loop for node1, which now knows about node2
    vi.advanceTimersByTime(100);
    await vi.runAllTicks();

    // Run second loop for node2, which should get node1's list
    vi.advanceTimersByTime(100);
    await vi.runAllTicks();

    await Promise.all([node1Sees2, node2Sees1]);

    expect(proto1.getLivePeers().map((p) => p.id)).toContain(node2Id);
    expect(proto2.getLivePeers().map((p) => p.id)).toContain(node1Id);

    await proto1.stop();
    await proto2.stop();
  });

  it("should form a full mesh with three nodes", async () => {
    const commonOptions = {
      gossipIntervalMs: 100,
      cleanupIntervalMs: 200,
      failureTimeoutMs: 1000,
      gossipFanout: 2,
    };

    const udp1 = new MockGossipUDP({ address: "127.0.0.1", port: 6001 });
    const proto1 = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      udp1 as any,
      { ...commonOptions, seedNodes: [] },
    );

    const udp2 = new MockGossipUDP({ address: "127.0.0.1", port: 6002 });
    const proto2 = new GossipProtocol(
      node2Id,
      node2Rpc,
      node2Gossip,
      udp2 as any,
      { ...commonOptions, seedNodes: [node1Gossip] },
    );

    const udp3 = new MockGossipUDP({ address: "127.0.0.1", port: 6003 });
    const proto3 = new GossipProtocol(
      node3Id,
      node3Rpc,
      node3Gossip,
      udp3 as any,
      { ...commonOptions, seedNodes: [node1Gossip] },
    );

    await Promise.all([proto1.start(), proto2.start(), proto3.start()]);

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100);
      await vi.runAllTicks();
    }

    expect(proto1.getLivePeers().map((p) => p.id)).toEqual(
      expect.arrayContaining([node1Id, node2Id, node3Id]),
    );
    expect(proto2.getLivePeers().map((p) => p.id)).toEqual(
      expect.arrayContaining([node1Id, node2Id, node3Id]),
    );
    expect(proto3.getLivePeers().map((p) => p.id)).toEqual(
      expect.arrayContaining([node1Id, node2Id, node3Id]),
    );

    await Promise.all([proto1.stop(), proto2.stop(), proto3.stop()]);
  });

  it("should detect a failed node and remove it", async () => {
    const commonOptions = {
      gossipIntervalMs: 100,
      cleanupIntervalMs: 200,
      failureTimeoutMs: 500,
      gossipFanout: 1,
    };

    const udp1 = new MockGossipUDP({ address: "127.0.0.1", port: 6001 });
    const proto1 = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      udp1 as any,
      { ...commonOptions, seedNodes: [node2Gossip] },
    );

    const udp2 = new MockGossipUDP({ address: "127.0.0.1", port: 6002 });
    const proto2 = new GossipProtocol(
      node2Id,
      node2Rpc,
      node2Gossip,
      udp2 as any,
      { ...commonOptions, seedNodes: [node1Gossip] },
    );

    await proto1.start();
    await proto2.start();

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(100);
      await vi.runAllTicks();
    }
    expect(proto1.getLivePeers().map((p) => p.id)).toContain(node2Id);

    await proto2.stop();

    const node2Leaves = new Promise<void>((resolve) =>
      proto1.once("member_leave", (peer: PeerState) => {
        if (peer.id === node2Id) resolve();
      }),
    );

    // Advance time past the failure timeout
    vi.advanceTimersByTime(
      commonOptions.failureTimeoutMs + commonOptions.cleanupIntervalMs,
    );
    await vi.runAllTicks();

    await node2Leaves;

    expect(proto1.getLivePeers().map((p) => p.id)).not.toContain(node2Id);

    await proto1.stop();
  });

  it("should handle node restart (generation counter)", async () => {
    const commonOptions = {
      gossipIntervalMs: 100,
      cleanupIntervalMs: 200,
      failureTimeoutMs: 500,
      gossipFanout: 1,
    };

    const udp1 = new MockGossipUDP({ address: "127.0.0.1", port: 6001 });
    const proto1 = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      udp1 as any,
      { ...commonOptions, seedNodes: [node2Gossip] },
    );

    let udp2 = new MockGossipUDP({ address: "127.0.0.1", port: 6002 });
    let proto2: GossipProtocol | null = new GossipProtocol(
      node2Id,
      node2Rpc,
      node2Gossip,
      udp2 as any,
      { ...commonOptions, seedNodes: [node1Gossip] },
    );

    await proto1.start();
    await proto2.start();

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(100);
      await vi.runAllTicks();
    }

    const peerInNode1 = proto1.getLivePeers().find((p) => p.id === node2Id);
    expect(peerInNode1).toBeDefined();
    const initialGeneration = peerInNode1!.generation;

    await proto2.stop();
    proto2 = null;

    vi.advanceTimersByTime(
      commonOptions.failureTimeoutMs + commonOptions.cleanupIntervalMs,
    );
    await vi.runAllTicks();

    expect(proto1.getLivePeers().map((p) => p.id)).not.toContain(node2Id);

    udp2 = new MockGossipUDP({ address: "127.0.0.1", port: 6002 });
    proto2 = new GossipProtocol(node2Id, node2Rpc, node2Gossip, udp2 as any, {
      ...commonOptions,
      seedNodes: [node1Gossip],
    });

    await proto2.start();

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(100);
      await vi.runAllTicks();
    }

    const newPeerInNode1 = proto1.getLivePeers().find((p) => p.id === node2Id);
    expect(newPeerInNode1).toBeDefined();
    expect(newPeerInNode1!.generation).toBeGreaterThan(initialGeneration);

    await proto1.stop();
    await proto2.stop();
  });

  it("should gracefully leave and notify peers", async () => {
    const commonOptions = {
      gossipIntervalMs: 100,
      cleanupIntervalMs: 200,
      failureTimeoutMs: 1000,
      gossipFanout: 2,
    };

    const udp1 = new MockGossipUDP({ address: "127.0.0.1", port: 6001 });
    const proto1 = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      udp1 as any,
      { ...commonOptions, seedNodes: [] },
    );

    const udp2 = new MockGossipUDP({ address: "127.0.0.1", port: 6002 });
    const proto2 = new GossipProtocol(
      node2Id,
      node2Rpc,
      node2Gossip,
      udp2 as any,
      { ...commonOptions, seedNodes: [node1Gossip] },
    );

    await proto1.start();
    await proto2.start();

    // Let them discover each other
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(100);
      await vi.runAllTicks();
    }

    expect(proto1.getLivePeers().map((p) => p.id)).toContain(node2Id);
    expect(proto2.getLivePeers().map((p) => p.id)).toContain(node1Id);

    // Track member_leave event on proto1
    const leavePromise = new Promise<PeerState>((resolve) => {
      proto1.once("member_leave", (peer: PeerState) => {
        resolve(peer);
      });
    });

    // Node2 gracefully leaves (use real timers for the leave broadcast intervals)
    vi.useRealTimers();
    await proto2.leave(2, 10); // 2 broadcasts, 10ms interval

    // Switch back to fake timers and process messages
    vi.useFakeTimers();
    await vi.runAllTicks();

    // Verify proto2 is marked as leaving
    expect(proto2.isLeaving()).toBe(true);

    // Verify proto1 received the leave notification
    const leftPeer = await leavePromise;
    expect(leftPeer.id).toBe(node2Id);
    expect(leftPeer.status).toBe("leaving");

    // Verify proto1 no longer sees proto2 in live peers
    expect(proto1.getLivePeers().map((p) => p.id)).not.toContain(node2Id);

    await proto1.stop();
  });
});
