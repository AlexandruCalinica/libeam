// src/actor_system.ts

import {
  Actor,
  ActorId,
  ActorRef,
  WatchRef,
  TerminationReason,
  DownMessage,
  StashedMessage,
} from "./actor";
import { v4 as uuidv4 } from "uuid";
import { Supervisor, SupervisionOptions } from "./supervisor";
import { ChildSupervisor } from "./child_supervisor";
import { Transport } from "./transport";
import { Registry } from "./registry";
import { Cluster } from "./cluster";
import { PlacementEngine, PlacementStrategy } from "./placement";
import { Logger, createLogger } from "./logger";
import {
  ActorNotFoundError,
  ActorClassNotRegisteredError,
  RegistryLookupError,
  SystemShuttingDownError,
  TimeoutError,
} from "./errors";
import { HealthCheckable, ComponentHealth } from "./health";

type Mailbox = any[];

export interface SpawnOptions {
  name?: string;
  args?: any[];
  strategy?: PlacementStrategy;
}

export interface ShutdownOptions {
  /** Timeout in ms to wait for actors to terminate. Default: 5000 */
  timeout?: number;
  /** Whether to wait for mailboxes to drain before stopping. Default: true */
  drainMailboxes?: boolean;
}

interface ActorMetadata {
  actorClass: new () => Actor;
  options: SpawnOptions;
  /** Reference to parent actor, if this actor was spawned as a child */
  parent?: ActorRef;
}

/**
 * Information about an active watch relationship.
 */
interface WatchEntry {
  watchRef: WatchRef;
  watcherRef: ActorRef;
  watchedRef: ActorRef;
}

/**
 * Manages the lifecycle of all actors on a single node.
 */
export class ActorSystem implements HealthCheckable {
  readonly id: string;
  private readonly actors = new Map<string, Actor>();
  private readonly mailboxes = new Map<string, Mailbox>();
  private readonly actorMetadata = new Map<string, ActorMetadata>();
  private readonly actorClasses = new Map<string, new () => Actor>();
  /** Map from watchRef.id to WatchEntry */
  private readonly watches = new Map<string, WatchEntry>();
  /** Map from watched actor ID to set of watchRef IDs */
  private readonly watchedBy = new Map<string, Set<string>>();
  private readonly supervisor: Supervisor;
  private readonly childSupervisor: ChildSupervisor;
  private readonly transport: Transport;
  private readonly registry: Registry;
  private readonly placementEngine: PlacementEngine;
  private readonly log: Logger;
  private _isShuttingDown = false;
  private _isRunning = false;

  constructor(
    cluster: Cluster,
    transport: Transport,
    registry: Registry,
    supervisorOptions?: SupervisionOptions,
  ) {
    this.id = cluster.nodeId;
    this.transport = transport;
    this.registry = registry;
    this.placementEngine = new PlacementEngine(cluster);
    this.log = createLogger("ActorSystem", this.id);
    this.supervisor = new Supervisor(
      this,
      supervisorOptions || {
        strategy: "Restart",
        maxRestarts: 3,
        periodMs: 5000,
      },
    );
    this.childSupervisor = new ChildSupervisor(this);
  }

  async start(): Promise<void> {
    this.transport.onRequest(this._handleRpcCall.bind(this));
    this.transport.onMessage(this._handleRpcCast.bind(this));
    this._isRunning = true;
  }

  /**
   * Returns true if the system is currently running.
   */
  isRunning(): boolean {
    return this._isRunning && !this._isShuttingDown;
  }

  /**
   * Returns true if the system is in the process of shutting down.
   */
  isShuttingDown(): boolean {
    return this._isShuttingDown;
  }

  /**
   * Returns health status of the actor system.
   */
  getHealth(): ComponentHealth {
    const actorCount = this.actors.size;
    const totalMailboxSize = Array.from(this.mailboxes.values()).reduce(
      (sum, mb) => sum + mb.length,
      0,
    );

    if (!this._isRunning) {
      return {
        name: "ActorSystem",
        status: "unhealthy",
        message: "System is not running",
        details: { actorCount, totalMailboxSize },
      };
    }

    if (this._isShuttingDown) {
      return {
        name: "ActorSystem",
        status: "degraded",
        message: "System is shutting down",
        details: { actorCount, totalMailboxSize },
      };
    }

    // Consider degraded if mailbox is backing up significantly
    const status = totalMailboxSize > 1000 ? "degraded" : "healthy";
    const message =
      status === "degraded" ? "High mailbox backlog" : "System is healthy";

    return {
      name: "ActorSystem",
      status,
      message,
      details: {
        actorCount,
        totalMailboxSize,
        registeredClasses: this.actorClasses.size,
      },
    };
  }

  /**
   * Gracefully shuts down the actor system.
   * 1. Stops accepting new spawns and messages
   * 2. Optionally drains all mailboxes
   * 3. Terminates all actors
   * 4. Unregisters all actor names
   * @param options Shutdown options
   */
  async shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (this._isShuttingDown) {
      return; // Already shutting down
    }

    const { timeout = 5000, drainMailboxes = true } = options;
    this._isShuttingDown = true;

    // Wait for mailboxes to drain (with timeout)
    if (drainMailboxes) {
      await this._drainMailboxes(timeout);
    }

    // Stop all actors
    const actorIds = Array.from(this.actors.keys());
    const stopPromises = actorIds.map(async (id) => {
      const actor = this.actors.get(id);
      if (actor) {
        const metadata = this.actorMetadata.get(id);
        const name = metadata?.options.name;

        // Unregister name first
        if (name) {
          try {
            await this.registry.unregister(name);
          } catch (err) {
            // Ignore registry errors during shutdown
          }
        }

        // Terminate actor
        try {
          await Promise.race([
            Promise.resolve(actor.terminate()),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Terminate timeout")), timeout),
            ),
          ]);
        } catch (err) {
          // Actor failed to terminate gracefully, force cleanup
        }

        // Cleanup
        this.actors.delete(id);
        this.mailboxes.delete(id);
        this.actorMetadata.delete(id);
      }
    });

    await Promise.all(stopPromises);

    this._isRunning = false;
  }

  /**
   * Waits for all mailboxes to drain, with a timeout.
   */
  private async _drainMailboxes(timeout: number): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      let allEmpty = true;
      for (const mailbox of this.mailboxes.values()) {
        if (mailbox.length > 0) {
          allEmpty = false;
          break;
        }
      }

      if (allEmpty) {
        return;
      }

      // Wait a bit and check again
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Timeout reached, proceed anyway
  }

  /**
   * Registers an actor class for remote spawning.
   * Must be called on all nodes that may receive remote spawn requests.
   * @param actorClass The actor class to register
   * @param name Optional name override (defaults to actorClass.name)
   */
  registerActorClass<T extends Actor>(
    actorClass: new () => T,
    name?: string,
  ): void {
    const className = name || actorClass.name;
    this.actorClasses.set(className, actorClass);
  }

  /**
   * Registers multiple actor classes at once.
   * @param classes Array of actor classes to register
   */
  registerActorClasses(classes: Array<new () => Actor>): void {
    for (const actorClass of classes) {
      this.registerActorClass(actorClass);
    }
  }

  /**
   * Spawns an actor and returns a reference to it.
   * Returns a typed ActorRef when spawning a typed actor class.
   *
   * @template TCast The type of cast messages the actor accepts (default: any)
   * @template TCall The type of call messages the actor accepts (default: any)
   * @template TReply The type of replies the actor returns (default: any)
   * @template T The actor class type
   * @param actorClass The actor class to spawn
   * @param options Spawn options (name, args, strategy)
   * @returns A reference to the spawned actor (typed if actor class is typed)
   *
   * @example
   * ```typescript
   * // Untyped spawn (backwards compatible)
   * const ref = system.spawn(MyActor);
   * ref.cast({ anything: "goes" });
   *
   * // Typed spawn - type parameters inferred from actor class
   * const counter = system.spawn(CounterActor);
   * counter.cast({ type: "increment" });  // Type-checked!
   * const value = await counter.call({ type: "get" });  // Returns typed result
   * ```
   */
  spawn<T extends Actor>(
    actorClass: new () => T,
    options: SpawnOptions = {},
  ): ActorRef {
    if (this._isShuttingDown) {
      throw new SystemShuttingDownError("spawn actors");
    }

    const { name, args, strategy = "local" } = options;
    const targetNodeId = this.placementEngine.selectNode(strategy);

    const instanceId = uuidv4();
    const actorId = new ActorId(targetNodeId, instanceId, name);
    const actorRef = new ActorRef(actorId, this);

    if (targetNodeId === this.id) {
      // Local spawn
      const actor = new actorClass();
      actor.self = actorRef;
      actor.context = {
        children: new Set(),
        childOrder: [],
        system: this,
        watches: new Map(),
        stash: [],
      };

      this.actors.set(instanceId, actor);
      this.mailboxes.set(instanceId, []);
      this.actorMetadata.set(instanceId, { actorClass, options });

      if (name) {
        this.registry.register(name, this.id);
      }

      Promise.resolve(actor.init(...(args || []))).catch((err) => {
        this.supervisor.handleCrash(actorRef, err);
      });

      this.processMailbox(instanceId);
    } else {
      // Remote spawn is a fire-and-forget operation
      this.transport.send(targetNodeId, {
        type: "spawn",
        actorClassName: actorClass.name,
        actorId,
        options,
      });
    }

    return actorRef;
  }

  /**
   * Spawns a child actor under a parent actor's supervision.
   * The child will be automatically stopped when the parent is stopped.
   * @param parentRef Reference to the parent actor
   * @param actorClass The actor class to spawn
   * @param options Spawn options
   * @returns Reference to the spawned child actor
   */
  spawnChild<T extends Actor>(
    parentRef: ActorRef,
    actorClass: new () => T,
    options: SpawnOptions = {},
  ): ActorRef {
    if (this._isShuttingDown) {
      throw new SystemShuttingDownError("spawn child actors");
    }

    const parentId = parentRef.id.id;
    const parentActor = this.actors.get(parentId);

    if (!parentActor) {
      throw new ActorNotFoundError(parentId, this.id);
    }

    // Force local placement for child actors (same node as parent)
    const { name, args } = options;
    const instanceId = uuidv4();
    const actorId = new ActorId(this.id, instanceId, name);
    const actorRef = new ActorRef(actorId, this);

    // Create the child actor
    const actor = new actorClass();
    actor.self = actorRef;
    actor.context = {
      parent: parentRef,
      children: new Set(),
      childOrder: [],
      system: this,
      watches: new Map(),
      stash: [],
    };

    this.actors.set(instanceId, actor);
    this.mailboxes.set(instanceId, []);
    this.actorMetadata.set(instanceId, {
      actorClass,
      options,
      parent: parentRef,
    });

    // Add child to parent's children set and order list
    parentActor.context.children.add(actorRef);
    parentActor.context.childOrder.push(actorRef);

    if (name) {
      this.registry.register(name, this.id);
    }

    Promise.resolve(actor.init(...(args || []))).catch((err) => {
      this.supervisor.handleCrash(actorRef, err);
    });

    this.processMailbox(instanceId);

    this.log.debug("Spawned child actor", {
      childId: instanceId,
      parentId,
      name,
    });

    return actorRef;
  }

  getRef(actorId: ActorId): ActorRef {
    return new ActorRef(actorId, this);
  }

  /**
   * Gets the actor instance by its ID (internal use).
   */
  getActor(actorId: string): Actor | undefined {
    return this.actors.get(actorId);
  }

  /**
   * Gets the metadata for an actor.
   */
  getActorMetadata(actorId: string): ActorMetadata | undefined {
    return this.actorMetadata.get(actorId);
  }

  /**
   * Gets the child supervisor for handling child actor crashes.
   */
  getChildSupervisor(): ChildSupervisor {
    return this.childSupervisor;
  }

  /**
   * Start watching an actor for termination.
   * When the watched actor terminates, the watcher will receive a DownMessage via handleInfo().
   * @param watcherRef The actor that wants to watch
   * @param watchedRef The actor to watch
   * @returns A WatchRef that can be used to cancel the watch
   */
  watch(watcherRef: ActorRef, watchedRef: ActorRef): WatchRef {
    const watchRefId = uuidv4();
    const watchRef = new WatchRef(
      watchRefId,
      watcherRef.id.id,
      watchedRef.id.id,
    );

    const entry: WatchEntry = {
      watchRef,
      watcherRef,
      watchedRef,
    };

    // Store the watch
    this.watches.set(watchRefId, entry);

    // Track which actors are watching this actor
    let watchers = this.watchedBy.get(watchedRef.id.id);
    if (!watchers) {
      watchers = new Set();
      this.watchedBy.set(watchedRef.id.id, watchers);
    }
    watchers.add(watchRefId);

    // Store in watcher's context
    const watcherActor = this.actors.get(watcherRef.id.id);
    if (watcherActor) {
      watcherActor.context.watches.set(watchRefId, watchRef);
    }

    this.log.debug("Watch established", {
      watcherId: watcherRef.id.id,
      watchedId: watchedRef.id.id,
      watchRefId,
    });

    // If watched actor is already dead, send DOWN immediately
    if (!this.actors.has(watchedRef.id.id)) {
      this.sendDownMessage(watchRef, watchedRef, { type: "normal" });
    }

    return watchRef;
  }

  /**
   * Stop watching an actor.
   * @param watchRef The watch reference returned by watch()
   */
  unwatch(watchRef: WatchRef): void {
    const entry = this.watches.get(watchRef.id);
    if (!entry) {
      return; // Already unwatched or never existed
    }

    // Remove from watches map
    this.watches.delete(watchRef.id);

    // Remove from watchedBy map
    const watchers = this.watchedBy.get(watchRef.watchedId);
    if (watchers) {
      watchers.delete(watchRef.id);
      if (watchers.size === 0) {
        this.watchedBy.delete(watchRef.watchedId);
      }
    }

    // Remove from watcher's context
    const watcherActor = this.actors.get(watchRef.watcherId);
    if (watcherActor) {
      watcherActor.context.watches.delete(watchRef.id);
    }

    this.log.debug("Watch removed", {
      watcherId: watchRef.watcherId,
      watchedId: watchRef.watchedId,
      watchRefId: watchRef.id,
    });
  }

  /**
   * Notify all watchers that an actor has terminated.
   * Called internally when an actor stops or crashes.
   * @param actorRef The actor that terminated
   * @param reason The reason for termination
   */
  notifyWatchers(actorRef: ActorRef, reason: TerminationReason): void {
    const watchRefIds = this.watchedBy.get(actorRef.id.id);
    if (!watchRefIds || watchRefIds.size === 0) {
      return;
    }

    // Copy the set since we'll be modifying it during iteration
    const watchRefIdsCopy = Array.from(watchRefIds);

    for (const watchRefId of watchRefIdsCopy) {
      const entry = this.watches.get(watchRefId);
      if (entry) {
        this.sendDownMessage(entry.watchRef, actorRef, reason);
        // Clean up the watch (it's a one-shot notification)
        this.unwatch(entry.watchRef);
      }
    }
  }

  /**
   * Send a DOWN message to a watcher.
   */
  private sendDownMessage(
    watchRef: WatchRef,
    watchedRef: ActorRef,
    reason: TerminationReason,
  ): void {
    const watcherActor = this.actors.get(watchRef.watcherId);
    if (!watcherActor) {
      return; // Watcher is also gone
    }

    const downMessage: DownMessage = {
      type: "down",
      watchRef,
      actorRef: watchedRef,
      reason,
    };

    // Deliver via handleInfo asynchronously
    Promise.resolve(watcherActor.handleInfo(downMessage)).catch((err) => {
      this.log.error("Error in handleInfo for DOWN message", err, {
        watcherId: watchRef.watcherId,
        watchedId: watchRef.watchedId,
      });
    });
  }

  /**
   * (For testing) Gets the instance IDs of all local actors.
   */
  getLocalActorIds(): string[] {
    return Array.from(this.actors.keys());
  }

  /**
   * Prepend stashed messages to the front of an actor's mailbox.
   * Called by Actor.unstashAll() to reprocess deferred messages.
   * @param actorRef The actor whose mailbox to prepend to
   * @param messages The stashed messages to prepend
   */
  unstashAll(actorRef: ActorRef, messages: StashedMessage[]): void {
    const mailbox = this.mailboxes.get(actorRef.id.id);
    if (mailbox && messages.length > 0) {
      // Prepend messages to front of mailbox (preserving original order)
      mailbox.unshift(...messages);
      this.log.debug("Unstashed messages", {
        actorId: actorRef.id.id,
        count: messages.length,
      });
    }
  }

  async stop(actorRef: ActorRef): Promise<void> {
    const { id, name } = actorRef.id;
    const actor = this.actors.get(id);
    if (actor) {
      // Cascading termination: stop all children first
      const children = Array.from(actor.context.children);
      for (const childRef of children) {
        await this.stop(childRef);
      }

      // Remove this actor from parent's children set and order
      const metadata = this.actorMetadata.get(id);
      if (metadata?.parent) {
        const parentActor = this.actors.get(metadata.parent.id.id);
        if (parentActor) {
          parentActor.context.children.delete(actorRef);
          const orderIndex = parentActor.context.childOrder.findIndex(
            (ref) => ref.id.id === id,
          );
          if (orderIndex !== -1) {
            parentActor.context.childOrder.splice(orderIndex, 1);
          }
        }
      }

      // Clean up any watches this actor had on other actors
      for (const watchRef of actor.context.watches.values()) {
        this.unwatch(watchRef);
      }

      // Notify watchers of this actor's termination
      this.notifyWatchers(actorRef, { type: "normal" });

      if (name) {
        await this.registry.unregister(name);
      }
      await Promise.resolve(actor.terminate());
      this.actors.delete(id);
      this.mailboxes.delete(id);
      this.actorMetadata.delete(id);

      this.log.debug("Stopped actor", {
        actorId: id,
        childrenStopped: children.length,
      });
    }
  }

  /**
   * Restarts an actor using its stored metadata.
   * Called by the Supervisor when an actor crashes.
   * @param actorRef The actor to restart
   * @returns The new ActorRef, or null if restart failed
   */
  async restart(actorRef: ActorRef): Promise<ActorRef | null> {
    const { id } = actorRef.id;
    const metadata = this.actorMetadata.get(id);

    if (!metadata) {
      this.log.error("Cannot restart actor: no metadata found", undefined, {
        actorId: id,
      });
      return null;
    }

    // Stop the actor first (cleanup) - but don't cascade to children
    // The supervision strategy will determine what to do with children
    await this.stopSingle(actorRef);

    // Spawn a new instance with the same options
    let newRef: ActorRef;
    if (metadata.parent) {
      // Child actor - respawn under the same parent
      newRef = this.spawnChild(
        metadata.parent,
        metadata.actorClass,
        metadata.options,
      );
    } else {
      // Root actor - spawn normally
      newRef = this.spawn(metadata.actorClass, metadata.options);
    }

    return newRef;
  }

  /**
   * Stops a single actor without cascading to children.
   * Used internally during restarts.
   * @param notifyWatchers If true, notify watchers of termination (default: false for restarts)
   */
  async stopSingle(
    actorRef: ActorRef,
    notifyWatchers: boolean = false,
  ): Promise<void> {
    const { id, name } = actorRef.id;
    const actor = this.actors.get(id);
    if (actor) {
      // Remove this actor from parent's children set and order
      const metadata = this.actorMetadata.get(id);
      if (metadata?.parent) {
        const parentActor = this.actors.get(metadata.parent.id.id);
        if (parentActor) {
          parentActor.context.children.delete(actorRef);
          const orderIndex = parentActor.context.childOrder.findIndex(
            (ref) => ref.id.id === id,
          );
          if (orderIndex !== -1) {
            parentActor.context.childOrder.splice(orderIndex, 1);
          }
        }
      }

      // Clean up any watches this actor had on other actors
      for (const watchRef of actor.context.watches.values()) {
        this.unwatch(watchRef);
      }

      // Optionally notify watchers (typically not done for restarts)
      if (notifyWatchers) {
        this.notifyWatchers(actorRef, { type: "normal" });
      }

      if (name) {
        await this.registry.unregister(name);
      }
      await Promise.resolve(actor.terminate());
      this.actors.delete(id);
      this.mailboxes.delete(id);
      this.actorMetadata.delete(id);
    }
  }

  async dispatchCall(
    actorId: ActorId,
    message: any,
    timeout: number,
  ): Promise<any> {
    const { id, name, systemId } = actorId;

    // Reject calls during shutdown
    if (this._isShuttingDown) {
      throw new SystemShuttingDownError("make calls");
    }

    const nodeId = name ? await this.registry.lookup(name) : systemId;
    if (!nodeId) {
      const error = name
        ? new RegistryLookupError(name)
        : new ActorNotFoundError(id, systemId);
      this.log.warn("Failed to dispatch call", { actorId: id, name });
      throw error;
    }

    if (nodeId === this.id && this.actors.has(id)) {
      // Local actor - queue through mailbox so it can be stashed
      const mailbox = this.mailboxes.get(id);
      if (!mailbox) {
        throw new ActorNotFoundError(id, this.id);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new TimeoutError("actor call", timeout));
        }, timeout);

        const stashedMessage: StashedMessage = {
          type: "call",
          message,
          resolve: (result: any) => {
            clearTimeout(timer);
            resolve(result);
          },
          reject: (err: any) => {
            clearTimeout(timer);
            reject(err);
          },
        };

        mailbox.push(stashedMessage);
      });
    } else {
      // Remote actor
      return this.transport.request(nodeId, { actorId, message }, timeout);
    }
  }

  async dispatchCast(actorId: ActorId, message: any): Promise<void> {
    const { id, name, systemId } = actorId;

    const nodeId = name ? await this.registry.lookup(name) : systemId;
    if (!nodeId) {
      const error = name
        ? new RegistryLookupError(name)
        : new ActorNotFoundError(id, systemId);
      this.log.warn("Failed to dispatch cast", { actorId: id, name });
      throw error;
    }

    if (nodeId === this.id && this.actors.has(id)) {
      // Local actor
      const mailbox = this.mailboxes.get(id);
      if (mailbox) {
        mailbox.push({ type: "cast", message });
      }
    } else {
      // Remote actor
      await this.transport.send(nodeId, {
        type: "cast",
        actorId,
        message,
      });
    }
  }

  private async _handleRpcCall(rpcMessage: any): Promise<any> {
    const { actorId, message } = rpcMessage;
    const actor = this.actors.get(actorId.id);

    if (!actor) {
      throw new ActorNotFoundError(actorId.id, this.id);
    }
    return actor.handleCall(message);
  }

  private _handleRpcCast(rpcMessage: any): void {
    const { type, actorId, message } = rpcMessage;

    if (type === "spawn") {
      const className = rpcMessage.actorClassName;

      // First check the instance registry, then fall back to global (deprecated)
      let actorClass = this.actorClasses.get(className);
      if (!actorClass) {
        const globalClasses = (global as any).actorClasses || {};
        actorClass = globalClasses[className];
      }

      if (!actorClass) {
        this.log.error(
          "Actor class not registered for remote spawn",
          undefined,
          { className },
        );
        throw new ActorClassNotRegisteredError(className);
      }
      this.spawn(actorClass, rpcMessage.options);
      return;
    }

    if (type === "cast") {
      const actor = this.actors.get(actorId.id);
      if (!actor) {
        // Actor may not have been created yet, or was stopped.
        // This is fire-and-forget, so we log and drop it.
        this.log.debug("Cast message dropped: actor not found", {
          actorId: actorId.id,
        });
        return;
      }
      actor.handleCast(message);
    }
  }

  private async processMailbox(id: string): Promise<void> {
    const mailbox = this.mailboxes.get(id);
    const actor = this.actors.get(id);

    // If actor or mailbox no longer exists, stop processing
    if (!mailbox || !actor) return;

    if (mailbox.length > 0) {
      const stashedMessage = mailbox.shift() as StashedMessage;

      // Set current message so stash() knows what to stash
      actor.context.currentMessage = stashedMessage;

      try {
        if (stashedMessage.type === "cast") {
          await Promise.resolve(actor.handleCast(stashedMessage.message));
        } else if (stashedMessage.type === "call") {
          // Handle call message from mailbox (was stashed or queued)
          try {
            const result = await Promise.resolve(
              actor.handleCall(stashedMessage.message),
            );
            // Only resolve if the message wasn't re-stashed
            // (if it was stashed, it's now in actor.context.stash)
            const wasStashed = actor.context.stash.includes(stashedMessage);
            if (!wasStashed && stashedMessage.resolve) {
              stashedMessage.resolve(result);
            }
          } catch (err) {
            // Only reject if the message wasn't stashed
            const wasStashed = actor.context.stash.includes(stashedMessage);
            if (!wasStashed && stashedMessage.reject) {
              stashedMessage.reject(err);
            } else if (!wasStashed) {
              throw err; // Re-throw to trigger crash handling
            }
          }
        }
      } catch (err) {
        this.supervisor.handleCrash(actor.self, err);
      } finally {
        // Clear current message
        actor.context.currentMessage = undefined;
      }
    }

    // Only schedule next iteration if actor still exists
    if (this.actors.has(id) && this.mailboxes.has(id)) {
      setTimeout(() => this.processMailbox(id), 0);
    }
  }
}
