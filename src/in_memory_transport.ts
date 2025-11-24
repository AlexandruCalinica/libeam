// src/in_memory_transport.ts

import { EventEmitter } from 'events';
import { Transport, Subscription, MessageHandler, RequestHandler } from './transport';
import { v4 as uuidv4 } from 'uuid';

/**
 * An in-memory implementation of the Transport interface, useful for testing
 * and single-node operation. It uses an EventEmitter to simulate channels.
 */
export class InMemoryTransport implements Transport {
  private readonly bus = new EventEmitter();
  private readonly responseChannels = new Map<string, (reply: any) => void>();

  async connect(): Promise<void> {
    this.bus.setMaxListeners(100); // Default is 10, might need more for a busy system
    return Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.bus.removeAllListeners();
    return Promise.resolve();
  }

  async publish(channel: string, message: any): Promise<void> {
    this.bus.emit(channel, message);
  }

  async request(channel: string, message: any, timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const correlationId = uuidv4();
      const responseChannel = `${channel}:${correlationId}`;

      const timeoutId = setTimeout(() => {
        this.responseChannels.delete(responseChannel);
        reject(new Error(`Request timed out after ${timeout}ms`));
      }, timeout);

      this.responseChannels.set(responseChannel, (reply) => {
        clearTimeout(timeoutId);
        this.responseChannels.delete(responseChannel);
        resolve(reply);
      });

      this.bus.emit(channel, { message, replyTo: responseChannel });
    });
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<Subscription> {
    this.bus.on(channel, handler);
    return {
      unsubscribe: async () => {
        this.bus.off(channel, handler);
      },
    };
  }

  async respond(channel: string, handler: RequestHandler): Promise<Subscription> {
    const fullHandler = async ({ message, replyTo }: { message: any; replyTo: string }) => {
      const reply = await handler(message);
      const responseHandler = this.responseChannels.get(replyTo);
      if (responseHandler) {
        responseHandler(reply);
      }
    };
    this.bus.on(channel, fullHandler);
    return {
      unsubscribe: async () => {
        this.bus.off(channel, fullHandler);
      },
    };
  }
}
