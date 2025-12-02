// src/actor_system.ts

import {
  Actor,
  ActorId,
  ActorRef,
  WatchRef,
  LinkRef,
  TimerRef,
  TimerEntry,
  TerminationReason,
  DownMessage,
  ExitMessage,
  TimeoutMessage,
  StashedMessage,
  isInitContinue,
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
 * Information about an active link between two actors.
 */
interface LinkEntry {
  linkRef: LinkRef;
  actor1Ref: ActorRef;
  actor2Ref: ActorRef;
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
  /** Map from linkRef.id to LinkEntry */
  private readonly links = new Map<string, LinkEntry>();
  /** Map from actor ID to set of linkRef IDs */
  private readonly linkedWith = new Map<string, Set<string>>();
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
        links: new Map(),
        stash: [],
        timers: new Map(),
        trapExit: false,
        idleTimeout: 0,
        lastActivityTime: Date.now(),
      };

      this.actors.set(instanceId, actor);
      this.mailboxes.set(instanceId, []);
      this.actorMetadata.set(instanceId, { actorClass, options });

      if (name) {
        this.registry.register(name, this.id, instanceId);
      }

      Promise.resolve(actor.init(...(args || [])))
        .then((result) => {
          // Check if init returned a continue signal
          if (isInitContinue(result)) {
            return Promise.resolve(actor.handleContinue(result.continue));
          }
        })
        .catch((err) => {
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
      links: new Map(),
      stash: [],
      timers: new Map(),
      trapExit: false,
      idleTimeout: 0,
      lastActivityTime: Date.now(),
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
      this.registry.register(name, this.id, instanceId);
    }

    Promise.resolve(actor.init(...(args || [])))
      .then((result) => {
        // Check if init returned a continue signal
        if (isInitContinue(result)) {
          return Promise.resolve(actor.handleContinue(result.continue));
        }
      })
      .catch((err) => {
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
   * Gets an ActorRef by the actor's registered name.
   * This works for both local and remote actors - the registry is consulted
   * to find the actor's location.
   *
   * @param name The registered name of the actor
   * @returns An ActorRef that can be used to send messages, or null if not found
   *
   * @example
   * ```typescript
   * // On node1: spawn a named actor
   * node1.spawn(GreeterActor, { name: "greeter" });
   *
   * // On node2: get a reference to the remote actor
   * const greeterRef = await node2.getActorByName("greeter");
   * if (greeterRef) {
   *   const reply = await greeterRef.call({ type: "greet", name: "World" });
   * }
   * ```
   */
  async getActorByName(name: string): Promise<ActorRef | null> {
    const location = await this.registry.lookup(name);
    if (!location) {
      return null;
    }

    const actorId = new ActorId(location.nodeId, location.actorId, name);
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

  // ============ Link Management ============

  /**
   * Create a bidirectional link between two actors.
   * When one actor terminates abnormally, the other will also terminate
   * (unless it has trapExit enabled, in which case it receives an ExitMessage).
   * @param actor1Ref First actor
   * @param actor2Ref Second actor
   * @returns A LinkRef that can be used to unlink
   */
  link(actor1Ref: ActorRef, actor2Ref: ActorRef): LinkRef {
    const actor1Id = actor1Ref.id.id;
    const actor2Id = actor2Ref.id.id;

    const actor1 = this.actors.get(actor1Id);
    const actor2 = this.actors.get(actor2Id);

    if (!actor1) {
      throw new ActorNotFoundError(actor1Id, this.id);
    }
    if (!actor2) {
      throw new ActorNotFoundError(actor2Id, this.id);
    }

    const linkId = uuidv4();
    const linkRef = new LinkRef(linkId, actor1Id, actor2Id);

    const entry: LinkEntry = {
      linkRef,
      actor1Ref,
      actor2Ref,
    };

    // Store the link
    this.links.set(linkId, entry);

    // Add to linkedWith maps for both actors
    if (!this.linkedWith.has(actor1Id)) {
      this.linkedWith.set(actor1Id, new Set());
    }
    this.linkedWith.get(actor1Id)!.add(linkId);

    if (!this.linkedWith.has(actor2Id)) {
      this.linkedWith.set(actor2Id, new Set());
    }
    this.linkedWith.get(actor2Id)!.add(linkId);

    // Store in both actors' contexts
    actor1.context.links.set(linkId, linkRef);
    actor2.context.links.set(linkId, linkRef);

    this.log.debug("Link created", {
      actor1Id,
      actor2Id,
      linkRefId: linkId,
    });

    return linkRef;
  }

  /**
   * Remove a link between two actors.
   * @param linkRef The link reference returned by link()
   */
  unlink(linkRef: LinkRef): void {
    const entry = this.links.get(linkRef.id);
    if (!entry) {
      return; // Already unlinked or never existed
    }

    const actor1Id = linkRef.actor1Id;
    const actor2Id = linkRef.actor2Id;

    // Remove from links map
    this.links.delete(linkRef.id);

    // Remove from linkedWith maps
    const links1 = this.linkedWith.get(actor1Id);
    if (links1) {
      links1.delete(linkRef.id);
      if (links1.size === 0) {
        this.linkedWith.delete(actor1Id);
      }
    }

    const links2 = this.linkedWith.get(actor2Id);
    if (links2) {
      links2.delete(linkRef.id);
      if (links2.size === 0) {
        this.linkedWith.delete(actor2Id);
      }
    }

    // Remove from actors' contexts
    const actor1 = this.actors.get(actor1Id);
    if (actor1) {
      actor1.context.links.delete(linkRef.id);
    }

    const actor2 = this.actors.get(actor2Id);
    if (actor2) {
      actor2.context.links.delete(linkRef.id);
    }

    this.log.debug("Link removed", {
      actor1Id,
      actor2Id,
      linkRefId: linkRef.id,
    });
  }

  /**
   * Notify all linked actors that an actor has terminated.
   * Called internally when an actor stops or crashes.
   * If the linked actor has trapExit=true, it receives an ExitMessage.
   * Otherwise, the linked actor is also terminated.
   * @param actorRef The actor that terminated
   * @param reason The reason for termination
   */
  notifyLinkedActors(actorRef: ActorRef, reason: TerminationReason): void {
    const actorId = actorRef.id.id;
    const linkRefIds = this.linkedWith.get(actorId);

    if (!linkRefIds || linkRefIds.size === 0) {
      return;
    }

    // Copy the set since we'll be modifying it during iteration
    const linkRefIdsCopy = Array.from(linkRefIds);

    for (const linkRefId of linkRefIdsCopy) {
      const entry = this.links.get(linkRefId);
      if (entry) {
        // Find the other actor in the link
        const otherActorId =
          entry.actor1Ref.id.id === actorId
            ? entry.actor2Ref.id.id
            : entry.actor1Ref.id.id;
        const otherActorRef =
          entry.actor1Ref.id.id === actorId ? entry.actor2Ref : entry.actor1Ref;

        // Clean up the link BEFORE propagating crash to prevent infinite loops
        // When actor A crashes and notifies B, unlinking first ensures B's crash
        // won't try to notify the already-dead A
        this.unlink(entry.linkRef);

        const otherActor = this.actors.get(otherActorId);
        if (otherActor) {
          if (otherActor.context.trapExit) {
            // Actor is trapping exits - send ExitMessage via handleInfo
            this.sendExitMessage(entry.linkRef, actorRef, otherActor, reason);
          } else {
            // Actor is not trapping exits - terminate it
            // Only propagate if the original termination was abnormal
            if (reason.type === "error" || reason.type === "killed") {
              this.log.debug("Propagating exit to linked actor", {
                fromActorId: actorId,
                toActorId: otherActorId,
                reason: reason.type,
              });
              // Create a linked exit error
              const linkedError = new Error(
                `Linked actor ${actorId} terminated: ${reason.type}`,
              );
              this.supervisor.handleCrash(otherActorRef, linkedError);
            }
          }
        }
      }
    }
  }

  /**
   * Send an EXIT message to a linked actor that is trapping exits.
   */
  private sendExitMessage(
    linkRef: LinkRef | undefined,
    terminatedRef: ActorRef,
    targetActor: Actor,
    reason: TerminationReason,
  ): void {
    const exitMessage: ExitMessage = {
      type: "exit",
      linkRef,
      actorRef: terminatedRef,
      reason,
    };

    // Deliver via handleInfo asynchronously
    Promise.resolve(targetActor.handleInfo(exitMessage)).catch((err) => {
      this.log.error("Error in handleInfo for EXIT message", err, {
        targetActorId: targetActor.self.id.id,
        terminatedActorId: terminatedRef.id.id,
      });
    });
  }

  /**
   * Send an exit signal to another actor.
   *
   * If the target actor is trapping exits (trapExit=true), it receives an
   * ExitMessage via handleInfo(). Otherwise, the target actor terminates.
   *
   * Special reasons:
   * - "normal": No effect (actor continues running)
   * - "kill": Always terminates the target, even if trapping exits
   * - Other strings: Treated as error reasons
   *
   * @param senderRef The actor sending the exit signal
   * @param targetRef The actor to send the exit signal to
   * @param reason The reason for the exit
   */
  sendExit(senderRef: ActorRef, targetRef: ActorRef, reason: string): void {
    const targetId = targetRef.id.id;
    const targetActor = this.actors.get(targetId);

    if (!targetActor) {
      // Target doesn't exist, nothing to do
      return;
    }

    // "normal" exit signal has no effect (unlike link-based normal exits)
    if (reason === "normal") {
      this.log.debug("Normal exit signal ignored", {
        senderId: senderRef.id.id,
        targetId,
      });
      return;
    }

    // "kill" always terminates, even if trapping exits
    if (reason === "kill") {
      this.log.debug("Kill signal received", {
        senderId: senderRef.id.id,
        targetId,
      });
      // Force stop the actor
      this.stop(targetRef);
      return;
    }

    // Other reasons: check if target is trapping exits
    if (targetActor.context.trapExit) {
      // Deliver as ExitMessage via handleInfo
      const terminationReason: TerminationReason = { type: "killed" };
      this.sendExitMessage(
        undefined,
        senderRef,
        targetActor,
        terminationReason,
      );
      this.log.debug("Exit signal delivered as message", {
        senderId: senderRef.id.id,
        targetId,
        reason,
      });
    } else {
      // Terminate the target actor
      this.log.debug("Exit signal terminating actor", {
        senderId: senderRef.id.id,
        targetId,
        reason,
      });
      const error = new Error(`Exit signal from ${senderRef.id.id}: ${reason}`);
      this.supervisor.handleCrash(targetRef, error);
    }
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

  // ============ Timer Management ============

  /**
   * Starts a timer that sends a message to an actor after a delay.
   * Called internally by Actor.sendAfter() and Actor.sendInterval().
   * @param actorRef The actor to send the message to
   * @param message The message to send
   * @param delayMs Delay in milliseconds
   * @param isInterval If true, repeats at the interval; if false, fires once
   * @returns A TimerRef that can be used to cancel the timer
   */
  startActorTimer(
    actorRef: ActorRef,
    message: any,
    delayMs: number,
    isInterval: boolean,
  ): TimerRef {
    const actorId = actorRef.id.id;
    const actor = this.actors.get(actorId);

    if (!actor) {
      throw new ActorNotFoundError(actorId, this.id);
    }

    const timerId = uuidv4();
    const timerRef = new TimerRef(timerId, actorId, isInterval);

    const callback = () => {
      // Check if actor still exists before sending
      if (this.actors.has(actorId)) {
        this.dispatchCast(actorRef.id, message);

        // For one-shot timers, clean up after firing
        if (!isInterval) {
          actor.context.timers.delete(timerId);
        }
      } else {
        // Actor is gone, clean up the interval if it's still running
        if (isInterval) {
          const entry = actor.context.timers.get(timerId);
          if (entry) {
            clearInterval(entry.handle);
          }
        }
      }
    };

    const handle = isInterval
      ? setInterval(callback, delayMs)
      : setTimeout(callback, delayMs);

    const entry: TimerEntry = {
      ref: timerRef,
      handle,
      message,
    };

    actor.context.timers.set(timerId, entry);

    this.log.debug("Timer started", {
      actorId,
      timerId,
      delayMs,
      isInterval,
    });

    return timerRef;
  }

  /**
   * Cancels a timer for an actor.
   * Called internally by Actor.cancelTimer().
   * @param actorRef The actor that owns the timer
   * @param timerRef The timer to cancel
   * @returns true if the timer was cancelled, false if not found
   */
  cancelActorTimer(actorRef: ActorRef, timerRef: TimerRef): boolean {
    const actorId = actorRef.id.id;
    const actor = this.actors.get(actorId);

    if (!actor) {
      return false;
    }

    const entry = actor.context.timers.get(timerRef.id);
    if (!entry) {
      return false;
    }

    if (timerRef.isInterval) {
      clearInterval(entry.handle);
    } else {
      clearTimeout(entry.handle);
    }

    actor.context.timers.delete(timerRef.id);

    this.log.debug("Timer cancelled", {
      actorId,
      timerId: timerRef.id,
    });

    return true;
  }

  /**
   * Cancels all timers for an actor.
   * Called internally by Actor.cancelAllTimers() and during actor termination.
   * @param actorRef The actor whose timers to cancel
   */
  cancelAllActorTimers(actorRef: ActorRef): void {
    const actorId = actorRef.id.id;
    const actor = this.actors.get(actorId);

    if (!actor) {
      return;
    }

    for (const entry of actor.context.timers.values()) {
      if (entry.ref.isInterval) {
        clearInterval(entry.handle);
      } else {
        clearTimeout(entry.handle);
      }
    }

    const count = actor.context.timers.size;
    actor.context.timers.clear();

    if (count > 0) {
      this.log.debug("All timers cancelled", {
        actorId,
        count,
      });
    }
  }

  // ============ Idle Timeout Management ============

  /**
   * Sets the idle timeout for an actor.
   * When the actor hasn't received any messages for the specified duration,
   * it will receive a TimeoutMessage via handleInfo().
   * @param actorRef The actor to set the timeout for
   * @param timeoutMs Timeout in milliseconds (0 to disable)
   */
  setActorIdleTimeout(actorRef: ActorRef, timeoutMs: number): void {
    const actorId = actorRef.id.id;
    const actor = this.actors.get(actorId);

    if (!actor) {
      throw new ActorNotFoundError(actorId, this.id);
    }

    // Clear existing idle timeout if any
    if (actor.context.idleTimeoutHandle) {
      clearTimeout(actor.context.idleTimeoutHandle);
      actor.context.idleTimeoutHandle = undefined;
    }

    actor.context.idleTimeout = timeoutMs;

    if (timeoutMs > 0) {
      // Reset activity time and start the timeout
      actor.context.lastActivityTime = Date.now();
      this._scheduleIdleTimeout(actorId, actor);

      this.log.debug("Idle timeout set", {
        actorId,
        timeoutMs,
      });
    } else {
      this.log.debug("Idle timeout disabled", { actorId });
    }
  }

  /**
   * Schedules the idle timeout check for an actor.
   * Called internally after setting timeout or after processing a message.
   */
  private _scheduleIdleTimeout(actorId: string, actor: Actor): void {
    if (actor.context.idleTimeout <= 0) {
      return;
    }

    // Clear any existing timeout
    if (actor.context.idleTimeoutHandle) {
      clearTimeout(actor.context.idleTimeoutHandle);
    }

    actor.context.idleTimeoutHandle = setTimeout(() => {
      // Check if actor still exists
      if (!this.actors.has(actorId)) {
        return;
      }

      const now = Date.now();
      const idleMs = now - actor.context.lastActivityTime;

      // Double-check that we've actually been idle long enough
      // (in case activity happened but timeout wasn't cleared)
      if (idleMs >= actor.context.idleTimeout) {
        const timeoutMessage: TimeoutMessage = {
          type: "timeout",
          idleMs,
        };

        // Deliver via handleInfo
        Promise.resolve(actor.handleInfo(timeoutMessage)).catch((err) => {
          this.log.error("Error in handleInfo for timeout message", err, {
            actorId,
          });
        });

        // Reschedule for the next timeout period
        actor.context.lastActivityTime = now;
        this._scheduleIdleTimeout(actorId, actor);
      } else {
        // Activity happened since we scheduled, reschedule for remaining time
        const remainingMs = actor.context.idleTimeout - idleMs;
        actor.context.idleTimeoutHandle = setTimeout(() => {
          this._scheduleIdleTimeout(actorId, actor);
        }, remainingMs);
      }
    }, actor.context.idleTimeout);
  }

  /**
   * Resets the idle timeout for an actor (called when a message is processed).
   * Called internally by the mailbox processor.
   */
  private _resetIdleTimeout(actorId: string, actor: Actor): void {
    if (actor.context.idleTimeout <= 0) {
      return;
    }

    actor.context.lastActivityTime = Date.now();
    this._scheduleIdleTimeout(actorId, actor);
  }

  /**
   * Clears the idle timeout for an actor (called during actor termination).
   */
  private _clearIdleTimeout(actor: Actor): void {
    if (actor.context.idleTimeoutHandle) {
      clearTimeout(actor.context.idleTimeoutHandle);
      actor.context.idleTimeoutHandle = undefined;
    }
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

      // Cancel all active timers for this actor
      this.cancelAllActorTimers(actorRef);

      // Clear idle timeout
      this._clearIdleTimeout(actor);

      // Notify watchers of this actor's termination
      this.notifyWatchers(actorRef, { type: "normal" });

      // Notify linked actors (normal termination doesn't propagate crashes)
      // notifyLinkedActors handles unlinking internally
      this.notifyLinkedActors(actorRef, { type: "normal" });

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

      // Clean up any links this actor had with other actors
      for (const linkRef of actor.context.links.values()) {
        this.unlink(linkRef);
      }

      // Cancel all active timers for this actor
      this.cancelAllActorTimers(actorRef);

      // Clear idle timeout
      this._clearIdleTimeout(actor);

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

    const location = name ? await this.registry.lookup(name) : null;
    const nodeId = location?.nodeId ?? systemId;
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

    const location = name ? await this.registry.lookup(name) : null;
    const nodeId = location?.nodeId ?? systemId;
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

      // Reset idle timeout since we're processing a message
      this._resetIdleTimeout(id, actor);

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
