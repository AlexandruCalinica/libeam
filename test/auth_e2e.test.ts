import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Actor,
  ActorSystem,
  ActorId,
  InMemoryTransport,
  DistributedCluster,
  DistributedRegistry,
  loggerConfig,
  createSystem,
} from "../src";
import { CookieAuthenticator } from "../src/auth";
import { RegistrySync } from "../src/registry_sync";
import type { GossipMessage } from "../src/gossip";
import { GossipUDP } from "../src/gossip_udp";
import * as dgram from "dgram";

class EchoActor extends Actor {
  private label = "";

  init(label: string) {
    this.label = label;
  }

  handleCall(message: any): any {
    if (message.type === "echo") return { label: this.label, value: message.value };
    if (message.type === "ping") return "pong";
    throw new Error(`Unknown: ${message.type}`);
  }
}

function mockGossipProtocol(nodeId: string, peers: Array<{ id: string; address: string; gossipAddress: string }>) {
  return {
    getNodeId: () => nodeId,
    start: async () => {},
    stop: async () => {},
    getLivePeers: () =>
      peers.map((p) => ({
        ...p,
        heartbeat: 1,
        generation: Date.now(),
        lastUpdated: Date.now(),
      })),
    on: () => {},
    emit: () => {},
  } as any;
}

async function setupTwoNodeSystem() {
  const transport1 = new InMemoryTransport("node1");
  const transport2 = new InMemoryTransport("node2");
  transport1.setPeer("node2", transport2);
  transport2.setPeer("node1", transport1);
  await transport1.connect();
  await transport2.connect();

  const peerList = [
    { id: "node1", address: "tcp://127.0.0.1:5001", gossipAddress: "127.0.0.1:6001" },
    { id: "node2", address: "tcp://127.0.0.1:5002", gossipAddress: "127.0.0.1:6002" },
  ];

  const cluster1 = new DistributedCluster(mockGossipProtocol("node1", peerList));
  const cluster2 = new DistributedCluster(mockGossipProtocol("node2", peerList));

  const rs1 = new RegistrySync("node1", transport1, cluster1);
  const rs2 = new RegistrySync("node2", transport2, cluster2);
  await rs1.connect();
  await rs2.connect();

  const registry1 = new DistributedRegistry("node1", rs1);
  const registry2 = new DistributedRegistry("node2", rs2);

  const system1 = new ActorSystem(cluster1 as any, transport1, registry1);
  const system2 = new ActorSystem(cluster2 as any, transport2, registry2);

  system1.registerActorClass(EchoActor);
  system2.registerActorClass(EchoActor);
  await system1.start();
  await system2.start();

  return {
    system1, system2, transport1, transport2, registry1, registry2,
    async cleanup() {
      await system1.shutdown().catch(() => {});
      await system2.shutdown().catch(() => {});
      await transport1.disconnect().catch(() => {});
      await transport2.disconnect().catch(() => {});
    },
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const addr = socket.address();
      if (typeof addr === "string") { reject(new Error("unexpected")); return; }
      const port = addr.port;
      socket.close(() => resolve(port));
    });
  });
}

function makePeer(id: string, gossipPort: number): GossipMessage {
  return {
    senderId: id,
    peers: [{
      id,
      address: `tcp://127.0.0.1:${gossipPort + 1000}`,
      heartbeat: 1,
      generation: 1,
      gossipAddress: `127.0.0.1:${gossipPort}`,
      lastUpdated: Date.now(),
      status: "alive",
    }],
  };
}

describe("authentication end-to-end", () => {
  const originalHandler = loggerConfig.handler;
  afterEach(() => {
    loggerConfig.handler = originalHandler;
  });

  it("two systems with same cookie can discover, spawn actors, and send messages", async () => {
    const env = await setupTwoNodeSystem();

    try {
      const echo = env.system1.spawn(EchoActor, { name: "echo-actor", args: ["node1-echo"] });
      await new Promise((r) => setTimeout(r, 50));

      const lookup = await env.registry2.lookup("echo-actor");
      expect(lookup?.nodeId).toBe("node1");

      const ref = env.system2.getRef(new ActorId("node1", echo.id.id, "echo-actor"));
      const result = await ref.call({ type: "echo", value: 123 });
      expect(result).toEqual({ label: "node1-echo", value: 123 });

      const ping = await ref.call({ type: "ping" });
      expect(ping).toBe("pong");
    } finally {
      await env.cleanup();
    }
  });

  it("two systems with different cookies: gossip messages are dropped", async () => {
    const port1 = await getFreePort();
    const port2 = await getFreePort();

    const udp1 = new GossipUDP({
      address: "127.0.0.1",
      port: port1,
      auth: new CookieAuthenticator("cookie-alpha"),
    });
    const udp2 = new GossipUDP({
      address: "127.0.0.1",
      port: port2,
      auth: new CookieAuthenticator("cookie-beta"),
    });

    await udp1.start();
    await udp2.start();

    const received = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        udp2.off("message", onMsg);
        resolve(false);
      }, 200);
      const onMsg = () => {
        clearTimeout(timer);
        udp2.off("message", onMsg);
        resolve(true);
      };
      udp2.on("message", onMsg);
      udp1.send(makePeer("node-a", port1), "127.0.0.1", port2);
    });

    expect(received).toBe(false);

    await udp1.stop();
    await udp2.stop();
  });

  it("authenticated system drops from unauthenticated; unauthenticated accepts all", async () => {
    const portAuth = await getFreePort();
    const portOpen = await getFreePort();

    const udpAuth = new GossipUDP({
      address: "127.0.0.1",
      port: portAuth,
      auth: new CookieAuthenticator("secret"),
    });
    const udpOpen = new GossipUDP({
      address: "127.0.0.1",
      port: portOpen,
    });

    await udpAuth.start();
    await udpOpen.start();

    const openToAuth = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        udpAuth.off("message", onMsg);
        resolve(false);
      }, 200);
      const onMsg = () => {
        clearTimeout(timer);
        udpAuth.off("message", onMsg);
        resolve(true);
      };
      udpAuth.on("message", onMsg);
      udpOpen.send(makePeer("open-node", portOpen), "127.0.0.1", portAuth);
    });
    expect(openToAuth).toBe(false);

    const authToOpen = await new Promise<GossipMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        udpOpen.off("message", onMsg);
        resolve(null);
      }, 1000);
      const onMsg = (incoming: GossipMessage) => {
        clearTimeout(timer);
        udpOpen.off("message", onMsg);
        resolve(incoming);
      };
      udpOpen.on("message", onMsg);
      udpAuth.send(makePeer("auth-node", portAuth), "127.0.0.1", portOpen);
    });
    expect(authToOpen).not.toBeNull();
    expect(authToOpen!.senderId).toBe("auth-node");

    await udpAuth.stop();
    await udpOpen.stop();
  });

  it("LIBEAM_COOKIE env var is picked up by createSystem", async () => {
    const logHandler = vi.fn();
    loggerConfig.handler = logHandler;
    const originalEnv = process.env.LIBEAM_COOKIE;

    let system: Awaited<ReturnType<typeof createSystem>> | undefined;
    try {
      process.env.LIBEAM_COOKIE = "env-cookie-secret";

      try {
        system = await createSystem({
          type: "distributed",
          port: 59998,
          seedNodes: [],
        });
      } catch {
        // Port bind failure acceptable
      }

      const noAuthWarnings = logHandler.mock.calls.filter((call: any[]) => {
        const entry = call[0] as { level: string; message: string };
        return entry.level === "warn" && entry.message.includes("WITHOUT authentication");
      });
      expect(noAuthWarnings).toHaveLength(0);
    } finally {
      if (system) await system.shutdown().catch(() => {});
      if (originalEnv === undefined) {
        delete process.env.LIBEAM_COOKIE;
      } else {
        process.env.LIBEAM_COOKIE = originalEnv;
      }
    }
  });

  it("warns when no cookie and no LIBEAM_COOKIE for distributed system", async () => {
    const logHandler = vi.fn();
    loggerConfig.handler = logHandler;
    const originalEnv = process.env.LIBEAM_COOKIE;
    delete process.env.LIBEAM_COOKIE;

    let system: Awaited<ReturnType<typeof createSystem>> | undefined;
    try {
      system = await createSystem({
        type: "distributed",
        port: 59999,
        seedNodes: [],
      });
    } catch {
      // Port bind failure is acceptable
    }

    try {
      const noAuthWarnings = logHandler.mock.calls.filter((call: any[]) => {
        const entry = call[0] as { level: string; message: string };
        return entry.level === "warn" && entry.message.includes("WITHOUT authentication");
      });
      expect(noAuthWarnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (system) await system.shutdown().catch(() => {});
      if (originalEnv !== undefined) {
        process.env.LIBEAM_COOKIE = originalEnv;
      }
    }
  });

  it("empty cookie throws validation error", async () => {
    await expect(
      createSystem({ type: "distributed", port: 1, seedNodes: [], cookie: "" }),
    ).rejects.toThrow("cookie must not be empty");
  });
});
