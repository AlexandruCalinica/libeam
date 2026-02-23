import { describe, it, expect, beforeEach } from "vitest";
import { KeyringAuthenticator } from "../src/auth";
import { GossipMessage, PeerState } from "../src/gossip";

const VALID_COOKIE = "my-secret-cookie-long-enough";
const NEW_COOKIE = "my-new-secret-cookie-long!!";

function makeGossipMessage(overrides?: Partial<GossipMessage>): GossipMessage {
  const defaultPeer: PeerState = {
    id: "test-node",
    address: "tcp://127.0.0.1:5000",
    heartbeat: 1,
    generation: 1,
    gossipAddress: "127.0.0.1:6000",
    lastUpdated: Date.now(),
    status: "alive",
  };

  return {
    senderId: "test-node",
    peers: [defaultPeer],
    ...overrides,
  };
}

describe("KeyringAuthenticator", () => {
  let keyring: KeyringAuthenticator;

  beforeEach(() => {
    keyring = new KeyringAuthenticator(VALID_COOKIE);
  });

  describe("construction", () => {
    it("should initialize with a primary cookie", () => {
      expect(keyring).toBeDefined();
      expect(keyring.curveKeyPair).toBeDefined();
    });

    it("should accept cookies >= 16 characters", () => {
      const shortCookie = "short";
      expect(() => new KeyringAuthenticator(shortCookie)).toThrow();
    });

    it("should generate consistent CurveKeyPair from same cookie", () => {
      const keyring1 = new KeyringAuthenticator(VALID_COOKIE);
      const keyring2 = new KeyringAuthenticator(VALID_COOKIE);
      expect(keyring1.curveKeyPair.publicKey).toBe(
        keyring2.curveKeyPair.publicKey
      );
      expect(keyring1.curveKeyPair.secretKey).toBe(
        keyring2.curveKeyPair.secretKey
      );
    });
  });

  describe("install()", () => {
    it("should add a new cookie to the keyring", () => {
      keyring.install(NEW_COOKIE);
      const fingerprints = keyring.list();
      expect(fingerprints.length).toBe(2);
    });

    it("should not change primary key after install", () => {
      const originalPair = keyring.curveKeyPair;
      keyring.install(NEW_COOKIE);
      expect(keyring.curveKeyPair.publicKey).toBe(originalPair.publicKey);
      expect(keyring.curveKeyPair.secretKey).toBe(originalPair.secretKey);
    });

    it("should reject installing when secondary already exists", () => {
      keyring.install(NEW_COOKIE);
      const cookie2 = "another-secret-cookie-long!!";
      expect(() => keyring.install(cookie2)).toThrow();
    });

    it("should reject cookies < 16 characters", () => {
      expect(() => keyring.install("short")).toThrow();
    });
  });

  describe("activate()", () => {
    it("should switch primary key to installed cookie", () => {
      keyring.install(NEW_COOKIE);
      const oldPair = keyring.curveKeyPair;
      keyring.activate();
      const newPair = keyring.curveKeyPair;
      expect(newPair.publicKey).not.toBe(oldPair.publicKey);
    });

    it("should keep old key in keyring after activate", () => {
      keyring.install(NEW_COOKIE);
      keyring.activate();
      const fingerprints = keyring.list();
      expect(fingerprints.length).toBe(2);
    });

    it("should throw if no cookie installed", () => {
      expect(() => keyring.activate()).toThrow();
    });

    it("should accept gossip signed with old key after activate", () => {
      keyring.install(NEW_COOKIE);
      const oldAuth = new KeyringAuthenticator(VALID_COOKIE);
      const msg = makeGossipMessage();
      const signed = oldAuth.signGossip(msg);
      keyring.activate();
      expect(keyring.verifyGossip(signed)).toBe(true);
    });
  });

  describe("remove()", () => {
    it("should remove the secondary key from keyring", () => {
      keyring.install(NEW_COOKIE);
      keyring.remove();
      const fingerprints = keyring.list();
      expect(fingerprints.length).toBe(1);
    });

    it("should be idempotent when no secondary exists", () => {
      keyring.remove();
      keyring.remove();
      const fingerprints = keyring.list();
      expect(fingerprints.length).toBe(1);
    });

    it("should remove secondary after activate", () => {
      keyring.install(NEW_COOKIE);
      keyring.activate();
      expect(keyring.list().length).toBe(2);
      keyring.remove();
      expect(keyring.list().length).toBe(1);
    });
  });

  describe("full lifecycle", () => {
    it("should support install -> activate -> remove workflow", () => {
      expect(keyring.list().length).toBe(1);
      keyring.install(NEW_COOKIE);
      expect(keyring.list().length).toBe(2);
      keyring.activate();
      expect(keyring.list().length).toBe(2);
      keyring.remove();
      expect(keyring.list().length).toBe(1);
    });
  });

  describe("list()", () => {
    it("should return fingerprints of all keys in keyring", () => {
      const fingerprints = keyring.list();
      expect(Array.isArray(fingerprints)).toBe(true);
      expect(fingerprints.length).toBeGreaterThan(0);
    });

    it("should return consistent fingerprints for same cookie", () => {
      const fp1 = keyring.list();
      const fp2 = keyring.list();
      expect(fp1).toEqual(fp2);
    });

    it("should include new fingerprint after install", () => {
      const before = keyring.list();
      keyring.install(NEW_COOKIE);
      const after = keyring.list();
      expect(after.length).toBe(before.length + 1);
    });

    it("should exclude removed fingerprint", () => {
      keyring.install(NEW_COOKIE);
      const before = keyring.list();
      keyring.remove();
      const after = keyring.list();
      expect(after.length).toBe(before.length - 1);
    });

    it("should return unique fingerprints", () => {
      keyring.install(NEW_COOKIE);
      const fingerprints = keyring.list();
      const unique = new Set(fingerprints);
      expect(unique.size).toBe(fingerprints.length);
    });
  });

  describe("curveKeyPair property", () => {
    it("should return current primary key pair", () => {
      const pair = keyring.curveKeyPair;
      expect(pair.publicKey).toBeDefined();
      expect(pair.secretKey).toBeDefined();
    });

    it("should update after activate", () => {
      const oldPair = keyring.curveKeyPair;
      keyring.install(NEW_COOKIE);
      keyring.activate();
      const newPair = keyring.curveKeyPair;
      expect(newPair.publicKey).not.toBe(oldPair.publicKey);
    });

    it("should be consistent across multiple accesses", () => {
      const pair1 = keyring.curveKeyPair;
      const pair2 = keyring.curveKeyPair;
      expect(pair1.publicKey).toBe(pair2.publicKey);
      expect(pair1.secretKey).toBe(pair2.secretKey);
    });
  });

  describe("nonce replay protection", () => {
    it("should reject duplicate nonce from same node", () => {
      const msg = makeGossipMessage();
      const signed1 = keyring.signGossip(msg);
      expect(keyring.verifyGossip(signed1)).toBe(true);
      expect(keyring.verifyGossip(signed1)).toBe(false);
    });

    it("should accept same nonce from different nodes", () => {
      const msg1 = makeGossipMessage({ senderId: "node1" });
      const msg2 = makeGossipMessage({ senderId: "node2" });
      const signed1 = keyring.signGossip(msg1);
      const signed2 = keyring.signGossip(msg2);
      expect(keyring.verifyGossip(signed1)).toBe(true);
      expect(keyring.verifyGossip(signed2)).toBe(true);
    });

    it("should accept increasing nonces from same node", () => {
      const msg1 = makeGossipMessage();
      const msg2 = makeGossipMessage();
      const signed1 = keyring.signGossip(msg1);
      const signed2 = keyring.signGossip(msg2);
      expect(keyring.verifyGossip(signed1)).toBe(true);
      expect(keyring.verifyGossip(signed2)).toBe(true);
    });
  });

  describe("Authenticator interface", () => {
    it("should implement signGossip method", () => {
      const msg = makeGossipMessage();
      const signed = keyring.signGossip(msg);
      expect(signed).toBeDefined();
      expect(signed.hmac).toBeDefined();
    });

    it("should implement verifyGossip method", () => {
      const msg = makeGossipMessage();
      const signed = keyring.signGossip(msg);
      const result = keyring.verifyGossip(signed);
      expect(typeof result).toBe("boolean");
    });

    it("should verify own signatures", () => {
      const msg = makeGossipMessage();
      const signed = keyring.signGossip(msg);
      expect(keyring.verifyGossip(signed)).toBe(true);
    });

    it("should reject signatures from different authenticator", () => {
      const other = new KeyringAuthenticator(NEW_COOKIE);
      const msg = makeGossipMessage();
      const signed = other.signGossip(msg);
      expect(keyring.verifyGossip(signed)).toBe(false);
    });
  });

  describe("salt configuration", () => {
    it("should accept custom salt in constructor", () => {
      const customSalt = "custom-salt-value";
      const kr = new KeyringAuthenticator(VALID_COOKIE, { salt: customSalt });
      expect(kr).toBeDefined();
      expect(kr.curveKeyPair).toBeDefined();
    });

    it("should generate different keys with different salts", () => {
      const kr1 = new KeyringAuthenticator(VALID_COOKIE, { salt: "salt1" });
      const kr2 = new KeyringAuthenticator(VALID_COOKIE, { salt: "salt2" });
      expect(kr1.curveKeyPair.publicKey).not.toBe(kr2.curveKeyPair.publicKey);
    });
  });

  describe("dual-key verification", () => {
    it("should verify gossip signed with primary key", () => {
      const msg = makeGossipMessage();
      const signed = keyring.signGossip(msg);
      expect(keyring.verifyGossip(signed)).toBe(true);
    });

    it("should verify gossip signed with secondary key after install", () => {
      keyring.install(NEW_COOKIE);
      const newAuth = new KeyringAuthenticator(NEW_COOKIE);
      const msg = makeGossipMessage();
      const signed = newAuth.signGossip(msg);
      expect(keyring.verifyGossip(signed)).toBe(true);
    });

    it("should verify gossip from old key after rotation", () => {
      const oldAuth = new KeyringAuthenticator(VALID_COOKIE);
      keyring.install(NEW_COOKIE);
      keyring.activate();
      const msg = makeGossipMessage();
      const signed = oldAuth.signGossip(msg);
      expect(keyring.verifyGossip(signed)).toBe(true);
    });

    it("should reject gossip from removed key", () => {
      const oldAuth = new KeyringAuthenticator(VALID_COOKIE);
      keyring.install(NEW_COOKIE);
      keyring.activate();
      keyring.remove();
      const msg = makeGossipMessage();
      const signed = oldAuth.signGossip(msg);
      expect(keyring.verifyGossip(signed)).toBe(false);
    });

    it("should support multiple secondary keys via sequential rotation", () => {
      const cookie2 = "another-secret-cookie-long!!";
      const auth2 = new KeyringAuthenticator(cookie2);
      keyring.install(NEW_COOKIE);
      keyring.activate();
      keyring.remove();
      keyring.install(cookie2);
      const msg = makeGossipMessage();
      const signed = auth2.signGossip(msg);
      expect(keyring.verifyGossip(signed)).toBe(true);
    });

    it("should verify after complex rotation sequence", () => {
      const cookie2 = "another-secret-cookie-long!!";
      const auth1 = new KeyringAuthenticator(VALID_COOKIE);
      const auth2 = new KeyringAuthenticator(NEW_COOKIE);
      const auth3 = new KeyringAuthenticator(cookie2);
      keyring.install(NEW_COOKIE);
      keyring.activate();
      keyring.remove();
      keyring.install(cookie2);
      keyring.activate();
      const msg = makeGossipMessage();
      const signed3 = auth3.signGossip(msg);
      expect(keyring.verifyGossip(signed3)).toBe(true);
      const signed1 = auth1.signGossip(msg);
      expect(keyring.verifyGossip(signed1)).toBe(false);
      const signed2 = auth2.signGossip(msg);
      expect(keyring.verifyGossip(signed2)).toBe(true);
    });
  });
});
