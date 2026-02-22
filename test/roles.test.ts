import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import * as dgram from "dgram";
import {
  Actor,
  ActorSystem,
  Cluster,
  createSystem,
  DistributedCluster,
  GossipProtocol,
  GossipUDP,
  InMemoryTransport,
  LocalCluster,
  LocalRegistry,
  NoRoleMatchError,
  PlacementEngine,
} from "../src";
import type { PeerState, System } from "../src";

class PlacementTestActor extends Actor {}

class MockGossipProtocol extends EventEmitter {
  private readonly _nodeId: string;
  private readonly peers: Map<string, PeerState> = new Map();
  private _isLeaving = false;

  constructor(nodeId: string, roles?: string[]) {
    super();
    this._nodeId = nodeId;
    this.peers.set(nodeId, {
      id: nodeId,
      address: "tcp://127.0.0.1:5000",
      heartbeat: 0,
      generation: 1,
      gossipAddress: "127.0.0.1:5002",
      lastUpdated: Date.now(),
      status: "alive",
      roles: roles?.length ? roles : undefined,
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

  addPeer(nodeId: string, roles?: string[]): void {
    const peer: PeerState = {
      id: nodeId,
      address: `tcp://127.0.0.1:${5000 + this.peers.size * 10}`,
      heartbeat: 0,
      generation: 1,
      gossipAddress: `127.0.0.1:${5002 + this.peers.size * 10}`,
      lastUpdated: Date.now(),
      status: "alive",
      roles: roles?.length ? roles : undefined,
    };
    this.peers.set(nodeId, peer);
    this.emit("member_join", peer);
  }
}

function createMockDistributedCluster(nodeId: string, roles?: string[]) {
  const gossip = new MockGossipProtocol(nodeId, roles);
  const cluster = new DistributedCluster(gossip as unknown as GossipProtocol);
  return { cluster, gossip };
}

class RoleAwareMockCluster implements Cluster {
  private members: string[] = [];
  private readonly memberRoles = new Map<string, string[]>();

  constructor(public readonly nodeId: string, roles?: string[]) {
    this.members = [nodeId];
    if (roles?.length) {
      this.memberRoles.set(nodeId, roles);
    }
  }

  addMember(nodeId: string, roles?: string[]): void {
    if (!this.members.includes(nodeId)) {
      this.members.push(nodeId);
    }
    if (roles) {
      this.memberRoles.set(nodeId, roles);
    }
  }

  getMembers(): string[] {
    return [...this.members];
  }

  getMembersByRole(role: string): string[] {
    return this.members.filter((nodeId) =>
      (this.memberRoles.get(nodeId) ?? []).includes(role),
    );
  }
}

async function getFreeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      if (typeof address === "string") {
        reject(new Error("unexpected udp address"));
        return;
      }
      const port = address.port;
      socket.close(() => resolve(port));
    });
  });
}

describe("PeerState roles propagation (via MockGossipProtocol)", () => {
  it("PeerState includes roles when set", () => {
    const { cluster } = createMockDistributedCluster("node1", ["gateway", "worker"]);

    const self = cluster.getLivePeers().find((p) => p.id === "node1");
    expect(self?.roles).toEqual(["gateway", "worker"]);
  });

  it("PeerState roles propagate to DistributedCluster.getMembersByRole()", () => {
    const { cluster, gossip } = createMockDistributedCluster("node1", ["gateway"]);
    gossip.addPeer("node2", ["worker"]);

    expect(cluster.getMembersByRole("worker")).toEqual(["node2"]);
    expect(cluster.getMembersByRole("gateway")).toEqual(["node1"]);
  });

  it("peers without roles do not match any role filter", () => {
    const { cluster, gossip } = createMockDistributedCluster("node1");
    gossip.addPeer("node2");

    expect(cluster.getMembersByRole("worker")).toEqual([]);
  });

  it("peers with multiple roles match each role individually", () => {
    const { cluster, gossip } = createMockDistributedCluster("node1");
    gossip.addPeer("node2", ["worker", "batch"]);

    expect(cluster.getMembersByRole("worker")).toContain("node2");
    expect(cluster.getMembersByRole("batch")).toContain("node2");
  });

  it("getMembersByRole returns empty array when no peers have the role", () => {
    const { cluster, gossip } = createMockDistributedCluster("node1", ["gateway"]);
    gossip.addPeer("node2", ["worker"]);

    expect(cluster.getMembersByRole("database")).toEqual([]);
  });
});

describe("PlacementEngine with roles", () => {
  it("round-robin with role filters to matching nodes only", () => {
    const cluster = new RoleAwareMockCluster("node1", ["gateway"]);
    cluster.addMember("node2", ["worker"]);
    cluster.addMember("node3", ["worker"]);

    const placement = new PlacementEngine(cluster);
    const picks = [
      placement.selectNode("round-robin", "worker"),
      placement.selectNode("round-robin", "worker"),
      placement.selectNode("round-robin", "worker"),
    ];

    expect(picks.every((id) => id === "node2" || id === "node3")).toBe(true);
    expect(picks).not.toContain("node1");
  });

  it("round-robin with role cycles through matching nodes with counter per role", () => {
    const cluster = new RoleAwareMockCluster("node1", ["gateway"]);
    cluster.addMember("node2", ["worker"]);
    cluster.addMember("node3", ["worker"]);
    cluster.addMember("node4", ["db"]);

    const placement = new PlacementEngine(cluster);

    expect(placement.selectNode("round-robin", "worker")).toBe("node2");
    expect(placement.selectNode("round-robin", "db")).toBe("node4");
    expect(placement.selectNode("round-robin", "worker")).toBe("node3");
  });

  it("round-robin without role uses all members", () => {
    const cluster = new RoleAwareMockCluster("node1", ["gateway"]);
    cluster.addMember("node2", ["worker"]);
    cluster.addMember("node3", ["worker"]);

    const placement = new PlacementEngine(cluster);

    expect(placement.selectNode("round-robin")).toBe("node1");
    expect(placement.selectNode("round-robin")).toBe("node2");
    expect(placement.selectNode("round-robin")).toBe("node3");
  });

  it("round-robin with role throws NoRoleMatchError when no nodes match", () => {
    const cluster = new RoleAwareMockCluster("node1", ["gateway"]);
    cluster.addMember("node2", ["worker"]);

    const placement = new PlacementEngine(cluster);

    expect(() => placement.selectNode("round-robin", "db")).toThrow(NoRoleMatchError);
  });

  it("local with role succeeds when local node has the role", () => {
    const cluster = new RoleAwareMockCluster("node1", ["gateway"]);
    cluster.addMember("node2", ["worker"]);

    const placement = new PlacementEngine(cluster);

    expect(placement.selectNode("local", "gateway")).toBe("node1");
  });

  it("local with role throws NoRoleMatchError when local node does not have the role", () => {
    const cluster = new RoleAwareMockCluster("node1", ["gateway"]);
    cluster.addMember("node2", ["worker"]);

    const placement = new PlacementEngine(cluster);

    expect(() => placement.selectNode("local", "worker")).toThrow(NoRoleMatchError);
  });

  it("local without role always returns local node", () => {
    const cluster = new RoleAwareMockCluster("node1", ["gateway"]);
    cluster.addMember("node2", ["worker"]);

    const placement = new PlacementEngine(cluster);

    expect(placement.selectNode("local")).toBe("node1");
  });
});

describe("LocalCluster.getMembersByRole", () => {
  it("returns local node for known role", () => {
    const cluster = new LocalCluster("local-node");

    expect(cluster.getMembersByRole("worker")).toEqual(["local-node"]);
  });

  it("returns local node for unknown role", () => {
    const cluster = new LocalCluster("local-node");

    expect(cluster.getMembersByRole("does-not-exist")).toEqual(["local-node"]);
  });
});

describe("Integration: ActorSystem.spawn with role", () => {
  let node1: ActorSystem;
  let node2: ActorSystem;
  let node3: ActorSystem;
  let transport1: InMemoryTransport;
  let transport2: InMemoryTransport;
  let transport3: InMemoryTransport;

  beforeEach(async () => {
    transport1 = new InMemoryTransport("node1");
    transport2 = new InMemoryTransport("node2");
    transport3 = new InMemoryTransport("node3");

    transport1.setPeer("node2", transport2);
    transport1.setPeer("node3", transport3);
    transport2.setPeer("node1", transport1);
    transport2.setPeer("node3", transport3);
    transport3.setPeer("node1", transport1);
    transport3.setPeer("node2", transport2);

    await transport1.connect();
    await transport2.connect();
    await transport3.connect();

    const cluster1 = new RoleAwareMockCluster("node1", ["gateway"]);
    cluster1.addMember("node2", ["worker"]);
    cluster1.addMember("node3", ["worker"]);

    const cluster2 = new RoleAwareMockCluster("node2", ["worker"]);
    cluster2.addMember("node1", ["gateway"]);
    cluster2.addMember("node3", ["worker"]);

    const cluster3 = new RoleAwareMockCluster("node3", ["worker"]);
    cluster3.addMember("node1", ["gateway"]);
    cluster3.addMember("node2", ["worker"]);

    node1 = new ActorSystem(cluster1, transport1, new LocalRegistry());
    node2 = new ActorSystem(cluster2, transport2, new LocalRegistry());
    node3 = new ActorSystem(cluster3, transport3, new LocalRegistry());

    node1.registerActorClass(PlacementTestActor);
    node2.registerActorClass(PlacementTestActor);
    node3.registerActorClass(PlacementTestActor);

    await node1.start();
    await node2.start();
    await node3.start();
  });

  afterEach(async () => {
    await node1.shutdown();
    await node2.shutdown();
    await node3.shutdown();
    await transport1.disconnect();
    await transport2.disconnect();
    await transport3.disconnect();
  });

  it("spawn with { strategy: 'round-robin', role: 'worker' } targets nodes with worker role", async () => {
    const ref1 = node1.spawn(PlacementTestActor, {
      strategy: "round-robin",
      role: "worker",
    });
    const ref2 = node1.spawn(PlacementTestActor, {
      strategy: "round-robin",
      role: "worker",
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(["node2", "node3"]).toContain(ref1.id.systemId);
    expect(["node2", "node3"]).toContain(ref2.id.systemId);
    expect(ref1.id.systemId).not.toBe(ref2.id.systemId);
  });

  it("spawn with role on local strategy succeeds when node has the role", () => {
    const ref = node1.spawn(PlacementTestActor, {
      strategy: "local",
      role: "gateway",
    });

    expect(ref.id.systemId).toBe("node1");
  });

  it("spawn with role throws when no matching nodes", () => {
    expect(() =>
      node1.spawn(PlacementTestActor, {
        strategy: "round-robin",
        role: "db",
      }),
    ).toThrow(NoRoleMatchError);
  });

  it("spawn with role on local strategy throws when local node lacks role", () => {
    expect(() =>
      node1.spawn(PlacementTestActor, {
        strategy: "local",
        role: "worker",
      }),
    ).toThrow(NoRoleMatchError);
  });
});

describe("Config: createSystem with roles", () => {
  let distributedSystem: System | undefined;

  afterEach(async () => {
    if (distributedSystem) {
      await distributedSystem.shutdown();
      distributedSystem = undefined;
    }
  });

  it("createSystem distributed without roles keeps self roles undefined", async () => {
    const rpcPort = await getFreeUdpPort();
    const pubPort = await getFreeUdpPort();
    const gossipPort = await getFreeUdpPort();

    distributedSystem = await createSystem({
      type: "distributed",
      ports: { rpc: rpcPort, pub: pubPort, gossip: gossipPort },
      seedNodes: [],
    });

    expect(distributedSystem.cluster).toBeInstanceOf(DistributedCluster);
    const cluster = distributedSystem.cluster as DistributedCluster;
    const self = cluster.getLivePeers().find((p) => p.id === distributedSystem!.nodeId);

    expect(self?.roles).toBeUndefined();
  });

  it("local system ignores roles entirely", async () => {
    const system = createSystem({ nodeId: "local-role-test" });

    const localRef = system.spawn(PlacementTestActor, {
      strategy: "local",
      role: "worker",
    });
    const rrRef = system.spawn(PlacementTestActor, {
      strategy: "round-robin",
      role: "worker",
    });

    expect(localRef.id.systemId).toBe("local-role-test");
    expect(rrRef.id.systemId).toBe("local-role-test");

    await system.shutdown();
  });
});

describe("GossipProtocol constructor", () => {
  const options = {
    gossipIntervalMs: 1000,
    cleanupIntervalMs: 2000,
    failureTimeoutMs: 5000,
    gossipFanout: 3,
    seedNodes: [],
  };

  it("GossipProtocol with roles sets them on self PeerState", () => {
    const udp = new GossipUDP({ address: "127.0.0.1", port: 0 });
    const protocol = new GossipProtocol(
      "node-role",
      "tcp://127.0.0.1:5000",
      "127.0.0.1:6000",
      udp,
      options,
      undefined,
      ["worker", "gateway"],
    );

    const self = protocol.getLivePeers().find((p) => p.id === "node-role");

    expect(self?.roles).toEqual(["worker", "gateway"]);
  });

  it("GossipProtocol without roles keeps roles undefined", () => {
    const udp = new GossipUDP({ address: "127.0.0.1", port: 0 });
    const protocol = new GossipProtocol(
      "node-no-role",
      "tcp://127.0.0.1:5001",
      "127.0.0.1:6001",
      udp,
      options,
    );

    const self = protocol.getLivePeers().find((p) => p.id === "node-no-role");

    expect(self?.roles).toBeUndefined();
  });
});
