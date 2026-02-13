import * as zmq from "zeromq";
import { MessageHandler, RequestHandler, Subscription, Transport } from "./transport";
import { v4 as uuidv4 } from "uuid";
import { createLogger, Logger } from "./logger";
import { PeerNotFoundError, TimeoutError, TransportError } from "./errors";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcEnvelope {
  correlationId: string;
  payload: any;
}

interface DealerConnection {
  dealer: zmq.Dealer;
}

interface ZeroMQTransportConfig {
  nodeId: string;
  rpcPort: number;
  pubPort: number;
  bindAddress?: string;
  curveKeyPair?: {
    publicKey: string; // Z85-encoded
    secretKey: string; // Z85-encoded
  };
}

export class ZeroMQTransport implements Transport {
  private readonly nodeId: string;
  private readonly rpcAddress: string;
  private readonly pubAddress: string;
  private readonly bindAddress: string;
  private readonly log: Logger;
  private readonly curveKeyPair?: { publicKey: string; secretKey: string };

  private rpcSocket?: zmq.Router;
  private pubSocket?: zmq.Publisher;
  private subSocket?: zmq.Subscriber;

  private dealerConnections = new Map<string, DealerConnection>();
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
    this.curveKeyPair = config.curveKeyPair;
    this.log = createLogger("ZeroMQTransport", this.nodeId);
  }

  getNodeId(): string {
    return this.nodeId;
  }

  async connect(): Promise<void> {
    const curveServerOpts = this.curveKeyPair
      ? { curveServer: true, curveSecretKey: this.curveKeyPair.secretKey }
      : {};

    this.rpcSocket = new zmq.Router({ ...curveServerOpts });
    await this.rpcSocket.bind(this.rpcAddress);

    this.pubSocket = new zmq.Publisher({ ...curveServerOpts });
    await this.pubSocket.bind(this.pubAddress);

    const curveClientOpts = this.curveKeyPair
      ? {
          curveServerKey: this.curveKeyPair.publicKey,
          curvePublicKey: this.curveKeyPair.publicKey,
          curveSecretKey: this.curveKeyPair.secretKey,
        }
      : {};

    this.subSocket = new zmq.Subscriber({ ...curveClientOpts });

    this.runRpcLoop();
    this.runSubLoop();
  }

  async disconnect(): Promise<void> {
    for (const [, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transport disconnected"));
    }
    this.pendingRequests.clear();

    if (this.rpcSocket) {
      this.rpcSocket.close();
    }
    if (this.pubSocket) {
      this.pubSocket.close();
    }
    if (this.subSocket) {
      this.subSocket.close();
    }

    for (const connection of this.dealerConnections.values()) {
      connection.dealer.close();
    }
    this.dealerConnections.clear();
  }

  updatePeers(peers: Array<[nodeId: string, address: string]>): void {
    const newPeerIds = new Set(peers.map(([id]) => id));

    for (const [peerId] of this.peerAddresses.entries()) {
      if (!newPeerIds.has(peerId)) {
        if (this.subSocket) {
          this.subSocket.unsubscribe();
        }

        const connection = this.dealerConnections.get(peerId);
        if (connection) {
          connection.dealer.close();
          this.dealerConnections.delete(peerId);
        }

        this.peerAddresses.delete(peerId);
      }
    }

    for (const [peerId, rpcAddress] of peers) {
      if (!this.peerAddresses.has(peerId) && peerId !== this.nodeId) {
        const match = rpcAddress.match(/tcp:\/\/([^:]+):(\d+)/);
        if (match) {
          const host = match[1];
          const rpcPort = parseInt(match[2], 10);
          const pubPort = rpcPort + 1;
          const pubAddress = `tcp://${host}:${pubPort}`;

          this.peerAddresses.set(peerId, { rpc: rpcAddress, pub: pubAddress });

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

      this.sendMessage(nodeId, connection, serializedEnvelope).catch((err) => {
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

    await this.sendMessage(nodeId, connection, serializedEnvelope);
  }

  async publish(topic: string, message: any): Promise<void> {
    if (!this.pubSocket) {
      throw new Error("Transport not connected");
    }
    await this.pubSocket.send([topic, JSON.stringify(message)]);
  }

  async subscribe(topic: string, handler: MessageHandler): Promise<Subscription> {
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

  private async runRpcLoop(): Promise<void> {
    if (!this.rpcSocket) {
      return;
    }

    for await (const [identity, messageBuffer] of this.rpcSocket) {
      void this.handleRouterMessage(identity as Buffer, messageBuffer as Buffer);
    }
  }

  private async runSubLoop(): Promise<void> {
    if (!this.subSocket) {
      return;
    }

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

  private async handleDealerResponse(
    nodeId: string,
    connection: DealerConnection,
  ): Promise<void> {
    for await (const [messageBuffer] of connection.dealer) {
      try {
        const envelope: RpcEnvelope = JSON.parse(messageBuffer.toString());
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

    const curveClientOpts = this.curveKeyPair
      ? {
          curveServerKey: this.curveKeyPair.publicKey,
          curvePublicKey: this.curveKeyPair.publicKey,
          curveSecretKey: this.curveKeyPair.secretKey,
        }
      : {};

    const dealer = new zmq.Dealer({ ...curveClientOpts });

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

    const connection: DealerConnection = { dealer };
    this.dealerConnections.set(nodeId, connection);
    void this.handleDealerResponse(nodeId, connection);

    return connection;
  }

  private async sendMessage(
    nodeId: string,
    connection: DealerConnection,
    payload: string,
  ): Promise<void> {
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
  }

  private async handleRouterMessage(
    identity: Buffer,
    messageBuffer: Buffer,
  ): Promise<void> {
    try {
      const data = JSON.parse(messageBuffer.toString());

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
}
