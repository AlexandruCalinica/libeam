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

interface ZeroMQTransportConfig {
  nodeId: string;
  rpcPort: number; // Port for ROUTER socket
  pubPort: number; // Port for PUB socket
  bindAddress?: string; // Default: 0.0.0.0
}

export class ZeroMQTransport implements Transport {
  private readonly nodeId: string;
  private readonly rpcAddress: string;
  private readonly pubAddress: string;
  private readonly bindAddress: string;
  private readonly log: Logger;

  private rpcSocket?: zmq.Router;
  private pubSocket?: zmq.Publisher;
  private subSocket?: zmq.Subscriber;

  private dealerSockets = new Map<string, zmq.Dealer>();
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
    for (const [correlationId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transport disconnected"));
    }
    this.pendingRequests.clear();

    // Close all sockets
    if (this.rpcSocket) this.rpcSocket.close();
    if (this.pubSocket) this.pubSocket.close();
    if (this.subSocket) this.subSocket.close();

    for (const dealer of this.dealerSockets.values()) {
      dealer.close();
    }
    this.dealerSockets.clear();
  }

  updatePeers(peers: Array<[nodeId: string, address: string]>): void {
    // Parse address format: "tcp://host:rpcPort:pubPort"
    // Expected format from gossip: address contains RPC endpoint

    const newPeerIds = new Set(peers.map(([id]) => id));

    // Remove disconnected peers
    for (const [peerId, addresses] of this.peerAddresses.entries()) {
      if (!newPeerIds.has(peerId)) {
        // Disconnect from this peer's PUB socket
        if (this.subSocket) {
          this.subSocket.unsubscribe();
          // Note: ZeroMQ doesn't have a disconnect per-address API
          // We would need to track subscriptions more carefully
        }

        // Close dealer socket
        const dealer = this.dealerSockets.get(peerId);
        if (dealer) {
          dealer.close();
          this.dealerSockets.delete(peerId);
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
    const addresses = this.peerAddresses.get(nodeId);
    if (!addresses) {
      throw new PeerNotFoundError(nodeId);
    }

    let dealer = this.dealerSockets.get(nodeId);
    if (!dealer) {
      dealer = new zmq.Dealer();
      try {
        await dealer.connect(addresses.rpc);
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
      this.dealerSockets.set(nodeId, dealer);
      // Start listening for responses from this dealer
      this.handleDealerResponse(nodeId, dealer);
    }

    const correlationId = uuidv4();
    const envelope: RpcEnvelope = { correlationId, payload: message };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        this.log.warn("Request timed out", { peerId: nodeId, timeout });
        reject(new TimeoutError(`request to ${nodeId}`, timeout));
      }, timeout);

      this.pendingRequests.set(correlationId, { resolve, reject, timer });

      dealer!.send(JSON.stringify(envelope)).catch((err) => {
        clearTimeout(timer);
        this.pendingRequests.delete(correlationId);
        this.log.error(
          "Failed to send request",
          err instanceof Error ? err : new Error(String(err)),
          { peerId: nodeId },
        );
        reject(
          new TransportError(
            `Failed to send request to ${nodeId}`,
            nodeId,
            err instanceof Error ? err : undefined,
          ),
        );
      });
    });
  }

  async send(nodeId: string, message: any): Promise<void> {
    const addresses = this.peerAddresses.get(nodeId);
    if (!addresses) {
      throw new PeerNotFoundError(nodeId);
    }

    let dealer = this.dealerSockets.get(nodeId);
    if (!dealer) {
      dealer = new zmq.Dealer();
      try {
        await dealer.connect(addresses.rpc);
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
      this.dealerSockets.set(nodeId, dealer);
    }

    const envelope = { type: "message", payload: message };
    try {
      await dealer.send(JSON.stringify(envelope));
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
      try {
        const data = JSON.parse(messageBuffer.toString());

        // Check if this is a request or a reply
        if (data.correlationId && data.payload !== undefined) {
          // This is a request
          if (this.requestHandler) {
            try {
              const reply = await this.requestHandler(data.payload);
              const replyEnvelope: RpcEnvelope = {
                correlationId: data.correlationId,
                payload: reply,
              };
              await this.rpcSocket!.send([
                identity,
                JSON.stringify(replyEnvelope),
              ]);
            } catch (err) {
              const errorReply: RpcEnvelope = {
                correlationId: data.correlationId,
                payload: { error: (err as Error).message },
              };
              await this.rpcSocket!.send([
                identity,
                JSON.stringify(errorReply),
              ]);
            }
          }
        } else if (data.type === "message") {
          // This is a fire-and-forget message
          if (this.messageHandler) {
            this.messageHandler(data.payload);
          }
        }
      } catch (err) {
        this.log.error(
          "Error handling RPC message",
          err instanceof Error ? err : new Error(String(err)),
        );
      }
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

  private async handleDealerResponse(nodeId: string, dealer: zmq.Dealer) {
    for await (const [messageBuffer] of dealer) {
      try {
        const envelope: RpcEnvelope = JSON.parse(messageBuffer.toString());
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
      } catch (err) {
        this.log.error(
          "Error handling dealer response",
          err instanceof Error ? err : new Error(String(err)),
          { peerId: nodeId },
        );
      }
    }
  }
}
