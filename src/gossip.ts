// src/gossip.ts

/** Status of a peer in the cluster. */
export type PeerStatus = "alive" | "leaving" | "dead";

/**
 * Represents the state of a single peer in the gossip network.
 */
export interface PeerState {
  /** Unique ID of the peer node. */
  id: string;
  /** ZeroMQ address for RPC communication (e.g., tcp://127.0.0.1:5555). */
  address: string;
  /** Current heartbeat counter of the peer. */
  heartbeat: number;
  /** Generation counter of the peer, incremented on restart. */
  generation: number;
  /** UDP address for gossip communication (e.g., udp://127.0.0.1:6000). */
  gossipAddress: string;
  /** Local timestamp when this peer's state was last updated. */
  lastUpdated: number;
  /** Status of the peer. Default: "alive" */
  status?: PeerStatus;
}

/**
 * Represents a gossip message exchanged between peers.
 * It contains the sender's ID and its entire peer table.
 */
export interface GossipMessage {
  /** The ID of the node sending this gossip message. */
  senderId: string;
  /** The sender's entire view of the peer table. */
  peers: PeerState[];
}

/**
 * Represents an authenticated gossip message with optional HMAC and nonce.
 * Extends GossipMessage with optional authentication fields for signed messages.
 * The optional fields ensure backward compatibility with unauthenticated messages.
 */
export interface AuthenticatedGossipMessage extends GossipMessage {
  /** Hex-encoded random bytes used for replay protection. */
  nonce?: string;
  /** Hex-encoded HMAC-SHA256 digest of the message. */
  hmac?: string;
}
