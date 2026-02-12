import * as dgram from "dgram";
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GossipMessage, GossipProtocol, GossipUDP, loggerConfig } from "../src";
import { CookieAuthenticator } from "../src/auth";

function createPeer(id: string, gossipPort: number) {
  return {
    id,
    address: `tcp://127.0.0.1:${gossipPort + 1000}`,
    heartbeat: 1,
    generation: 1,
    gossipAddress: `127.0.0.1:${gossipPort}`,
    lastUpdated: Date.now(),
    status: "alive" as const,
  };
}

function createMessage(senderId: string, gossipPort: number): GossipMessage {
  return {
    senderId,
    peers: [createPeer(senderId, gossipPort)],
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      if (typeof address === "string") {
        socket.close(() => reject(new Error("Unexpected string address")));
        return;
      }
      const port = address.port;
      socket.close(() => resolve(port));
    });
  });
}

async function expectNoMessage(
  udp: GossipUDP,
  action: () => Promise<void>,
  timeoutMs = 120,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      udp.off("message", onMessage);
      resolve();
    }, timeoutMs);

    const onMessage = () => {
      clearTimeout(timer);
      udp.off("message", onMessage);
      reject(new Error("Expected no message, but received one"));
    };

    udp.on("message", onMessage);
    action().catch((err) => {
      clearTimeout(timer);
      udp.off("message", onMessage);
      reject(err);
    });
  });
}

describe("gossip authentication integration", () => {
  const originalHandler = loggerConfig.handler;

  beforeEach(() => {
    loggerConfig.handler = vi.fn();
  });

  afterEach(() => {
    loggerConfig.handler = originalHandler;
  });

  it("accepts gossip when sender and receiver share the same cookie", async () => {
    const senderPort = await getFreePort();
    const receiverPort = await getFreePort();

    const sender = new GossipUDP({
      address: "127.0.0.1",
      port: senderPort,
      auth: new CookieAuthenticator("shared-cookie"),
    });
    const receiver = new GossipUDP({
      address: "127.0.0.1",
      port: receiverPort,
      auth: new CookieAuthenticator("shared-cookie"),
    });

    await sender.start();
    await receiver.start();

    const message = createMessage("node-a", senderPort);

    const received = await new Promise<GossipMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for authenticated gossip")),
        1000,
      );
      receiver.once("message", (incoming: GossipMessage) => {
        clearTimeout(timer);
        resolve(incoming);
      });
      sender.send(message, "127.0.0.1", receiverPort).catch(reject);
    });

    expect(received).toEqual(message);

    await sender.stop();
    await receiver.stop();
  });

  it("drops gossip when sender and receiver use different cookies", async () => {
    const senderPort = await getFreePort();
    const receiverPort = await getFreePort();

    const sender = new GossipUDP({
      address: "127.0.0.1",
      port: senderPort,
      auth: new CookieAuthenticator("cookie-a"),
    });
    const receiver = new GossipUDP({
      address: "127.0.0.1",
      port: receiverPort,
      auth: new CookieAuthenticator("cookie-b"),
    });

    await sender.start();
    await receiver.start();

    await expectNoMessage(receiver, () =>
      sender.send(createMessage("node-a", senderPort), "127.0.0.1", receiverPort),
    );

    await sender.stop();
    await receiver.stop();
  });

  it("accepts authenticated gossip when receiver is in open mode", async () => {
    const senderPort = await getFreePort();
    const receiverPort = await getFreePort();

    const sender = new GossipUDP({
      address: "127.0.0.1",
      port: senderPort,
      auth: new CookieAuthenticator("cookie-a"),
    });
    const receiver = new GossipUDP({
      address: "127.0.0.1",
      port: receiverPort,
    });

    await sender.start();
    await receiver.start();

    const message = createMessage("node-a", senderPort);
    const received = await new Promise<GossipMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for open-mode gossip")),
        1000,
      );
      receiver.once("message", (incoming: GossipMessage) => {
        clearTimeout(timer);
        resolve(incoming);
      });
      sender.send(message, "127.0.0.1", receiverPort).catch(reject);
    });

    expect(received).toEqual(message);

    await sender.stop();
    await receiver.stop();
  });

  it("drops unauthenticated gossip when receiver requires authentication", async () => {
    const senderPort = await getFreePort();
    const receiverPort = await getFreePort();

    const sender = new GossipUDP({
      address: "127.0.0.1",
      port: senderPort,
    });
    const receiver = new GossipUDP({
      address: "127.0.0.1",
      port: receiverPort,
      auth: new CookieAuthenticator("cookie-a"),
    });

    await sender.start();
    await receiver.start();

    await expectNoMessage(receiver, () =>
      sender.send(createMessage("node-a", senderPort), "127.0.0.1", receiverPort),
    );

    await sender.stop();
    await receiver.stop();
  });

  it("drops tampered authenticated gossip messages", async () => {
    const receiverPort = await getFreePort();
    const tamperedSenderPort = await getFreePort();

    const auth = new CookieAuthenticator("shared-cookie");
    const receiver = new GossipUDP({
      address: "127.0.0.1",
      port: receiverPort,
      auth,
    });

    await receiver.start();

    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(tamperedSenderPort, "127.0.0.1", () => resolve());
    });

    const signed = auth.signGossip(createMessage("node-a", tamperedSenderPort));
    signed.peers[0].heartbeat = 999;

    await expectNoMessage(receiver, async () => {
      await new Promise<void>((resolve, reject) => {
        socket.send(
          Buffer.from(JSON.stringify(signed)),
          receiverPort,
          "127.0.0.1",
          (err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          },
        );
      });
    });

    socket.close();
    await receiver.stop();
  });
});

const networkBus = new EventEmitter();

class MockGossipUDP extends EventEmitter {
  private readonly address: string;

  constructor(config: { address: string; port: number }) {
    super();
    this.address = `${config.address}:${config.port}`;
  }

  async start(): Promise<void> {
    networkBus.on(this.address, (msg: GossipMessage, rinfo: dgram.RemoteInfo) => {
      this.emit("message", msg, rinfo);
    });
  }

  async stop(): Promise<void> {
    networkBus.removeAllListeners(this.address);
  }

  async send(
    message: GossipMessage,
    targetAddress: string,
    targetPort: number,
  ): Promise<void> {
    const target = `${targetAddress}:${targetPort}`;
    const rinfo = {
      address: this.address.split(":")[0],
      family: "IPv4",
      port: parseInt(this.address.split(":")[1], 10),
      size: 0,
    } as dgram.RemoteInfo;
    setTimeout(() => networkBus.emit(target, message, rinfo), 0);
  }
}

describe("gossip protocol open mode warning", () => {
  const originalHandler = loggerConfig.handler;

  beforeEach(() => {
    networkBus.removeAllListeners();
    loggerConfig.handler = vi.fn();
  });

  afterEach(() => {
    loggerConfig.handler = originalHandler;
  });

  it("logs unauthenticated warning only once on first received message", async () => {
    const udp = new MockGossipUDP({ address: "127.0.0.1", port: 7001 });
    const protocol = new GossipProtocol(
      "node-1",
      "tcp://127.0.0.1:5001",
      "127.0.0.1:7001",
      udp as unknown as GossipUDP,
      {
        gossipIntervalMs: 1000,
        cleanupIntervalMs: 1000,
        failureTimeoutMs: 5000,
        gossipFanout: 1,
        seedNodes: [],
      },
    );

    await protocol.start();

    const msg: GossipMessage = {
      senderId: "node-2",
      peers: [createPeer("node-2", 7002)],
    };
    const rinfo = {
      address: "127.0.0.1",
      family: "IPv4",
      port: 7002,
      size: 0,
    } as dgram.RemoteInfo;

    networkBus.emit("127.0.0.1:7001", msg, rinfo);
    networkBus.emit("127.0.0.1:7001", msg, rinfo);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const handler = loggerConfig.handler as ReturnType<typeof vi.fn>;
    const warningCalls = handler.mock.calls.filter((call) => {
      const entry = call[0] as { level: string; message: string };
      return (
        entry.level === "warn" &&
        entry.message ===
          "Received gossip message without authentication configured"
      );
    });

    expect(warningCalls).toHaveLength(1);

    await protocol.stop();
  });
});
