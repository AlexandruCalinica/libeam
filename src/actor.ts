import type { ActorSystem, SpawnOptions } from "./actor_system";

/**
 * Unique reference for a watch relationship.
 * Used to cancel a watch with unwatch().
 */
export class WatchRef {
  constructor(
    public readonly id: string,
    public readonly watcherId: string,
    public readonly watchedId: string,
  ) {}
}

/**
 * Reason for actor termination.
 */
export type TerminationReason =
  | { type: "normal" }
  | { type: "error"; error: any }
  | { type: "killed" };

/**
 * Message sent to watchers when a watched actor terminates.
 */
export interface DownMessage {
  type: "down";
  watchRef: WatchRef;
  actorRef: ActorRef;
  reason: TerminationReason;
}

/**
 * System info messages delivered to actors via handleInfo().
 */
export type InfoMessage = DownMessage;

/**
 * Strategy for supervising child actors.
 * - one-for-one: Only restart the crashed child
 * - one-for-all: Restart all children if one crashes
 * - rest-for-one: Restart the crashed child and all children spawned after it
 */
export type ChildSupervisionStrategy =
  | "one-for-one"
  | "one-for-all"
  | "rest-for-one";

/**
 * Options for child supervision.
 */
export interface ChildSupervisionOptions {
  /** Strategy for handling child crashes */
  strategy: ChildSupervisionStrategy;
  /** Maximum restarts allowed within the period */
  maxRestarts: number;
  /** Time period in ms for counting restarts */
  periodMs: number;
}

/**
 * Default child supervision options.
 */
export const DEFAULT_CHILD_SUPERVISION: ChildSupervisionOptions = {
  strategy: "one-for-one",
  maxRestarts: 3,
  periodMs: 5000,
};

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
    return this.name
      ? `${this.systemId}/${this.name}`
      : `${this.systemId}/${this.id}`;
  }
}

/**
 * A reference to an actor, which can be used to send messages to it.
 * This is the public interface to an actor and is location-transparent.
 *
 * Optionally typed for compile-time message type checking. When type parameters
 * are not specified, defaults to `any` for backwards compatibility.
 *
 * @template TCast The type of cast (fire-and-forget) messages this actor accepts (default: any)
 * @template TCall The type of call (request-reply) messages this actor accepts (default: any)
 * @template TReply The type of replies this actor returns for call messages (default: any)
 *
 * @example
 * ```typescript
 * // Untyped (backwards compatible)
 * const ref: ActorRef = system.spawn(MyActor);
 * ref.cast({ anything: "goes" });
 *
 * // Typed
 * const typedRef: ActorRef<MyCast, MyCall, MyReply> = system.spawn(MyTypedActor);
 * typedRef.cast({ type: "validMessage" });  // Type-checked!
 * ```
 */
export class ActorRef<TCast = any, TCall = any, TReply = any> {
  constructor(
    public readonly id: ActorId,
    private readonly system: ActorSystem,
  ) {}

  /**
   * Sends a 'call' message to the actor and waits for a reply.
   * @param message The message to send (type-checked if type parameters specified).
   * @param timeout The timeout in milliseconds.
   * @returns A promise that resolves with the reply from the actor.
   */
  call(message: TCall, timeout = 5000): Promise<TReply> {
    return this.system.dispatchCall(this.id, message, timeout);
  }

  /**
   * Sends a 'cast' message to the actor (fire-and-forget).
   * @param message The message to send (type-checked if type parameters specified).
   */
  cast(message: TCast): void {
    this.system.dispatchCast(this.id, message);
  }
}

/**
 * A stashed message with its type information.
 */
export interface StashedMessage {
  type: "cast" | "call";
  message: any;
  /** For call messages, the resolve/reject functions */
  resolve?: (value: any) => void;
  reject?: (error: any) => void;
}

/**
 * Context provided to an actor, containing references to parent and children.
 */
export interface ActorContext {
  /** Reference to the parent actor, if any */
  parent?: ActorRef;
  /** Set of child actor references */
  children: Set<ActorRef>;
  /** Ordered list of children (for rest-for-one strategy) */
  childOrder: ActorRef[];
  /** Reference to the actor system */
  system: ActorSystem;
  /** Active watches this actor has on other actors */
  watches: Map<string, WatchRef>;
  /** Stashed messages waiting to be processed later */
  stash: StashedMessage[];
  /** Current message being processed (set by system during dispatch) */
  currentMessage?: StashedMessage;
}

/**
 * The base class for all actors.
 * Users should extend this class to create their own actors.
 *
 * Optionally typed for compile-time message type checking. When type parameters
 * are not specified, defaults to `any` for backwards compatibility.
 *
 * @template TCast The type of cast (fire-and-forget) messages this actor accepts (default: any)
 * @template TCall The type of call (request-reply) messages this actor accepts (default: any)
 * @template TReply The type of replies this actor returns for call messages (default: any)
 *
 * @example
 * ```typescript
 * // Untyped actor (backwards compatible)
 * class MyActor extends Actor {
 *   handleCast(message: any) { ... }
 *   handleCall(message: any) { return ...; }
 * }
 *
 * // Typed actor with compile-time message checking
 * type MyCast = { type: "doSomething" } | { type: "doOther"; value: number };
 * type MyCall = { type: "query" };
 * type MyReply = string;
 *
 * class MyTypedActor extends Actor<MyCast, MyCall, MyReply> {
 *   handleCast(message: MyCast) {
 *     switch (message.type) {
 *       case "doSomething": ...; break;
 *       case "doOther": console.log(message.value); break;
 *     }
 *   }
 *   handleCall(message: MyCall): MyReply {
 *     return "result";
 *   }
 * }
 * ```
 */
export abstract class Actor<TCast = any, TCall = any, TReply = any> {
  public self!: ActorRef<TCast, TCall, TReply>;
  public context!: ActorContext;

  /**
   * Override this to define custom supervision options for child actors.
   * Defaults to one-for-one with 3 restarts in 5 seconds.
   */
  childSupervision(): ChildSupervisionOptions {
    return DEFAULT_CHILD_SUPERVISION;
  }

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
   * @param message The incoming message (type-checked if type parameters specified).
   * @returns The reply.
   */
  handleCall(message: TCall): TReply | Promise<TReply> {
    throw new Error("handleCall not implemented");
  }

  /**
   * Handles 'cast' messages (fire-and-forget).
   * @param message The incoming message (type-checked if type parameters specified).
   */
  handleCast(message: TCast): void | Promise<void> {
    throw new Error("handleCast not implemented");
  }

  /**
   * Handles system info messages (e.g., DOWN messages from watched actors).
   * Override this to react to actor terminations.
   * @param message The info message (e.g., DownMessage).
   */
  handleInfo(message: InfoMessage): void | Promise<void> {
    // Default: ignore info messages
  }

  /**
   * Start watching another actor for termination.
   * When the watched actor terminates, this actor will receive a DownMessage via handleInfo().
   * @param actorRef The actor to watch
   * @returns A WatchRef that can be used to cancel the watch
   */
  protected watch(actorRef: ActorRef): WatchRef {
    return this.context.system.watch(this.self, actorRef);
  }

  /**
   * Stop watching an actor.
   * @param watchRef The watch reference returned by watch()
   */
  protected unwatch(watchRef: WatchRef): void {
    this.context.system.unwatch(watchRef);
  }

  /**
   * Stash the current message for later processing.
   * Call this when the actor is not ready to handle a message yet.
   * Use unstashAll() to process stashed messages when ready.
   */
  protected stash(): void {
    if (this.context.currentMessage) {
      this.context.stash.push(this.context.currentMessage);
    }
  }

  /**
   * Unstash all stashed messages, prepending them to the mailbox.
   * Messages will be processed in the order they were originally received.
   */
  protected unstashAll(): void {
    if (this.context.stash.length > 0) {
      this.context.system.unstashAll(this.self, this.context.stash);
      this.context.stash = [];
    }
  }

  /**
   * Unstash just the oldest stashed message.
   */
  protected unstash(): void {
    if (this.context.stash.length > 0) {
      const message = this.context.stash.shift()!;
      this.context.system.unstashAll(this.self, [message]);
    }
  }

  /**
   * Clear all stashed messages without processing them.
   */
  protected clearStash(): void {
    // Reject any pending call messages
    for (const msg of this.context.stash) {
      if (msg.type === "call" && msg.reject) {
        msg.reject(new Error("Stashed message discarded"));
      }
    }
    this.context.stash = [];
  }

  /**
   * Spawns a child actor under this actor's supervision.
   * Returns a typed ActorRef if the child actor is typed.
   *
   * @param actorClass The actor class to spawn
   * @param options Spawn options (name, args, strategy)
   * @returns Reference to the spawned child actor (typed if actor class is typed)
   *
   * @example
   * ```typescript
   * // Spawning a typed child
   * const child = this.spawn(MyTypedActor);  // Returns ActorRef<ChildCast, ChildCall, ChildReply>
   * child.cast({ type: "validMessage" });    // Type-checked!
   * ```
   */
  protected spawn<T extends Actor>(
    actorClass: new () => T,
    options: Omit<SpawnOptions, "parent"> = {},
  ): ActorRef {
    return this.context.system.spawnChild(this.self, actorClass, options);
  }

  /**
   * Stops a child actor.
   * @param childRef Reference to the child actor to stop
   */
  protected stopChild(childRef: ActorRef): Promise<void> {
    return this.context.system.stop(childRef);
  }

  /**
   * Gets all children of this actor.
   */
  protected getChildren(): ActorRef[] {
    return Array.from(this.context.children);
  }
}
