import crypto from "crypto";
import type { GossipMessage } from "./gossip";

/**
 * A gossip message with authentication fields for HMAC verification
 * and replay protection. Fields are optional to maintain backward
 * compatibility with unauthenticated messages.
 */
export interface AuthenticatedGossipMessage extends GossipMessage {
  /** Hex-encoded random nonce for replay protection. */
  nonce?: string;
  /** Hex-encoded HMAC-SHA256 digest of the message contents + nonce. */
  hmac?: string;
}

/**
 * Pluggable authentication interface for securing gossip and transport
 * communication between cluster nodes. Implementations handle both
 * per-message HMAC signing (gossip) and challenge-response handshakes
 * (transport).
 */
export interface Authenticator {
  /** Adds `nonce` and `hmac` fields to a gossip message. */
  signGossip(message: GossipMessage): AuthenticatedGossipMessage;

  /** Verifies HMAC integrity and checks nonce has not been replayed. */
  verifyGossip(message: AuthenticatedGossipMessage): boolean;

  /** Generates a random challenge buffer for TCP handshake. */
  createChallenge(): Buffer;

  /** Computes HMAC of a challenge using the shared secret. */
  solveChallenge(challenge: Buffer): Buffer;

  /** Verifies a challenge response matches the expected HMAC. */
  verifyChallenge(challenge: Buffer, response: Buffer): boolean;
}

interface CookieAuthenticatorOptions {
  nonceTtlMs?: number;
  nonceCacheMaxSize?: number;
}

const DEFAULT_NONCE_TTL_MS = 10_000;
const DEFAULT_NONCE_CACHE_MAX_SIZE = 10_000;

/**
 * HMAC-SHA256 cookie-based authenticator inspired by Erlang's distribution
 * cookie. Uses a shared secret to sign/verify gossip messages and perform
 * challenge-response handshakes for transport connections.
 *
 * Security properties:
 * - HMAC-SHA256 for message integrity (cookie never sent in cleartext)
 * - Random nonce per message for replay protection
 * - `crypto.timingSafeEqual()` for all comparisons (timing attack resistant)
 * - Nonce cache with TTL eviction to bound memory usage
 */
export class CookieAuthenticator implements Authenticator {
  private readonly cookie: string;
  private readonly nonceTtlMs: number;
  private readonly nonceCacheMaxSize: number;
  private readonly nonceCache: Map<string, number> = new Map();

  constructor(cookie: string, options?: CookieAuthenticatorOptions) {
    this.cookie = cookie;
    this.nonceTtlMs = options?.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
    this.nonceCacheMaxSize =
      options?.nonceCacheMaxSize ?? DEFAULT_NONCE_CACHE_MAX_SIZE;
  }

  signGossip(message: GossipMessage): AuthenticatedGossipMessage {
    const nonce = crypto.randomBytes(16).toString("hex");
    const hmac = this.computeGossipHmac(message, nonce);
    return { ...message, nonce, hmac };
  }

  verifyGossip(message: AuthenticatedGossipMessage): boolean {
    if (!message.nonce || !message.hmac) {
      return false;
    }

    const expectedHmac = this.computeGossipHmac(message, message.nonce);

    const expectedBuf = Buffer.from(expectedHmac, "hex");
    const actualBuf = Buffer.from(message.hmac, "hex");

    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }

    if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return false;
    }

    this.evictExpiredNonces();

    if (this.nonceCache.has(message.nonce)) {
      return false;
    }

    this.nonceCache.set(message.nonce, Date.now());
    this.evictOverflowNonces();

    return true;
  }

  createChallenge(): Buffer {
    return crypto.randomBytes(32);
  }

  solveChallenge(challenge: Buffer): Buffer {
    return crypto.createHmac("sha256", this.cookie).update(challenge).digest();
  }

  verifyChallenge(challenge: Buffer, response: Buffer): boolean {
    const expected = this.solveChallenge(challenge);

    if (expected.length !== response.length) {
      return false;
    }

    return crypto.timingSafeEqual(expected, response);
  }

  private computeGossipHmac(message: GossipMessage, nonce: string): string {
    const payload = JSON.stringify({
      senderId: message.senderId,
      peers: message.peers,
      nonce,
    });
    return crypto.createHmac("sha256", this.cookie).update(payload).digest("hex");
  }

  private evictExpiredNonces(): void {
    const now = Date.now();
    for (const [nonce, timestamp] of this.nonceCache) {
      if (now - timestamp > this.nonceTtlMs) {
        this.nonceCache.delete(nonce);
      }
    }
  }

  private evictOverflowNonces(): void {
    while (this.nonceCache.size > this.nonceCacheMaxSize) {
      const oldestKey = this.nonceCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.nonceCache.delete(oldestKey);
      }
    }
  }
}

/**
 * No-op authenticator that accepts all messages without verification.
 * Used internally when no authentication is configured.
 */
export class NullAuthenticator implements Authenticator {
  signGossip(message: GossipMessage): AuthenticatedGossipMessage {
    return message;
  }

  verifyGossip(_message: AuthenticatedGossipMessage): boolean {
    return true;
  }

  createChallenge(): Buffer {
    return Buffer.alloc(0);
  }

  solveChallenge(_challenge: Buffer): Buffer {
    return Buffer.alloc(0);
  }

  verifyChallenge(_challenge: Buffer, _response: Buffer): boolean {
    return true;
  }
}
