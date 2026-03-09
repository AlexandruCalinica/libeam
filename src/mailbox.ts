import { StashedMessage } from "./actor.js";
import { MailboxFullError } from "./errors.js";

export type MailboxOverflowStrategy = "drop-newest" | "drop-oldest" | "error";

export interface MailboxConfig {
  /** Maximum number of messages. undefined = unbounded (default, backwards-compatible) */
  maxSize?: number;
  /** What to do when mailbox is full. Default: "drop-newest" */
  overflowStrategy?: MailboxOverflowStrategy;
}

export const DEFAULT_MAILBOX_CONFIG: MailboxConfig = {};

/**
 * Ring-buffer backed mailbox with O(1) enqueue and dequeue.
 *
 * The buffer grows dynamically (doubles) when full, avoiding the O(n)
 * cost of Array.shift() that dominated the previous implementation.
 * For bounded mailboxes, the ring never exceeds maxSize.
 */
export class BoundedMailbox {
  private readonly maxSize?: number;
  private readonly overflowStrategy: MailboxOverflowStrategy;
  private buf: (StashedMessage | undefined)[];
  private head = 0; // index of first element
  private tail = 0; // index of next write slot
  private size = 0;
  private droppedCount = 0;

  constructor(config: MailboxConfig = {}) {
    this.maxSize = config.maxSize;
    this.overflowStrategy = config.overflowStrategy ?? "drop-newest";
    // Start with a small power-of-2 buffer
    this.buf = new Array(16);
  }

  get length(): number {
    return this.size;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get isFull(): boolean {
    return this.maxSize !== undefined && this.size >= this.maxSize;
  }

  get capacity(): number | undefined {
    return this.maxSize;
  }

  enqueue(msg: StashedMessage): boolean {
    if (!this.isFull) {
      // Grow ring if internal buffer is full
      if (this.size === this.buf.length) {
        this.grow();
      }
      this.buf[this.tail] = msg;
      this.tail = (this.tail + 1) % this.buf.length;
      this.size++;
      return true;
    }

    this.droppedCount++;

    if (this.overflowStrategy === "drop-newest") {
      return false;
    }

    if (this.overflowStrategy === "drop-oldest") {
      // Drop head (oldest message)
      const dropped = this.buf[this.head];
      if (dropped?.type === "call" && dropped.reject) {
        dropped.reject(new MailboxFullError());
      }
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.buf.length;
      // Enqueue new message at tail
      this.buf[this.tail] = msg;
      this.tail = (this.tail + 1) % this.buf.length;
      // size stays the same
      return true;
    }

    throw new MailboxFullError();
  }

  dequeue(): StashedMessage | undefined {
    if (this.size === 0) return undefined;
    const msg = this.buf[this.head];
    this.buf[this.head] = undefined; // allow GC
    this.head = (this.head + 1) % this.buf.length;
    this.size--;
    return msg;
  }

  unshift(...msgs: StashedMessage[]): void {
    // Ensure enough space
    while (this.size + msgs.length > this.buf.length) {
      this.grow();
    }
    // Prepend by moving head backwards
    for (let i = msgs.length - 1; i >= 0; i--) {
      this.head = (this.head - 1 + this.buf.length) % this.buf.length;
      this.buf[this.head] = msgs[i];
      this.size++;
    }
  }

  clear(): void {
    // Allow GC of all references
    this.buf.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this.size = 0;
  }

  drain(): StashedMessage[] {
    const pending = this.toArray();
    this.clear();
    return pending;
  }

  toArray(): StashedMessage[] {
    const result: StashedMessage[] = new Array(this.size);
    for (let i = 0; i < this.size; i++) {
      result[i] = this.buf[(this.head + i) % this.buf.length]!;
    }
    return result;
  }

  replaceWith(msgs: StashedMessage[]): void {
    // Reset and bulk-load
    const needed = Math.max(16, nextPow2(msgs.length));
    if (this.buf.length < needed) {
      this.buf = new Array(needed);
    } else {
      this.buf.fill(undefined);
    }
    this.head = 0;
    this.tail = msgs.length;
    this.size = msgs.length;
    for (let i = 0; i < msgs.length; i++) {
      this.buf[i] = msgs[i];
    }
  }

  [Symbol.iterator](): Iterator<StashedMessage> {
    let idx = 0;
    const mailbox = this;
    return {
      next(): IteratorResult<StashedMessage> {
        if (idx < mailbox.size) {
          const value = mailbox.buf[(mailbox.head + idx) % mailbox.buf.length]!;
          idx++;
          return { value, done: false };
        }
        return { value: undefined as any, done: true };
      },
    };
  }

  /** Double the internal buffer, preserving element order. */
  private grow(): void {
    const oldLen = this.buf.length;
    const newLen = oldLen * 2;
    const newBuf: (StashedMessage | undefined)[] = new Array(newLen);
    for (let i = 0; i < this.size; i++) {
      newBuf[i] = this.buf[(this.head + i) % oldLen];
    }
    this.buf = newBuf;
    this.head = 0;
    this.tail = this.size;
  }
}

function nextPow2(n: number): number {
  let v = n - 1;
  v |= v >> 1;
  v |= v >> 2;
  v |= v >> 4;
  v |= v >> 8;
  v |= v >> 16;
  return v + 1;
}
