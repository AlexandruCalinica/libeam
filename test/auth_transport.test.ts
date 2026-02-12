import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as net from "net";
import { CookieAuthenticator } from "../src/auth";
import { AuthenticationError, ZeroMQTransport } from "../src";

async function findAvailableTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", (err) => {
      server.close();
      reject(err);
    });
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function createTransport(nodeId: string, auth?: CookieAuthenticator, handshakeTimeoutMs?: number) {
  const rpcPort = await findAvailableTcpPort();
  const pubPort = await findAvailableTcpPort();
  return {
    rpcPort,
    transport: new ZeroMQTransport({
      nodeId,
      rpcPort,
      pubPort,
      bindAddress: "127.0.0.1",
      auth,
      handshakeTimeoutMs,
    }),
  };
}

describe("ZeroMQTransport authentication handshake", () => {
  let transport1: ZeroMQTransport;
  let transport2: ZeroMQTransport;

  afterEach(async () => {
    if (transport1) {
      await transport1.disconnect();
    }
    if (transport2) {
      await transport2.disconnect();
    }
  });

  it("completes handshake with matching cookie and allows request/send", async () => {
    const shared = new CookieAuthenticator("shared-cookie");
    const a = await createTransport("node-a", shared);
    const b = await createTransport("node-b", new CookieAuthenticator("shared-cookie"));
    transport1 = a.transport;
    transport2 = b.transport;

    await transport1.connect();
    await transport2.connect();

    transport1.updatePeers([["node-b", `tcp://127.0.0.1:${b.rpcPort}`]]);
    transport2.updatePeers([["node-a", `tcp://127.0.0.1:${a.rpcPort}`]]);

    transport2.onRequest(async (msg) => ({ ok: true, echoed: msg }));

    const incoming = new Promise<any>((resolve) => {
      transport2.onMessage((msg) => resolve(msg));
    });

    const response = await transport1.request("node-b", { type: "ping" }, 2000);
    expect(response).toEqual({ ok: true, echoed: { type: "ping" } });

    await transport1.send("node-b", { type: "cast", value: 42 });
    await expect(incoming).resolves.toEqual({ type: "cast", value: 42 });
  });

  it("rejects requests when cookies do not match", async () => {
    const a = await createTransport("node-a", new CookieAuthenticator("cookie-a"));
    const b = await createTransport("node-b", new CookieAuthenticator("cookie-b"));
    transport1 = a.transport;
    transport2 = b.transport;

    await transport1.connect();
    await transport2.connect();

    transport1.updatePeers([["node-b", `tcp://127.0.0.1:${b.rpcPort}`]]);
    transport2.updatePeers([["node-a", `tcp://127.0.0.1:${a.rpcPort}`]]);

    transport2.onRequest(async () => ({ ok: true }));

    await expect(transport1.request("node-b", { type: "ping" }, 1200)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("works without authenticator (backward compatible)", async () => {
    const a = await createTransport("node-a");
    const b = await createTransport("node-b");
    transport1 = a.transport;
    transport2 = b.transport;

    await transport1.connect();
    await transport2.connect();

    transport1.updatePeers([["node-b", `tcp://127.0.0.1:${b.rpcPort}`]]);
    transport2.updatePeers([["node-a", `tcp://127.0.0.1:${a.rpcPort}`]]);

    transport2.onRequest(async (msg) => ({ ok: true, echoed: msg }));
    await expect(transport1.request("node-b", { type: "ping" }, 2000)).resolves.toEqual({
      ok: true,
      echoed: { type: "ping" },
    });
  });

});
