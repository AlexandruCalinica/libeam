// src/zeromq_transport.ts

import * as zmq from "zeromq";
import {
  Transport,
  Subscription,
  MessageHandler,
  RequestHandler,
} from "./transport";
import { v4 as uuidv4 } from "uuid";
import { Logger, createLogger } from "./logger";
import {
  AuthenticationError,
  PeerNotFoundError,
  TimeoutError,
  TransportError,
} from "./errors";
import type { Authenticator } from "./auth";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcEnvelope {
  correlationId: string;
  payload: any;
}

type ConnectionState = "connecting" | "handshaking" | "authenticated" | "ready";

interface QueuedOutboundMessage {
  payload: string;
  resolve?: () => void;
  onError?: (error: Error) => void;
}

interface DealerConnection {
  dealer: zmq.Dealer;
  state: ConnectionState;
  queue: QueuedOutboundMessage[];
  handshakePromise?: Promise<void>;
  resolveHandshake?: () => void;
  rejectHandshake?: (error: Error) => void;
  handshakeTimer?: NodeJS.Timeout;
}

interface HandshakeChallengeMessage {
  __libeamAuth: true;
  type: "challenge";
  challenge: string;
}

interface HandshakeResponseMessage {
  __libeamAuth: true;
  type: "response";
  response: string;
}

interface HandshakeReadyMessage {
  __libeamAuth: true;
  type: "ready";
}

interface HandshakeErrorMessage {
  __libeamAuth: true;
  type: "error";
  reason: string;
}

interface ServerHandshakeState {
  state: "handshaking" | "authenticated";
  challenge?: Buffer;
  timer?: NodeJS.Timeout;
}

interface ZeroMQTransportConfig {
  nodeId: string;
  rpcPort: number; // Port for ROUTER socket
  pubPort: number; // Port for PUB socket
  bindAddress?: string; // Default: 0.0.0.0
  auth?: Authenticator;
  handshakeTimeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;

export class ZeroMQTransport implements Transport {
  private readonly nodeId: string;
  private readonly rpcAddress: string;
  private readonly pubAddress: string;
  private readonly bindAddress: string;
  private readonly log: Logger;

  private rpcSocket?: zmq.Router;
  private pubSocket?: zmq.Publisher;
  private subSocket?: zmq.Subscriber;

  private readonly auth?: Authenticator;
  private readonly handshakeTimeoutMs: number;
  private dealerConnections = new Map<string, DealerConnection>();
  private serverAuthStates = new Map<string, ServerHandshakeState>();
  private pendingRequests = new Map<string, PendingRequest>();
  private subscriptions = new Map<string, MessageHandler[]>();
  private peerAddresses = new Map<string, { rpc: string; pub: string }>();

  private requestHandler?: RequestHandler;
  private messageHandler?: MessageHandler;

  constructor(config: ZeroMQTransportConfig) {
    this.nodeId = config.nodeId;
    this.bindAddress = config.bindAddress || "0.0.0.0";
    this.rpcAddress = `tcp://${this.bindAddress}:${config.rpcPort}`;
    this.pubAddress = `tcp://${this.bindAddress}:${config.pubPort}`;
    this.auth = config.auth;
    this.handshakeTimeoutMs =
      config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.log = createLogger("ZeroMQTransport", this.nodeId);
  }

  getNodeId(): string {
    return this.nodeId;
  }

  async connect(): Promise<void> {
    this.rpcSocket = new zmq.Router();
    await this.rpcSocket.bind(this.rpcAddress);

    this.pubSocket = new zmq.Publisher();
    await this.pubSocket.bind(this.pubAddress);

    this.subSocket = new zmq.Subscriber();

    this.runRpcLoop();
    this.runSubLoop();
  }

  async disconnect(): Promise<void> {
    // Cleanup pending requests
    for (const [, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transport disconnected"));
    }
    this.pendingRequests.clear();

    // Close all sockets
    if (this.rpcSocket) this.rpcSocket.close();
    if (this.pubSocket) this.pubSocket.close();
    if (this.subSocket) this.subSocket.close();

    for (const connection of this.dealerConnections.values()) {
      if (connection.handshakeTimer) {
        clearTimeout(connection.handshakeTimer);
      }
      connection.dealer.close();
    }
    this.dealerConnections.clear();

    for (const state of this.serverAuthStates.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.serverAuthStates.clear();
  }

  updatePeers(peers: Array<[nodeId: string, address: string]>): void {
    // Parse address format: "tcp://host:rpcPort:pubPort"
    // Expected format from gossip: address contains RPC endpoint

    const newPeerIds = new Set(peers.map(([id]) => id));

    // Remove disconnected peers
    for (const [peerId] of this.peerAddresses.entries()) {
      if (!newPeerIds.has(peerId)) {
        // Disconnect from this peer's PUB socket
        if (this.subSocket) {
          this.subSocket.unsubscribe();
          // Note: ZeroMQ doesn't have a disconnect per-address API
          // We would need to track subscriptions more carefully
        }

        // Close dealer socket
        const connection = this.dealerConnections.get(peerId);
        if (connection) {
          if (connection.handshakeTimer) {
            clearTimeout(connection.handshakeTimer);
          }
          connection.dealer.close();
          this.dealerConnections.delete(peerId);
        }

        this.peerAddresses.delete(peerId);
      }
    }

    // Add new peers
    for (const [peerId, rpcAddress] of peers) {
      if (!this.peerAddresses.has(peerId) && peerId !== this.nodeId) {
        // Parse RPC address to derive PUB address
        // Assuming format: tcp://host:rpcPort and pubPort = rpcPort + 1
        const match = rpcAddress.match(/tcp:\/\/([^:]+):(\d+)/);
        if (match) {
          const host = match[1];
          const rpcPort = parseInt(match[2], 10);
          const pubPort = rpcPort + 1;
          const pubAddress = `tcp://${host}:${pubPort}`;

          this.peerAddresses.set(peerId, { rpc: rpcAddress, pub: pubAddress });

          // Subscribe to peer's PUB socket
          if (this.subSocket) {
            this.subSocket.connect(pubAddress);
          }
        }
      }
    }
  }

  async request(nodeId: string, message: any, timeout: number): Promise<any> {
    const connection = await this.getOrCreateConnection(nodeId);

    const correlationId = uuidv4();
    const envelope: RpcEnvelope = { correlationId, payload: message };
    const serializedEnvelope = JSON.stringify(envelope);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        this.log.warn("Request timed out", { peerId: nodeId, timeout });
        reject(new TimeoutError(`request to ${nodeId}`, timeout));
      }, timeout);

      this.pendingRequests.set(correlationId, { resolve, reject, timer });

      this.sendOrQueue(nodeId, connection, serializedEnvelope).catch((err) => {
        clearTimeout(timer);
        this.pendingRequests.delete(correlationId);
        reject(err);
      });
    });
  }

  async send(nodeId: string, message: any): Promise<void> {
    const connection = await this.getOrCreateConnection(nodeId);

    const envelope = { type: "message", payload: message };
    const serializedEnvelope = JSON.stringify(envelope);

    await this.sendOrQueue(nodeId, connection, serializedEnvelope);
  }

  async publish(topic: string, message: any): Promise<void> {
    if (!this.pubSocket) {
      throw new Error("Transport not connected");
    }
    await this.pubSocket.send([topic, JSON.stringify(message)]);
  }

  async subscribe(
    topic: string,
    handler: MessageHandler,
  ): Promise<Subscription> {
    if (!this.subSocket) {
      throw new Error("Transport not connected");
    }

    this.subSocket.subscribe(topic);

    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, []);
    }
    this.subscriptions.get(topic)!.push(handler);

    return {
      unsubscribe: async () => {
        const handlers = this.subscriptions.get(topic);
        if (handlers) {
          const index = handlers.indexOf(handler);
          if (index > -1) {
            handlers.splice(index, 1);
          }
          if (handlers.length === 0) {
            this.subscriptions.delete(topic);
            if (this.subSocket) {
              this.subSocket.unsubscribe(topic);
            }
          }
        }
      },
    };
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  private async runRpcLoop() {
    if (!this.rpcSocket) return;

    for await (const [identity, messageBuffer] of this.rpcSocket) {
      void this.handleRouterMessage(identity as Buffer, messageBuffer as Buffer);
    }
  }

  private async runSubLoop() {
    if (!this.subSocket) return;

    for await (const [topicBuffer, messageBuffer] of this.subSocket) {
      try {
        const topic = topicBuffer.toString();
        const handlers = this.subscriptions.get(topic);
        if (handlers) {
          const parsedMessage = JSON.parse(messageBuffer.toString());
          for (const handler of handlers) {
            handler(parsedMessage);
          }
        }
      } catch (err) {
        this.log.error(
          "Error handling subscription message",
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  }

  private async handleDealerResponse(nodeId: string, connection: DealerConnection) {
    for await (const [messageBuffer] of connection.dealer) {
      try {
        const parsed = JSON.parse(messageBuffer.toString());

        if (this.isHandshakeMessage(parsed)) {
          await this.handleClientHandshakeMessage(nodeId, connection, parsed);
          continue;
        }

        const envelope: RpcEnvelope = parsed;
        if (typeof envelope.correlationId === "string") {
          const pending = this.pendingRequests.get(envelope.correlationId);

          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(envelope.correlationId);

            if (envelope.payload && envelope.payload.error) {
              pending.reject(new Error(envelope.payload.error));
            } else {
              pending.resolve(envelope.payload);
            }
          }
        }
      } catch (err) {
        this.log.error(
          "Error handling dealer response",
          err instanceof Error ? err : new Error(String(err)),
          { peerId: nodeId },
        );
      }
    }
  }

  private async getOrCreateConnection(nodeId: string): Promise<DealerConnection> {
    const existing = this.dealerConnections.get(nodeId);
    if (existing) {
      return existing;
    }

    const addresses = this.peerAddresses.get(nodeId);
    if (!addresses) {
      throw new PeerNotFoundError(nodeId);
    }

    const dealer = new zmq.Dealer();
    const connection: DealerConnection = {
      dealer,
      state: "connecting",
      queue: [],
    };

    try {
      dealer.connect(addresses.rpc);
    } catch (err) {
      this.log.error(
        "Failed to connect dealer socket",
        err instanceof Error ? err : new Error(String(err)),
        { peerId: nodeId },
      );
      throw new TransportError(
        `Failed to connect to node ${nodeId}`,
        nodeId,
        err instanceof Error ? err : undefined,
      );
    }

    this.dealerConnections.set(nodeId, connection);
    this.handleDealerResponse(nodeId, connection);

    if (this.auth) {
      this.startClientHandshake(nodeId, connection);
    } else {
      connection.state = "ready";
    }

    return connection;
  }

  private startClientHandshake(nodeId: string, connection: DealerConnection): void {
    if (!this.auth) {
      connection.state = "ready";
      return;
    }

    connection.state = "handshaking";
    connection.handshakePromise = new Promise<void>((resolve, reject) => {
      connection.resolveHandshake = resolve;
      connection.rejectHandshake = reject;
    });
    connection.handshakePromise.catch(() => undefined);

    connection.handshakeTimer = setTimeout(() => {
      const error = new AuthenticationError("Handshake timed out", nodeId);
      this.failClientHandshake(nodeId, connection, error);
    }, this.handshakeTimeoutMs);

    const helloMessage = JSON.stringify({ __libeamAuth: true, type: "hello" });
    connection.dealer.send(helloMessage).catch((err) => {
      const wrapped = new TransportError(
        `Failed to initiate handshake with ${nodeId}`,
        nodeId,
        err instanceof Error ? err : undefined,
      );
      this.failClientHandshake(nodeId, connection, wrapped);
    });
  }

  private async handleClientHandshakeMessage(
    nodeId: string,
    connection: DealerConnection,
    message:
      | { __libeamAuth: true; type: "hello" }
      | HandshakeChallengeMessage
      | HandshakeReadyMessage
      | HandshakeErrorMessage
      | HandshakeResponseMessage,
  ): Promise<void> {
    if (!this.auth || connection.state === "ready") {
      return;
    }

    if (message.type === "challenge") {
      if (connection.state !== "handshaking") {
        return;
      }
      const challenge = Buffer.from(message.challenge, "hex");
      const response = this.auth.solveChallenge(challenge).toString("hex");
      const responseMessage: HandshakeResponseMessage = {
        __libeamAuth: true,
        type: "response",
        response,
      };
      await connection.dealer.send(JSON.stringify(responseMessage));
      return;
    }

    if (message.type === "ready") {
      this.completeClientHandshake(connection);
      return;
    }

    if (message.type === "error") {
      this.failClientHandshake(
        nodeId,
        connection,
        new AuthenticationError(message.reason, nodeId),
      );
    }
  }

  private completeClientHandshake(connection: DealerConnection): void {
    if (connection.handshakeTimer) {
      clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = undefined;
    }

    connection.state = "authenticated";
    connection.state = "ready";
    connection.resolveHandshake?.();
    this.flushConnectionQueue(connection);
  }

  private failClientHandshake(
    nodeId: string,
    connection: DealerConnection,
    error: Error,
  ): void {
    if (connection.handshakeTimer) {
      clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = undefined;
    }

    connection.rejectHandshake?.(error);

    const queued = [...connection.queue];
    connection.queue = [];
    for (const item of queued) {
      item.onError?.(error);
    }

    connection.dealer.close();
    this.dealerConnections.delete(nodeId);
  }

  private flushConnectionQueue(connection: DealerConnection): void {
    const queued = [...connection.queue];
    connection.queue = [];

    for (const item of queued) {
      connection.dealer
        .send(item.payload)
        .then(() => {
          item.resolve?.();
        })
        .catch((err) => {
          item.onError?.(
            new TransportError(
              "Failed to send queued message",
              undefined,
              err instanceof Error ? err : undefined,
            ),
          );
        });
    }
  }

  private async sendOrQueue(
    nodeId: string,
    connection: DealerConnection,
    payload: string,
  ): Promise<void> {
    if (connection.state === "ready") {
      try {
        await connection.dealer.send(payload);
      } catch (err) {
        this.log.error(
          "Failed to send message",
          err instanceof Error ? err : new Error(String(err)),
          { peerId: nodeId },
        );
        throw new TransportError(
          `Failed to send message to ${nodeId}`,
          nodeId,
          err instanceof Error ? err : undefined,
        );
      }
      return;
    }

    await new Promise<void>((resolve, reject) => {
      connection.queue.push({ payload, resolve, onError: reject });
    });
  }

  private async handleRouterMessage(
    identity: Buffer,
    messageBuffer: Buffer,
  ): Promise<void> {
    try {
      const data = JSON.parse(messageBuffer.toString());

      if (this.auth) {
        const authenticated = await this.ensureServerAuthentication(identity, data);
        if (!authenticated) {
          return;
        }
      }

      if (data.correlationId && data.payload !== undefined) {
        if (this.requestHandler) {
          try {
            const reply = await this.requestHandler(data.payload);
            const replyEnvelope: RpcEnvelope = {
              correlationId: data.correlationId,
              payload: reply,
            };
            await this.rpcSocket!.send([identity, JSON.stringify(replyEnvelope)]);
          } catch (err) {
            const errorReply: RpcEnvelope = {
              correlationId: data.correlationId,
              payload: { error: (err as Error).message },
            };
            await this.rpcSocket!.send([identity, JSON.stringify(errorReply)]);
          }
        }
        return;
      }

      if (data.type === "message" && this.messageHandler) {
        this.messageHandler(data.payload);
      }
    } catch (err) {
      this.log.error(
        "Error handling RPC message",
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private async ensureServerAuthentication(
    identity: Buffer,
    data: any,
  ): Promise<boolean> {
    if (!this.auth) {
      return true;
    }

    const identityKey = identity.toString("hex");
    const state = this.serverAuthStates.get(identityKey);

    if (state?.state === "authenticated") {
      return true;
    }

    if (!this.isHandshakeMessage(data)) {
      await this.issueChallenge(identityKey, identity);
      return false;
    }

    if (data.type === "hello") {
      await this.issueChallenge(identityKey, identity);
      return false;
    }

    if (data.type === "response" && state?.state === "handshaking" && state.challenge) {
      const response = Buffer.from(data.response, "hex");
      const verified = this.auth.verifyChallenge(state.challenge, response);

      if (!verified) {
        if (state.timer) {
          clearTimeout(state.timer);
        }
        this.serverAuthStates.delete(identityKey);
        this.log.warn("Rejected dealer authentication", { identity: identityKey });

        const errorMessage: HandshakeErrorMessage = {
          __libeamAuth: true,
          type: "error",
          reason: "Invalid challenge response",
        };
        await this.rpcSocket!.send([identity, JSON.stringify(errorMessage)]);
        return false;
      }

      if (state.timer) {
        clearTimeout(state.timer);
      }

      this.serverAuthStates.set(identityKey, { state: "authenticated" });
      const ready: HandshakeReadyMessage = {
        __libeamAuth: true,
        type: "ready",
      };
      await this.rpcSocket!.send([identity, JSON.stringify(ready)]);
      return false;
    }

    return false;
  }

  private async issueChallenge(identityKey: string, identity: Buffer): Promise<void> {
    if (!this.auth) {
      return;
    }

    const existing = this.serverAuthStates.get(identityKey);
    if (existing?.state === "authenticated") {
      return;
    }

    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const challenge = this.auth.createChallenge();
    const timer = setTimeout(() => {
      const stale = this.serverAuthStates.get(identityKey);
      if (stale?.timer) {
        clearTimeout(stale.timer);
      }
      this.serverAuthStates.delete(identityKey);
    }, this.handshakeTimeoutMs);

    this.serverAuthStates.set(identityKey, {
      state: "handshaking",
      challenge,
      timer,
    });

    const challengeMessage: HandshakeChallengeMessage = {
      __libeamAuth: true,
      type: "challenge",
      challenge: challenge.toString("hex"),
    };
    await this.rpcSocket!.send([identity, JSON.stringify(challengeMessage)]);
  }

  private isHandshakeMessage(
    message: any,
  ): message is
    | { __libeamAuth: true; type: "hello" }
    | HandshakeChallengeMessage
    | HandshakeResponseMessage
    | HandshakeReadyMessage
    | HandshakeErrorMessage {
    return (
      typeof message === "object" &&
      message !== null &&
      message.__libeamAuth === true &&
      typeof message.type === "string"
    );
  }
}
