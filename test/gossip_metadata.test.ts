import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DistributedCluster,
  GossipMessage,
  GossipProtocol,
  GossipUDP,
} from "../src";

const networkBus = new EventEmitter();

class MockGossipUDP extends GossipUDP {
  private readonly addressKey: string;

  constructor(config: { address: string; port: number }) {
    super(config);
    this.addressKey = `${config.address}:${config.port}`;
  }

  async start(): Promise<void> {
    networkBus.on(
      this.addressKey,
      (message: GossipMessage, rinfo: { address: string; port: number }) => {
        this.emit("message", message, rinfo);
      },
    );
  }

  async stop(): Promise<void> {
    networkBus.removeAllListeners(this.addressKey);
  }

  async send(
    message: GossipMessage,
    targetAddress: string,
    targetPort: number,
  ): Promise<void> {
    const target = `${targetAddress}:${targetPort}`;
    const [address, portString] = this.addressKey.split(":");
    const rinfo = { address, port: Number.parseInt(portString, 10) };
    setTimeout(() => {
      networkBus.emit(target, message, rinfo);
    }, 0);
  }
}

async function runGossipTick(intervalMs: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(intervalMs);
}

describe("Gossip metadata", () => {
  const node1Id = "node1";
  const node2Id = "node2";
  const node1Rpc = "tcp://127.0.0.1:5101";
  const node2Rpc = "tcp://127.0.0.1:5102";
  const node1Gossip = "127.0.0.1:6101";
  const node2Gossip = "127.0.0.1:6102";
  const gossipInterval = 100;

  beforeEach(() => {
    vi.useFakeTimers();
    networkBus.removeAllListeners();
  });

  afterEach(() => {
    vi.useRealTimers();
    networkBus.removeAllListeners();
  });

  it("setMetadata() stores key-value pair", () => {
    const proto = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      new MockGossipUDP({ address: "127.0.0.1", port: 6101 }),
      {
        gossipIntervalMs: gossipInterval,
        cleanupIntervalMs: 200,
        failureTimeoutMs: 1000,
        gossipFanout: 1,
        seedNodes: [],
      },
    );

    proto.setMetadata("role", "api");

    expect(proto.getMetadata("role")).toBe("api");
  });

  it("getMetadata() retrieves stored value", () => {
    const proto = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      new MockGossipUDP({ address: "127.0.0.1", port: 6101 }),
      {
        gossipIntervalMs: gossipInterval,
        cleanupIntervalMs: 200,
        failureTimeoutMs: 1000,
        gossipFanout: 1,
        seedNodes: [],
      },
    );

    proto.setMetadata("zone", "us-east-1");

    expect(proto.getMetadata("zone")).toBe("us-east-1");
  });

  it("getMetadata() returns undefined for non-existent key", () => {
    const proto = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      new MockGossipUDP({ address: "127.0.0.1", port: 6101 }),
      {
        gossipIntervalMs: gossipInterval,
        cleanupIntervalMs: 200,
        failureTimeoutMs: 1000,
        gossipFanout: 1,
        seedNodes: [],
      },
    );

    expect(proto.getMetadata("missing")).toBeUndefined();
  });

  it("metadata propagates to peers via gossip", async () => {
    const proto1 = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      new MockGossipUDP({ address: "127.0.0.1", port: 6101 }),
      {
        gossipIntervalMs: gossipInterval,
        cleanupIntervalMs: 200,
        failureTimeoutMs: 1000,
        gossipFanout: 1,
        seedNodes: [],
      },
    );
    const proto2 = new GossipProtocol(
      node2Id,
      node2Rpc,
      node2Gossip,
      new MockGossipUDP({ address: "127.0.0.1", port: 6102 }),
      {
        gossipIntervalMs: gossipInterval,
        cleanupIntervalMs: 200,
        failureTimeoutMs: 1000,
        gossipFanout: 1,
        seedNodes: [node1Gossip],
      },
    );

    await proto1.start();
    await proto2.start();

    proto1.setMetadata("region", "eu-west");

    await runGossipTick(gossipInterval);
    await runGossipTick(gossipInterval);
    await runGossipTick(gossipInterval);

    expect(proto2.getPeerMetadata(node1Id, "region")).toBe("eu-west");

    await proto1.stop();
    await proto2.stop();
  });

  it("getPeerMetadata() returns peer's metadata after gossip exchange", async () => {
    const proto1 = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      new MockGossipUDP({ address: "127.0.0.1", port: 6101 }),
      {
        gossipIntervalMs: gossipInterval,
        cleanupIntervalMs: 200,
        failureTimeoutMs: 1000,
        gossipFanout: 1,
        seedNodes: [],
      },
    );
    const proto2 = new GossipProtocol(
      node2Id,
      node2Rpc,
      node2Gossip,
      new MockGossipUDP({ address: "127.0.0.1", port: 6102 }),
      {
        gossipIntervalMs: gossipInterval,
        cleanupIntervalMs: 200,
        failureTimeoutMs: 1000,
        gossipFanout: 1,
        seedNodes: [node1Gossip],
      },
    );

    await proto1.start();
    await proto2.start();

    proto1.setMetadata("rack", "r1");

    await runGossipTick(gossipInterval);
    await runGossipTick(gossipInterval);
    await runGossipTick(gossipInterval);

    expect(proto2.getPeerMetadata(node1Id, "rack")).toBe("r1");

    await proto1.stop();
    await proto2.stop();
  });

  it("DistributedCluster.setMetadata() delegates to gossip protocol", () => {
    const proto = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      new MockGossipUDP({ address: "127.0.0.1", port: 6101 }),
      {
        gossipIntervalMs: gossipInterval,
        cleanupIntervalMs: 200,
        failureTimeoutMs: 1000,
        gossipFanout: 1,
        seedNodes: [],
      },
    );

    const cluster = new DistributedCluster(proto);
    cluster.setMetadata("service", "gateway");

    expect(proto.getMetadata("service")).toBe("gateway");
  });

  it("DistributedCluster.getMetadata() retrieves peer metadata", async () => {
    const proto1 = new GossipProtocol(
      node1Id,
      node1Rpc,
      node1Gossip,
      new MockGossipUDP({ address: "127.0.0.1", port: 6101 }),
      {
        gossipIntervalMs: gossipInterval,
        cleanupIntervalMs: 200,
        failureTimeoutMs: 1000,
        gossipFanout: 1,
        seedNodes: [],
      },
    );
    const proto2 = new GossipProtocol(
      node2Id,
      node2Rpc,
      node2Gossip,
      new MockGossipUDP({ address: "127.0.0.1", port: 6102 }),
      {
        gossipIntervalMs: gossipInterval,
        cleanupIntervalMs: 200,
        failureTimeoutMs: 1000,
        gossipFanout: 1,
        seedNodes: [node1Gossip],
      },
    );

    const cluster1 = new DistributedCluster(proto1);
    const cluster2 = new DistributedCluster(proto2);

    await cluster1.start();
    await cluster2.start();

    cluster1.setMetadata("version", "1.2.3");

    await runGossipTick(gossipInterval);
    await runGossipTick(gossipInterval);
    await runGossipTick(gossipInterval);

    expect(cluster2.getMetadata(node1Id, "version")).toBe("1.2.3");

    await cluster1.stop();
    await cluster2.stop();
  });
});
