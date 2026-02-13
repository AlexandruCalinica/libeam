import { describe, it, expect, beforeEach } from "vitest";
import type { GossipMessage } from "../src/gossip";
import type { AuthenticatedGossipMessage } from "../src/auth";
import {
  CookieAuthenticator,
  NullAuthenticator,
  deriveKeys,
  z85Encode,
  z85Decode,
} from "../src/auth";

const VALID_COOKIE = "my-secret-cookie-long-enough";

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
    auth = new CookieAuthenticator(VALID_COOKIE);
  });

  describe("construction", () => {
    it("throws if cookie is shorter than 16 characters", () => {
      expect(() => new CookieAuthenticator("short")).toThrow(
        "at least 16 characters",
      );
    });

    it("accepts cookies of exactly 16 characters", () => {
      expect(
        () => new CookieAuthenticator("exactly16charss!"),
      ).not.toThrow();
    });

    it("exposes curveKeyPair with Z85-encoded keys", () => {
      expect(auth.curveKeyPair.publicKey).toHaveLength(40);
      expect(auth.curveKeyPair.secretKey).toHaveLength(40);
    });
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
      const auth2 = new CookieAuthenticator("different-cookie-value!");
      const msg = makeGossipMessage();
      const signed = auth.signGossip(msg);

      expect(auth2.verifyGossip(signed)).toBe(false);
    });

    it("rejects tampered message (modified peers array)", () => {
      const msg = makeGossipMessage();
      const signed = auth.signGossip(msg);

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

      expect(auth.verifyGossip(signed)).toBe(true);
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

  describe("nonce cache", () => {
    it("evicts old entries after TTL", async () => {
      const shortTtlAuth = new CookieAuthenticator(VALID_COOKIE, {
        nonceTtlMs: 50,
      });

      const msg = makeGossipMessage();
      const signed = shortTtlAuth.signGossip(msg);

      expect(shortTtlAuth.verifyGossip(signed)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(shortTtlAuth.verifyGossip(signed)).toBe(true);
    });

    it("respects max size by evicting oldest entries", () => {
      const smallCacheAuth = new CookieAuthenticator(VALID_COOKIE, {
        nonceCacheMaxSize: 3,
      });

      const messages: AuthenticatedGossipMessage[] = [];

      for (let i = 0; i < 4; i++) {
        const msg = makeGossipMessage({ senderId: `node-${i}` });
        const signed = smallCacheAuth.signGossip(msg);
        expect(smallCacheAuth.verifyGossip(signed)).toBe(true);
        messages.push(signed);
      }

      expect(smallCacheAuth.verifyGossip(messages[0])).toBe(true);
      expect(smallCacheAuth.verifyGossip(messages[3])).toBe(false);
    });
  });
});

describe("deriveKeys", () => {
  it("produces deterministic output for same cookie + salt", () => {
    const a = deriveKeys("test-cookie-at-least-16", "salt1");
    const b = deriveKeys("test-cookie-at-least-16", "salt1");

    expect(a.hmacKey.equals(b.hmacKey)).toBe(true);
    expect(a.curveKeyPair.publicKey).toBe(b.curveKeyPair.publicKey);
    expect(a.curveKeyPair.secretKey).toBe(b.curveKeyPair.secretKey);
  });

  it("different cookies produce different keys", () => {
    const a = deriveKeys("cookie-alpha-sixteen", "salt");
    const b = deriveKeys("cookie-bravo-sixteen", "salt");

    expect(a.hmacKey.equals(b.hmacKey)).toBe(false);
    expect(a.curveKeyPair.publicKey).not.toBe(b.curveKeyPair.publicKey);
  });

  it("different salts produce different keys", () => {
    const a = deriveKeys("same-cookie-for-both!", "salt-a");
    const b = deriveKeys("same-cookie-for-both!", "salt-b");

    expect(a.hmacKey.equals(b.hmacKey)).toBe(false);
    expect(a.curveKeyPair.publicKey).not.toBe(b.curveKeyPair.publicKey);
  });

  it("HMAC key differs from Curve secret key (domain separation)", () => {
    const { hmacKey, curveKeyPair } = deriveKeys("domain-sep-cookie!!", "salt");
    const curveSecretRaw = z85Decode(curveKeyPair.secretKey);

    expect(hmacKey.equals(curveSecretRaw)).toBe(false);
  });

  it("produces Z85-encoded keys of correct length", () => {
    const { curveKeyPair } = deriveKeys("z85-length-test-cookie", "salt");

    expect(curveKeyPair.publicKey).toHaveLength(40);
    expect(curveKeyPair.secretKey).toHaveLength(40);
  });

  it("uses default salt when none provided", () => {
    const a = deriveKeys("default-salt-test-cookie");
    const b = deriveKeys("default-salt-test-cookie", "libeam-v2");

    expect(a.hmacKey.equals(b.hmacKey)).toBe(true);
    expect(a.curveKeyPair.publicKey).toBe(b.curveKeyPair.publicKey);
  });
});

describe("Z85 encoding", () => {
  it("round-trips 32 bytes correctly", () => {
    const input = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) input[i] = i * 7;

    const encoded = z85Encode(input);
    expect(encoded).toHaveLength(40);

    const decoded = z85Decode(encoded);
    expect(decoded.equals(input)).toBe(true);
  });

  it("throws for data length not multiple of 4", () => {
    expect(() => z85Encode(Buffer.alloc(3))).toThrow("multiple of 4");
  });

  it("throws for string length not multiple of 5", () => {
    expect(() => z85Decode("abc")).toThrow("multiple of 5");
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
});
