// src/transport.ts

/**
 * Represents a subscription to a channel.
 */
export interface Subscription {
  /**
   * Unsubscribes from the channel.
   */
  unsubscribe(): Promise<void>;
}

/**
 * The handler for an incoming message.
 */
export type MessageHandler = (message: any) => void;

/**
 * The handler for an incoming request that expects a reply.
 */
export type RequestHandler = (message: any) => Promise<any>;

/**
 * An interface for a transport layer that can send and receive messages
 * between nodes in the cluster.
 *
 * This interface uses nodeId-based addressing. The transport internally
 * maps nodeId to physical addresses (e.g., TCP endpoints).
 */
export interface Transport {
  /**
   * Gets this node's unique identifier.
   */
  getNodeId(): string;

  /**
   * Sends a request to a specific node and waits for a reply.
   * Uses correlation IDs internally to match requests with responses.
   * @param nodeId The ID of the remote node to send the request to.
   * @param message The message to send.
   * @param timeout The timeout in milliseconds to wait for a reply.
   * @returns A promise that resolves with the reply.
   */
  request(nodeId: string, message: any, timeout: number): Promise<any>;

  /**
   * Sends a fire-and-forget message to a specific node.
   * @param nodeId The ID of the remote node to send the message to.
   * @param message The message to send.
   */
  send(nodeId: string, message: any): Promise<void>;

  /**
   * Publishes a message to a topic that all nodes can subscribe to.
   * Used for registry gossip and other broadcast scenarios.
   * @param topic The topic to publish to.
   * @param message The message to send.
   */
  publish(topic: string, message: any): Promise<void>;

  /**
   * Subscribes to a topic to receive messages from all nodes.
   * @param topic The topic to subscribe to.
   * @param handler The handler for incoming messages.
   * @returns A promise that resolves with a subscription object.
   */
  subscribe(topic: string, handler: MessageHandler): Promise<Subscription>;

  /**
   * Sets up the handler for all incoming RPC requests.
   * @param handler The handler for incoming requests.
   */
  onRequest(handler: RequestHandler): void;

  /**
   * Sets up the handler for all incoming fire-and-forget messages.
   * @param handler The handler for incoming messages.
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Updates the known peer list with their physical addresses.
   * Called by the membership layer when nodes join or leave.
   * @param peers Array of [nodeId, physicalAddress] tuples.
   */
  updatePeers(peers: Array<[nodeId: string, address: string]>): void;

  /**
   * Connects the transport.
   */
  connect(): Promise<void>;

  /**
   * Disconnects the transport.
   */
  disconnect(): Promise<void>;
}
