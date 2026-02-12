import { describe, it, expect, beforeEach } from "vitest";
import type { GossipMessage } from "../src/gossip";
import type { AuthenticatedGossipMessage } from "../src/auth";
import { CookieAuthenticator, NullAuthenticator } from "../src/auth";

function makeGossipMessage(overrides?: Partial<GossipMessage>): GossipMessage {
  return {
    senderId: "node-1",
    peers: [
      {
        id: "node-1",
        address: "tcp://127.0.0.1:5000",
        heartbeat: 1,
        generation: 1,
        gossipAddress: "127.0.0.1:6000",
        lastUpdated: Date.now(),
        status: "alive",
      },
    ],
    ...overrides,
  };
}

describe("CookieAuthenticator", () => {
  let auth: CookieAuthenticator;

  beforeEach(() => {
    auth = new CookieAuthenticator("my-secret-cookie");
  });

  describe("gossip signing and verification", () => {
    it("signs gossip message and verifyGossip returns true", () => {
      const msg = makeGossipMessage();
      const signed = auth.signGossip(msg);

      expect(signed.nonce).toBeDefined();
      expect(signed.hmac).toBeDefined();
      expect(signed.senderId).toBe(msg.senderId);
      expect(signed.peers).toEqual(msg.peers);

      expect(auth.verifyGossip(signed)).toBe(true);
    });

    it("rejects gossip message signed with different cookie", () => {
      const auth2 = new CookieAuthenticator("different-cookie");
      const msg = makeGossipMessage();
      const signed = auth.signGossip(msg);

      expect(auth2.verifyGossip(signed)).toBe(false);
    });

    it("rejects tampered message (modified peers array)", () => {
      const msg = makeGossipMessage();
      const signed = auth.signGossip(msg);

      // Tamper with the peers array
      const tampered: AuthenticatedGossipMessage = {
        ...signed,
        peers: [
          {
            id: "evil-node",
            address: "tcp://evil:5000",
            heartbeat: 999,
            generation: 1,
            gossipAddress: "evil:6000",
            lastUpdated: Date.now(),
            status: "alive",
          },
        ],
      };

      expect(auth.verifyGossip(tampered)).toBe(false);
    });

    it("rejects replayed gossip message (same nonce twice)", () => {
      const msg = makeGossipMessage();
      const signed = auth.signGossip(msg);

      // First verify should succeed
      expect(auth.verifyGossip(signed)).toBe(true);

      // Second verify with same nonce should fail (replay)
      expect(auth.verifyGossip(signed)).toBe(false);
    });

    it("rejects message with missing nonce", () => {
      const msg = makeGossipMessage();
      const signed = auth.signGossip(msg);

      const noNonce = { ...signed } as AuthenticatedGossipMessage;
      delete (noNonce as any).nonce;

      expect(auth.verifyGossip(noNonce)).toBe(false);
    });

    it("rejects message with missing hmac", () => {
      const msg = makeGossipMessage();
      const signed = auth.signGossip(msg);

      const noHmac = { ...signed } as AuthenticatedGossipMessage;
      delete (noHmac as any).hmac;

      expect(auth.verifyGossip(noHmac)).toBe(false);
    });
  });

  describe("challenge-response", () => {
    it("createChallenge returns 32 random bytes", () => {
      const challenge = auth.createChallenge();

      expect(Buffer.isBuffer(challenge)).toBe(true);
      expect(challenge.length).toBe(32);
    });

    it("createChallenge returns unique values", () => {
      const c1 = auth.createChallenge();
      const c2 = auth.createChallenge();

      expect(c1.equals(c2)).toBe(false);
    });

    it("solveChallenge produces valid HMAC", () => {
      const challenge = auth.createChallenge();
      const response = auth.solveChallenge(challenge);

      expect(Buffer.isBuffer(response)).toBe(true);
      // SHA-256 HMAC produces 32 bytes
      expect(response.length).toBe(32);
    });

    it("verifyChallenge with correct response returns true", () => {
      const challenge = auth.createChallenge();
      const response = auth.solveChallenge(challenge);

      expect(auth.verifyChallenge(challenge, response)).toBe(true);
    });

    it("verifyChallenge with wrong response returns false", () => {
      const challenge = auth.createChallenge();
      const wrongResponse = Buffer.alloc(32, 0);

      expect(auth.verifyChallenge(challenge, wrongResponse)).toBe(false);
    });

    it("verifyChallenge with response from different cookie returns false", () => {
      const auth2 = new CookieAuthenticator("other-cookie");
      const challenge = auth.createChallenge();
      const response = auth2.solveChallenge(challenge);

      expect(auth.verifyChallenge(challenge, response)).toBe(false);
    });
  });

  describe("nonce cache", () => {
    it("evicts old entries after TTL", async () => {
      // Use a very short TTL for testing
      const shortTtlAuth = new CookieAuthenticator("cookie", {
        nonceTtlMs: 50,
      });

      const msg = makeGossipMessage();
      const signed = shortTtlAuth.signGossip(msg);

      // First verify succeeds
      expect(shortTtlAuth.verifyGossip(signed)).toBe(true);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // After TTL, same nonce should be accepted again (evicted from cache)
      expect(shortTtlAuth.verifyGossip(signed)).toBe(true);
    });

    it("respects max size by evicting oldest entries", () => {
      const smallCacheAuth = new CookieAuthenticator("cookie", {
        nonceCacheMaxSize: 3,
      });

      const messages: AuthenticatedGossipMessage[] = [];

      // Sign 4 messages (exceeds max size of 3)
      for (let i = 0; i < 4; i++) {
        const msg = makeGossipMessage({ senderId: `node-${i}` });
        const signed = smallCacheAuth.signGossip(msg);
        expect(smallCacheAuth.verifyGossip(signed)).toBe(true);
        messages.push(signed);
      }

      // The first nonce should have been evicted, so replaying it succeeds
      expect(smallCacheAuth.verifyGossip(messages[0])).toBe(true);

      // But the last one is still in cache, so replaying it fails
      expect(smallCacheAuth.verifyGossip(messages[3])).toBe(false);
    });
  });
});

describe("NullAuthenticator", () => {
  let auth: NullAuthenticator;

  beforeEach(() => {
    auth = new NullAuthenticator();
  });

  it("signGossip returns message unchanged (no nonce/hmac added)", () => {
    const msg = makeGossipMessage();
    const result = auth.signGossip(msg);

    expect(result).toEqual(msg);
    expect((result as any).nonce).toBeUndefined();
    expect((result as any).hmac).toBeUndefined();
  });

  it("verifyGossip always returns true", () => {
    const msg = makeGossipMessage() as AuthenticatedGossipMessage;
    expect(auth.verifyGossip(msg)).toBe(true);
  });

  it("verifyGossip returns true even for messages with auth fields", () => {
    const msg = {
      ...makeGossipMessage(),
      nonce: "fake-nonce",
      hmac: "fake-hmac",
    } as AuthenticatedGossipMessage;

    expect(auth.verifyGossip(msg)).toBe(true);
  });

  it("createChallenge returns a Buffer", () => {
    const challenge = auth.createChallenge();
    expect(Buffer.isBuffer(challenge)).toBe(true);
  });

  it("solveChallenge returns a Buffer", () => {
    const challenge = Buffer.from("test");
    const response = auth.solveChallenge(challenge);
    expect(Buffer.isBuffer(response)).toBe(true);
  });

  it("verifyChallenge always returns true", () => {
    const challenge = Buffer.from("test");
    const response = Buffer.from("anything");
    expect(auth.verifyChallenge(challenge, response)).toBe(true);
  });
});
