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
 */
export interface Transport {
  /**
   * Publishes a fire-and-forget message to a channel.
   * @param channel The channel to publish to.
   * @param message The message to send.
   */
  publish(channel: string, message: any): Promise<void>;

  /**
   * Sends a request to a channel and waits for a reply.
   * @param channel The channel to send the request to.
   * @param message The message to send.
   * @param timeout The timeout in milliseconds to wait for a reply.
   * @returns A promise that resolves with the reply.
   */
  request(channel: string, message: any, timeout: number): Promise<any>;

  /**
   * Subscribes to a channel to receive fire-and-forget messages.
   * @param channel The channel to subscribe to.
   * @param handler The handler for incoming messages.
   * @returns A promise that resolves with a subscription object.
   */
  subscribe(channel: string, handler: MessageHandler): Promise<Subscription>;

  /**
   * Subscribes to a channel to handle requests and send replies.
   * @param channel The channel to subscribe to.
   * @param handler The handler for incoming requests.
   * @returns A promise that resolves with a subscription object.
   */
  respond(channel: string, handler: RequestHandler): Promise<Subscription>;

  /**
   * Connects the transport.
   */
  connect(): Promise<void>;

  /**
   * Disconnects the transport.
   */
  disconnect(): Promise<void>;
}
