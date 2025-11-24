import { ActorSystem } from './actor_system';

/**
 * A unique identifier for an actor.
 * - `systemId`: The ID of the system/node it belongs to.
 * - `id`: The unique ID of this specific actor instance.
 * - `name`: The optional, logical name for registered actors.
 */
export class ActorId {
  constructor(
    public readonly systemId: string,
    public readonly id: string,
    public readonly name?: string,
  ) {}

  toString(): string {
    return this.name ? `${this.systemId}/${this.name}` : `${this.systemId}/${this.id}`;
  }
}

/**
 * A reference to an actor, which can be used to send messages to it.
 * This is the public interface to an actor and is location-transparent.
 */
export class ActorRef {
  constructor(public readonly id: ActorId, private readonly system: ActorSystem) {}

  /**
   * Sends a 'call' message to the actor and waits for a reply.
   * @param message The message to send.
   * @param timeout The timeout in milliseconds.
   * @returns A promise that resolves with the reply from the actor.
   */
  call(message: any, timeout = 5000): Promise<any> {
    return this.system.dispatchCall(this.id, message, timeout);
  }

  /**
   * Sends a 'cast' message to the actor (fire-and-forget).
   * @param message The message to send.
   */
  cast(message: any): void {
    this.system.dispatchCast(this.id, message);
  }
}

/**
 * The base class for all actors.
 * Users should extend this class to create their own actors.
 */
export abstract class Actor {
  public self!: ActorRef;
  public context!: { parent?: ActorRef; children: Set<ActorRef> };

  /**
   * Called when the actor is started.
   * This is a good place to initialize state.
   */
  init(...args: any[]): void | Promise<void> {}

  /**
   * Called when the actor is gracefully terminated.
   */
  terminate(): void | Promise<void> {}

  /**
   * Handles 'call' messages, which require a reply.
   * @param message The incoming message.
   * @returns The reply.
   */
  handleCall(message: any): any | Promise<any> {
    throw new Error('handleCall not implemented');
  }

  /**
   * Handles 'cast' messages (fire-and-forget).
   * @param message The incoming message.
   */
  handleCast(message: any): void | Promise<void> {
    throw new Error('handleCast not implemented');
  }
}
