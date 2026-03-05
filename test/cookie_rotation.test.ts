import { afterEach, describe, expect, it } from "vitest";
import {
  Actor,
  ActorId,
  createSystem,
  type System,
  TimeoutError,
  ZeroMQTransport,
  } from "../src";
import { KeyringAuthenticator } from "../src/auth";
import { allocatePorts } from "../src/testing/port_allocator";

const OLD_COOKIE = "my-secret-cookie-long-enough";
const NEW_COOKIE = "rotated-secret-cookie-new!";
const REQUEST_TIMEOUT_MS = 2000;

// Helper to get a dynamically allocated base port for createSystem.
// createSystem uses port (rpc), port+1 (pub), port+2 (gossip).
async function getDynamicBasePort(): Promise<number> {
  const [ports] = await allocatePorts(1);
  return ports.rpc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createZeroMqTransport(
  nodeId: string,
  keyringAuth: KeyringAuthenticator,
  rpcPort: number,
  pubPort: number,
) {
  return {
    rpcPort,
    transport: new ZeroMQTransport({
      nodeId,
      rpcPort,
      pubPort,
      bindAddress: "127.0.0.1",
      curveKeyPair: keyringAuth.curveKeyPair,
    }),
  };
}

class RotationProbeActor extends Actor {
  private seen = new Set<number>();
  private duplicateCount = 0;

  handleCall(message: any): any {
    if (message.type === "ping") {
      return { ok: true, value: message.value };
    }

    if (message.type === "track") {
      if (this.seen.has(message.id)) {
        this.duplicateCount += 1;
        return { duplicate: true };
      }
      this.seen.add(message.id);
      return { duplicate: false, accepted: message.id };
    }

    if (message.type === "stats") {
      return {
        uniqueCount: this.seen.size,
        duplicateCount: this.duplicateCount,
      };
    }

    throw new Error(`Unknown message type: ${String(message?.type)}`);
  }
}

describe("cookie rotation integration", () => {
  const transports: ZeroMQTransport[] = [];
  const systems: System[] = [];

  afterEach(async () => {
    while (transports.length > 0) {
      const transport = transports.pop();
      if (transport) {
        await transport.disconnect().catch(() => {});
      }
    }

    while (systems.length > 0) {
      const system = systems.pop();
      if (system) {
        await system.shutdown().catch(() => {});
      }
    }
  });

  describe("transport-level rotation", () => {
    it("rotates keys on two transports and preserves request communication", { retry: 2 }, async () => {
      const keyringA = new KeyringAuthenticator(OLD_COOKIE);
      const keyringB = new KeyringAuthenticator(OLD_COOKIE);

      // Allocate all ports upfront in a single call to avoid collisions
      const portSets = await allocatePorts(2);
      const a = createZeroMqTransport("node-a", keyringA, portSets[0].rpc, portSets[0].pub);
      const b = createZeroMqTransport("node-b", keyringB, portSets[1].rpc, portSets[1].pub);
      transports.push(a.transport, b.transport);

      await a.transport.connect();
      await b.transport.connect();

      a.transport.updatePeers([["node-b", `tcp://127.0.0.1:${b.rpcPort}`]]);
      b.transport.updatePeers([["node-a", `tcp://127.0.0.1:${a.rpcPort}`]]);

      b.transport.onRequest(async (msg) => ({ ok: true, echoed: msg }));

      await expect(
        a.transport.request("node-b", { phase: "before" }, REQUEST_TIMEOUT_MS),
      ).resolves.toEqual({
        ok: true,
        echoed: { phase: "before" },
      });

      keyringA.install(NEW_COOKIE);
      keyringB.install(NEW_COOKIE);

      await a.transport.rotateCurveKeys(keyringA.activate());
      await b.transport.rotateCurveKeys(keyringB.activate());

      await expect(
        a.transport.request("node-b", { phase: "after" }, REQUEST_TIMEOUT_MS),
      ).resolves.toEqual({
        ok: true,
        echoed: { phase: "after" },
      });

      keyringA.remove();
      keyringB.remove();
    });
  });

  describe("createSystem-level rotation", () => {
    it("supports single-node keyring lifecycle install -> use -> remove", async () => {
      const basePort = await getDynamicBasePort();
      const system = await createSystem({
        type: "distributed",
        port: basePort,
        seedNodes: [],
        cookie: OLD_COOKIE,
      });
      systems.push(system);

      expect(system.keyring).toBeDefined();
      expect(system.keyring!.list()).toHaveLength(1);

      system.keyring!.install(NEW_COOKIE);
      expect(system.keyring!.list()).toHaveLength(2);

      await system.keyring!.use();
      expect(system.keyring!.list()).toHaveLength(2);

      system.keyring!.remove();
      expect(system.keyring!.list()).toHaveLength(1);
    });

    it("rotates cookie on two distributed systems and keeps remote calls working", async () => {
      const [ports1, ports2] = await allocatePorts(2);
      const basePort1 = ports1.rpc;
      const basePort2 = ports2.rpc;

      const system1 = await createSystem({
        type: "distributed",
        port: basePort1,
        seedNodes: [],
        cookie: OLD_COOKIE,
      });
      systems.push(system1);

      const system2 = await createSystem({
        type: "distributed",
        port: basePort2,
        seedNodes: [`127.0.0.1:${basePort1 + 2}`],
        cookie: OLD_COOKIE,
      });
      systems.push(system2);

      await sleep(500);
      await Promise.all([
        system1.waitForCluster({ minMembers: 2, timeout: 10000 }),
        system2.waitForCluster({ minMembers: 2, timeout: 10000 }),
      ]);

      const localProbe = system1.spawn(RotationProbeActor, { name: "rotation-probe" });
      const remoteProbe = system2.system.getRef(
        new ActorId(system1.nodeId, localProbe.id.id, "rotation-probe"),
      );
      await expect(
        remoteProbe.call({ type: "ping", value: "before" }, REQUEST_TIMEOUT_MS),
      ).resolves.toEqual({ ok: true, value: "before" });

      system1.keyring!.install(NEW_COOKIE);
      system2.keyring!.install(NEW_COOKIE);

      await system1.keyring!.use();
      await system2.keyring!.use();

      system1.keyring!.remove();
      system2.keyring!.remove();

      await expect(
        remoteProbe.call({ type: "ping", value: "after" }, REQUEST_TIMEOUT_MS),
      ).resolves.toEqual({ ok: true, value: "after" });
    }, 15000);

    it("preserves at-most-once semantics before, during, and after rotation", async () => {
      const [ports1, ports2] = await allocatePorts(2);
      const basePort1 = ports1.rpc;
      const basePort2 = ports2.rpc;

      const system1 = await createSystem({
        type: "distributed",
        port: basePort1,
        seedNodes: [],
        cookie: OLD_COOKIE,
      });
      systems.push(system1);

      const system2 = await createSystem({
        type: "distributed",
        port: basePort2,
        seedNodes: [`127.0.0.1:${basePort1 + 2}`],
        cookie: OLD_COOKIE,
      });
      systems.push(system2);

      await sleep(500);
      await Promise.all([
        system1.waitForCluster({ minMembers: 2, timeout: 10000 }),
        system2.waitForCluster({ minMembers: 2, timeout: 10000 }),
      ]);

      const localProbe = system1.spawn(RotationProbeActor, {
        name: "rotation-at-most-once",
      });
      const remoteProbe = system2.system.getRef(
        new ActorId(system1.nodeId, localProbe.id.id, "rotation-at-most-once"),
      );

      for (const id of [1, 2, 3, 4, 5]) {
        const response = await remoteProbe.call({ type: "track", id }, REQUEST_TIMEOUT_MS);
        expect(response).toEqual({ duplicate: false, accepted: id });
      }

      system1.keyring!.install(NEW_COOKIE);
      system2.keyring!.install(NEW_COOKIE);

      const rotation = Promise.all([system1.keyring!.use(), system2.keyring!.use()]);

      const duringIds = Array.from({ length: 30 }, (_, i) => 100 + i);
      const duringResults = await Promise.allSettled(
        duringIds.map((id) => remoteProbe.call({ type: "track", id }, REQUEST_TIMEOUT_MS)),
      );

      await rotation;
      system1.keyring!.remove();
      system2.keyring!.remove();

      const successfulDuring = duringResults.filter(
        (result): result is PromiseFulfilledResult<any> => result.status === "fulfilled",
      );
      const failedDuring = duringResults.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );

      for (const result of successfulDuring) {
        expect(result.value.duplicate).toBe(false);
      }
      for (const result of failedDuring) {
        expect(
          result.reason instanceof TimeoutError || result.reason instanceof Error,
        ).toBe(true);
      }

      for (const id of [1000, 1001, 1002, 1003, 1004]) {
        const response = await remoteProbe.call({ type: "track", id }, REQUEST_TIMEOUT_MS);
        expect(response).toEqual({ duplicate: false, accepted: id });
      }

      const stats = await remoteProbe.call({ type: "stats" }, REQUEST_TIMEOUT_MS);
      expect(stats.duplicateCount).toBe(0);
      expect(stats.uniqueCount).toBeLessThanOrEqual(5 + duringIds.length + 5);
      expect(stats.uniqueCount).toBeGreaterThanOrEqual(10);
    }, 15000);
  });

  describe("local system", () => {
    it("does not expose keyring on local systems", async () => {
      const localSystem = createSystem();
      systems.push(localSystem);
      expect(localSystem.keyring).toBeUndefined();
    });
  });
});
