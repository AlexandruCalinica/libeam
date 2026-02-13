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
 * Pluggable authentication interface for securing gossip communication
 * between cluster nodes. Transport-level security (encryption + auth)
 * is handled by CurveZMQ at the socket layer, driven by the cookie.
 */
export interface Authenticator {
  /** Adds `nonce` and `hmac` fields to a gossip message. */
  signGossip(message: GossipMessage): AuthenticatedGossipMessage;

  /** Verifies HMAC integrity and checks nonce has not been replayed. */
  verifyGossip(message: AuthenticatedGossipMessage): boolean;
}

/**
 * Z85 encoding per ZeroMQ RFC 32.
 * Encodes binary data (length must be multiple of 4) to printable ASCII.
 */
const Z85_CHARS =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

export function z85Encode(data: Buffer): string {
  if (data.length % 4 !== 0) {
    throw new Error("Z85 encode: data length must be a multiple of 4");
  }
  let str = "";
  for (let i = 0; i < data.length; i += 4) {
    let value =
      ((data[i] << 24) |
        (data[i + 1] << 16) |
        (data[i + 2] << 8) |
        data[i + 3]) >>>
      0;
    const chars: string[] = [];
    for (let j = 4; j >= 0; j--) {
      chars[j] = Z85_CHARS[value % 85];
      value = Math.floor(value / 85);
    }
    str += chars.join("");
  }
  return str;
}

export function z85Decode(str: string): Buffer {
  if (str.length % 5 !== 0) {
    throw new Error("Z85 decode: string length must be a multiple of 5");
  }
  const data = Buffer.alloc((str.length / 5) * 4);
  for (let i = 0, j = 0; i < str.length; i += 5, j += 4) {
    let value = 0;
    for (let k = 0; k < 5; k++) {
      value = value * 85 + Z85_CHARS.indexOf(str[i + k]);
    }
    data[j] = (value >> 24) & 0xff;
    data[j + 1] = (value >> 16) & 0xff;
    data[j + 2] = (value >> 8) & 0xff;
    data[j + 3] = value & 0xff;
  }
  return data;
}

export interface CurveKeyPair {
  publicKey: string; // Z85-encoded, 40 chars
  secretKey: string; // Z85-encoded, 40 chars
}

/**
 * Derives an HMAC key for gossip signing and a CurveZMQ keypair for
 * transport encryption from a shared cookie using HKDF-SHA256.
 *
 * Uses domain-separated info strings to prevent cross-protocol key reuse:
 * - "gossip-hmac" → 32-byte HMAC key for gossip UDP
 * - "curve-seed"  → 32-byte seed → X25519 keypair for ZeroMQ CURVE
 */
export function deriveKeys(
  cookie: string,
  salt: string = "libeam-v2",
): { hmacKey: Buffer; curveKeyPair: CurveKeyPair } {
  // Derive HMAC key for gossip signing
  const hmacKey = Buffer.from(
    crypto.hkdfSync("sha256", cookie, salt, "gossip-hmac", 32),
  );

  // Derive Curve25519 seed for transport encryption
  const curveSeed = Buffer.from(
    crypto.hkdfSync("sha256", cookie, salt, "curve-seed", 32),
  );

  // Create X25519 private key from seed using PKCS8 DER encoding
  const pkcs8Header = Buffer.from(
    "302e020100300506032b656e04220420",
    "hex",
  );
  const derKey = Buffer.concat([pkcs8Header, curveSeed]);
  const privKey = crypto.createPrivateKey({
    key: derKey,
    format: "der",
    type: "pkcs8",
  });
  const pubKey = crypto.createPublicKey(privKey);

  // Export raw 32-byte public key (last 32 bytes of SPKI DER)
  const rawPub = pubKey
    .export({ type: "spki", format: "der" })
    .subarray(-32);

  return {
    hmacKey,
    curveKeyPair: {
      publicKey: z85Encode(rawPub),
      secretKey: z85Encode(curveSeed),
    },
  };
}

const MIN_COOKIE_LENGTH = 16;

interface CookieAuthenticatorOptions {
  nonceTtlMs?: number;
  nonceCacheMaxSize?: number;
  salt?: string;
}

const DEFAULT_NONCE_TTL_MS = 10_000;
const DEFAULT_NONCE_CACHE_MAX_SIZE = 10_000;

/**
 * HMAC-SHA256 cookie-based authenticator inspired by Erlang's distribution
 * cookie. Uses HKDF-derived keys for gossip message signing and provides
 * CurveZMQ keypairs for transport encryption.
 *
 * Security properties:
 * - HKDF-SHA256 key derivation with domain-separated info strings
 * - HMAC-SHA256 for gossip message integrity
 * - Random nonce per message for replay protection
 * - `crypto.timingSafeEqual()` for all comparisons (timing attack resistant)
 * - Nonce cache with TTL eviction to bound memory usage
 * - CurveZMQ keypair for transport-level encryption + authentication
 */
export class CookieAuthenticator implements Authenticator {
  private readonly hmacKey: Buffer;
  private readonly nonceTtlMs: number;
  private readonly nonceCacheMaxSize: number;
  private readonly nonceCache: Map<string, number> = new Map();

  /** CurveZMQ keypair derived from the cookie, for transport encryption. */
  readonly curveKeyPair: CurveKeyPair;

  constructor(cookie: string, options?: CookieAuthenticatorOptions) {
    if (cookie.length < MIN_COOKIE_LENGTH) {
      throw new Error(
        `Cookie must be at least ${MIN_COOKIE_LENGTH} characters for secure key derivation.`,
      );
    }

    const salt = options?.salt ?? "libeam-v2";
    const derived = deriveKeys(cookie, salt);

    this.hmacKey = derived.hmacKey;
    this.curveKeyPair = derived.curveKeyPair;
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

  private computeGossipHmac(message: GossipMessage, nonce: string): string {
    const payload = JSON.stringify({
      senderId: message.senderId,
      peers: message.peers,
      nonce,
    });
    return crypto
      .createHmac("sha256", this.hmacKey)
      .update(payload)
      .digest("hex");
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
}
