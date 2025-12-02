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
 * Unique reference for a timer.
 * Used to cancel a timer with cancelTimer().
 */
export class TimerRef {
  constructor(
    public readonly id: string,
    public readonly actorId: string,
    public readonly isInterval: boolean,
  ) {}
}

/**
 * Unique reference for a link between two actors.
 * Used to unlink actors with unlink().
 */
export class LinkRef {
  constructor(
    public readonly id: string,
    public readonly actor1Id: string,
    public readonly actor2Id: string,
  ) {}
}

/**
 * Internal timer entry for tracking active timers.
 */
export interface TimerEntry {
  ref: TimerRef;
  handle: NodeJS.Timeout;
  message: any;
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
 * Message sent to linked actors when a linked actor terminates.
 * If trapExit is false, the actor will crash. If true, it receives this message via handleInfo().
 */
export interface ExitMessage {
  type: "exit";
  linkRef: LinkRef;
  actorRef: ActorRef;
  reason: TerminationReason;
}

/**
 * System info messages delivered to actors via handleInfo().
 */
export type InfoMessage = DownMessage | ExitMessage;

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
 * Return type for init() that signals async continuation work.
 * @template T The type of data to pass to handleContinue()
 */
export interface InitContinue<T = any> {
  continue: T;
}

/**
 * Type guard to check if init returned a continue signal.
 */
export function isInitContinue(value: any): value is InitContinue {
  return value && typeof value === "object" && "continue" in value;
}

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
  /** Active links this actor has with other actors */
  links: Map<string, LinkRef>;
  /** Stashed messages waiting to be processed later */
  stash: StashedMessage[];
  /** Current message being processed (set by system during dispatch) */
  currentMessage?: StashedMessage;
  /** Active timers owned by this actor */
  timers: Map<string, TimerEntry>;
  /** Whether this actor traps exit signals from linked actors */
  trapExit: boolean;
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
   *
   * Can return `{ continue: data }` to trigger async post-initialization work.
   * The `handleContinue(data)` method will be called after init completes.
   *
   * @example
   * ```typescript
   * class MyActor extends Actor {
   *   init() {
   *     // Quick sync setup
   *     this.cache = new Map();
   *     // Signal that expensive async work should happen
   *     return { continue: { loadFromDb: true } };
   *   }
   *
   *   async handleContinue(data: { loadFromDb: boolean }) {
   *     // Expensive async initialization that doesn't block spawn
   *     if (data.loadFromDb) {
   *       await this.loadDataFromDatabase();
   *     }
   *   }
   * }
   * ```
   */
  init(...args: any[]): void | InitContinue | Promise<void | InitContinue> {}

  /**
   * Called after init() when init returns `{ continue: data }`.
   * Use this for expensive async initialization that shouldn't block spawn.
   *
   * @param continueData The data passed via `{ continue: data }` from init()
   */
  handleContinue(continueData: any): void | Promise<void> {}

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

  // ============ Link Methods ============

  /**
   * Create a bidirectional link with another actor.
   * When either actor terminates abnormally, the other will also terminate
   * (unless trapExit is enabled, in which case it receives an ExitMessage).
   *
   * @param actorRef The actor to link with
   * @returns A LinkRef that can be used to unlink
   *
   * @example
   * ```typescript
   * class WorkerManager extends Actor {
   *   init() {
   *     const worker = this.spawn(WorkerActor);
   *     this.link(worker);  // If worker crashes, manager crashes too
   *   }
   * }
   * ```
   */
  protected link(actorRef: ActorRef): LinkRef {
    return this.context.system.link(this.self, actorRef);
  }

  /**
   * Remove a link with another actor.
   * @param linkRef The link reference returned by link()
   */
  protected unlink(linkRef: LinkRef): void {
    this.context.system.unlink(linkRef);
  }

  /**
   * Enable or disable exit trapping.
   * When trapExit is true, exit signals from linked actors are delivered as
   * ExitMessage via handleInfo() instead of causing this actor to crash.
   *
   * @param trap Whether to trap exit signals
   *
   * @example
   * ```typescript
   * class Supervisor extends Actor {
   *   init() {
   *     this.setTrapExit(true);  // Handle exits gracefully
   *     const worker = this.spawn(WorkerActor);
   *     this.link(worker);
   *   }
   *
   *   handleInfo(message: InfoMessage) {
   *     if (message.type === "exit") {
   *       console.log("Worker crashed, restarting...");
   *       // Handle the exit gracefully
   *     }
   *   }
   * }
   * ```
   */
  protected setTrapExit(trap: boolean): void {
    this.context.trapExit = trap;
  }

  /**
   * Returns whether this actor is trapping exit signals.
   */
  protected isTrapExit(): boolean {
    return this.context.trapExit;
  }

  // ============ Stash Methods ============

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

  // ============ Timer Methods ============

  /**
   * Schedules a message to be sent to this actor after a delay.
   * The message will be delivered via handleCast().
   *
   * @param message The message to send
   * @param delayMs Delay in milliseconds
   * @returns A TimerRef that can be used to cancel the timer
   *
   * @example
   * ```typescript
   * class MyActor extends Actor {
   *   init() {
   *     // Send a tick message to self after 1 second
   *     this.sendAfter({ type: "tick" }, 1000);
   *   }
   *
   *   handleCast(message: any) {
   *     if (message.type === "tick") {
   *       console.log("Timer fired!");
   *     }
   *   }
   * }
   * ```
   */
  protected sendAfter(message: TCast, delayMs: number): TimerRef {
    return this.context.system.startActorTimer(
      this.self,
      message,
      delayMs,
      false,
    );
  }

  /**
   * Schedules a message to be sent to this actor repeatedly at an interval.
   * The message will be delivered via handleCast().
   *
   * @param message The message to send
   * @param intervalMs Interval in milliseconds
   * @returns A TimerRef that can be used to cancel the timer
   *
   * @example
   * ```typescript
   * class HeartbeatActor extends Actor {
   *   private intervalRef?: TimerRef;
   *
   *   init() {
   *     // Send heartbeat every 5 seconds
   *     this.intervalRef = this.sendInterval({ type: "heartbeat" }, 5000);
   *   }
   *
   *   handleCast(message: any) {
   *     if (message.type === "heartbeat") {
   *       console.log("Heartbeat!");
   *     }
   *   }
   * }
   * ```
   */
  protected sendInterval(message: TCast, intervalMs: number): TimerRef {
    return this.context.system.startActorTimer(
      this.self,
      message,
      intervalMs,
      true,
    );
  }

  /**
   * Cancels a timer previously started with sendAfter() or sendInterval().
   *
   * @param timerRef The timer reference returned by sendAfter() or sendInterval()
   * @returns true if the timer was cancelled, false if it wasn't found
   *
   * @example
   * ```typescript
   * class MyActor extends Actor {
   *   private timerRef?: TimerRef;
   *
   *   handleCast(message: any) {
   *     if (message.type === "start") {
   *       this.timerRef = this.sendAfter({ type: "timeout" }, 5000);
   *     } else if (message.type === "cancel") {
   *       if (this.timerRef) {
   *         this.cancelTimer(this.timerRef);
   *       }
   *     }
   *   }
   * }
   * ```
   */
  protected cancelTimer(timerRef: TimerRef): boolean {
    return this.context.system.cancelActorTimer(this.self, timerRef);
  }

  /**
   * Cancels all active timers for this actor.
   * Useful in terminate() or when resetting actor state.
   */
  protected cancelAllTimers(): void {
    this.context.system.cancelAllActorTimers(this.self);
  }
}
