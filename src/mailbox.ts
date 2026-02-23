import { StashedMessage } from "./actor";
import { MailboxFullError } from "./errors";

export type MailboxOverflowStrategy = "drop-newest" | "drop-oldest" | "error";

export interface MailboxConfig {
  /** Maximum number of messages. undefined = unbounded (default, backwards-compatible) */
  maxSize?: number;
  /** What to do when mailbox is full. Default: "drop-newest" */
  overflowStrategy?: MailboxOverflowStrategy;
}

export const DEFAULT_MAILBOX_CONFIG: MailboxConfig = {};

export class BoundedMailbox {
  private readonly maxSize?: number;
  private readonly overflowStrategy: MailboxOverflowStrategy;
  private readonly messages: StashedMessage[] = [];
  private droppedCount = 0;

  constructor(config: MailboxConfig = {}) {
    this.maxSize = config.maxSize;
    this.overflowStrategy = config.overflowStrategy ?? "drop-newest";
  }

  get length(): number {
    return this.messages.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get isFull(): boolean {
    return this.maxSize !== undefined && this.messages.length >= this.maxSize;
  }

  get capacity(): number | undefined {
    return this.maxSize;
  }

  enqueue(msg: StashedMessage): boolean {
    if (!this.isFull) {
      this.messages.push(msg);
      return true;
    }

    this.droppedCount++;

    if (this.overflowStrategy === "drop-newest") {
      return false;
    }

    if (this.overflowStrategy === "drop-oldest") {
      const dropped = this.messages.shift();
      if (dropped?.type === "call" && dropped.reject) {
        dropped.reject(new MailboxFullError());
      }
      this.messages.push(msg);
      return true;
    }

    throw new MailboxFullError();
  }

  dequeue(): StashedMessage | undefined {
    return this.messages.shift();
  }

  unshift(...msgs: StashedMessage[]): void {
    this.messages.unshift(...msgs);
  }

  clear(): void {
    this.messages.length = 0;
  }

  drain(): StashedMessage[] {
    const pending = [...this.messages];
    this.clear();
    return pending;
  }

  toArray(): StashedMessage[] {
    return [...this.messages];
  }

  replaceWith(msgs: StashedMessage[]): void {
    this.messages.length = 0;
    this.messages.push(...msgs);
  }

  [Symbol.iterator](): Iterator<StashedMessage> {
    return this.messages[Symbol.iterator]();
  }
}
