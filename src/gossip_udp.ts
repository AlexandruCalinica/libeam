// src/gossip_udp.ts

import * as dgram from "dgram";
import { EventEmitter } from "events";
import type { Authenticator } from "./auth";
import { AuthenticatedGossipMessage, GossipMessage } from "./gossip";
import { Logger, createLogger } from "./logger";

const UDP_MAX_SIZE = 65507; // Maximum size for a UDP payload

export interface GossipUDPConfig {
  /** The local address to bind to. */
  address: string;
  /** The local port to bind to. */
  port: number;
}

/**
 * Handles sending and receiving of gossip messages over UDP.
 * It's essentially the low-level network driver for the gossip protocol.
 */
export class GossipUDP extends EventEmitter {
  private socket!: dgram.Socket;
  private readonly config: GossipUDPConfig;
  private readonly auth?: Authenticator;
  private readonly log: Logger;
  private readonly warnedUnauthorizedPeers = new Set<string>();

  constructor(config: GossipUDPConfig & { auth?: Authenticator }) {
    super();
    this.config = {
      address: config.address,
      port: config.port,
    };
    this.auth = config.auth;
    this.log = createLogger("GossipUDP").child({
      address: `${config.address}:${config.port}`,
    });
  }

  /**
   * Binds the UDP socket and starts listening for messages.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket("udp4");

      this.socket.on("error", (err) => {
        this.log.error("Socket error", err);
        this.socket.close();
        reject(err);
      });

      this.socket.on("message", (msg, rinfo) => {
        try {
          const decoded: AuthenticatedGossipMessage = JSON.parse(msg.toString());

          if (this.auth) {
            if (!this.auth.verifyGossip(decoded)) {
              const peer = `${rinfo.address}:${rinfo.port}`;
              if (!this.warnedUnauthorizedPeers.has(peer)) {
                this.warnedUnauthorizedPeers.add(peer);
                this.log.warn("Rejected unauthenticated gossip message", {
                  from: peer,
                });
              }
              return;
            }
          }

          const gossipMessage: GossipMessage = {
            senderId: decoded.senderId,
            peers: decoded.peers,
          };
          this.emit("message", gossipMessage, rinfo);
        } catch (e) {
          this.log.warn("Failed to parse gossip message", {
            from: `${rinfo.address}:${rinfo.port}`,
          });
        }
      });

      this.socket.on("listening", () => {
        const addr = this.socket.address();
        this.log.debug("Listening", { bind: `${addr.address}:${addr.port}` });
        resolve();
      });

      this.socket.bind(this.config.port, this.config.address);
    });
  }

  /**
   * Stops the UDP socket.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.close(() => {
          this.socket.removeAllListeners();
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Sends a gossip message to a target address.
   * @param message The GossipMessage to send.
   * @param targetAddress The target IP address.
   * @param targetPort The target port.
   */
  async send(
    message: GossipMessage,
    targetAddress: string,
    targetPort: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const outgoingMessage = this.auth ? this.auth.signGossip(message) : message;
      const payload = Buffer.from(JSON.stringify(outgoingMessage));
      const target = `${targetAddress}:${targetPort}`;

      if (payload.length > UDP_MAX_SIZE) {
        this.log.warn("Message too large, dropping", {
          size: payload.length,
          target,
        });
        return reject(new Error("Message too large for UDP payload."));
      }

      this.socket.send(payload, targetPort, targetAddress, (err) => {
        if (err) {
          this.log.error("Send error", err, { target });
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
