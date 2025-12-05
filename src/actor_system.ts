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
  HeartbeatManager,
  HeartbeatConfig,
  HeartbeatPing,
  DEFAULT_HEARTBEAT_CONFIG,
} from "./heartbeat";
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
 * Information about a remote actor watching a local actor.
 */
interface RemoteWatcherInfo {
  watchRefId: string;
  watcherNodeId: string;
  watcherActorId: string;
}

/**
 * Information about a local actor watching a remote actor.
 */
interface RemoteWatchEntry {
  watchRef: WatchRef;
  watcherRef: ActorRef;
  watchedNodeId: string;
  watchedActorId: string;
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
 * Information about a remote actor linked to a local actor.
 * Stored on the node where the remote actor lives.
 */
interface RemoteLinkerInfo {
  linkRefId: string;
  linkerNodeId: string;
  linkerActorId: string;
  /** Whether the remote linker has trapExit enabled */
  trapExit: boolean;
}

/**
 * Information about a local actor linked to a remote actor.
 * Stored on the node where the local actor lives.
 */
interface RemoteLinkEntry {
  linkRef: LinkRef;
  localActorRef: ActorRef;
  remoteNodeId: string;
  remoteActorId: string;
}

/**
 * Information about a child actor spawned on a remote node.
 * Stored on the parent's node.
 */
interface RemoteChildEntry {
  childRef: ActorRef;
  childNodeId: string;
  parentRef: ActorRef;
  actorClass: new () => Actor;
  options: SpawnOptions;
}

/**
 * Information about a remote parent supervising a local child.
 * Stored on the child's node.
 */
interface RemoteParentInfo {
  parentNodeId: string;
  parentActorId: string;
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
  /** Map from local watched actor ID to set of remote watchers */
  private readonly remoteWatchers = new Map<string, Set<RemoteWatcherInfo>>();
  /** Map from watchRefId to RemoteWatchEntry (local actor watching remote actor) */
  private readonly remoteWatches = new Map<string, RemoteWatchEntry>();
  /** Map from local actor ID to set of remote linkers (remote actors linked to this local actor) */
  private readonly remoteLinkers = new Map<string, Set<RemoteLinkerInfo>>();
  /** Map from linkRefId to RemoteLinkEntry (local actor linked to remote actor) */
  private readonly remoteLinks = new Map<string, RemoteLinkEntry>();
  /** Map from child instance ID to RemoteChildEntry (child on remote node) */
  private readonly remoteChildren = new Map<string, RemoteChildEntry>();
  /** Map from local child instance ID to RemoteParentInfo (parent on remote node) */
  private readonly remoteParents = new Map<string, RemoteParentInfo>();
  private readonly supervisor: Supervisor;
  private readonly childSupervisor: ChildSupervisor;
  private readonly transport: Transport;
  private readonly cluster: Cluster;
  private readonly registry: Registry;
  private readonly placementEngine: PlacementEngine;
  private readonly heartbeatManager: HeartbeatManager;
  private readonly log: Logger;
  private _isShuttingDown = false;
  private _isRunning = false;

  constructor(
    cluster: Cluster,
    transport: Transport,
    registry: Registry,
    supervisorOptions?: SupervisionOptions,
    heartbeatConfig?: Partial<HeartbeatConfig>,
  ) {
    this.id = cluster.nodeId;
    this.transport = transport;
    this.cluster = cluster;
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
    this.heartbeatManager = new HeartbeatManager(
      this.id,
      transport,
      cluster,
      heartbeatConfig,
    );

    // Wire up heartbeat failure detection
    this.heartbeatManager.on("node_failed", (nodeId: string) => {
      this.log.warn("Heartbeat detected node failure", { nodeId });
      this.handleNodeFailure(nodeId);
    });
  }

  async start(): Promise<void> {
    this.transport.onRequest(this._handleRpcCall.bind(this));
    this.transport.onMessage(this._handleRpcCast.bind(this));
    this._isRunning = true;

    // Start heartbeat manager for active failure detection
    await this.heartbeatManager.start();
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

    // Stop heartbeat manager first to prevent false failure detection during shutdown
    await this.heartbeatManager.stop();

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
   * Works for both local and remote actors.
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

    const watchedNodeId = watchedRef.id.systemId;
    const isRemoteWatch = watchedNodeId !== this.id;

    if (isRemoteWatch) {
      // Remote watch: send request to remote node
      return this._setupRemoteWatch(watchRef, watcherRef, watchedRef);
    }

    // Local watch (original logic)
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
   * Sets up a watch on a remote actor.
   * Sends an RPC to the remote node to register the watch.
   */
  private _setupRemoteWatch(
    watchRef: WatchRef,
    watcherRef: ActorRef,
    watchedRef: ActorRef,
  ): WatchRef {
    const watchedNodeId = watchedRef.id.systemId;
    const watchedActorId = watchedRef.id.id;

    // Store local tracking for remote watch
    const remoteEntry: RemoteWatchEntry = {
      watchRef,
      watcherRef,
      watchedNodeId,
      watchedActorId,
    };
    this.remoteWatches.set(watchRef.id, remoteEntry);

    // Store in watcher's context
    const watcherActor = this.actors.get(watcherRef.id.id);
    if (watcherActor) {
      watcherActor.context.watches.set(watchRef.id, watchRef);
    }

    this.log.debug("Setting up remote watch", {
      watcherId: watcherRef.id.id,
      watchedId: watchedActorId,
      watchedNodeId,
      watchRefId: watchRef.id,
    });

    // Send watch request to remote node (fire-and-forget with async response handling)
    this.transport
      .request(
        watchedNodeId,
        {
          type: "watch:add",
          watchRefId: watchRef.id,
          watcherNodeId: this.id,
          watcherActorId: watcherRef.id.id,
          watchedActorId,
        },
        5000,
      )
      .then((response: { success: boolean; alreadyDead?: boolean }) => {
        if (response.alreadyDead) {
          // Remote actor is already dead, send DOWN immediately
          this.log.debug("Remote watched actor already dead", {
            watchedActorId,
            watchedNodeId,
          });
          this._handleRemoteDown({
            type: "watch:down",
            watchRefId: watchRef.id,
            watchedActorId,
            reason: { type: "normal" },
          });
        }
      })
      .catch((err) => {
        // Remote node unreachable - treat as if actor is dead
        this.log.warn("Failed to setup remote watch, treating as dead", {
          watchedActorId,
          watchedNodeId,
          error: err.message,
        });
        this._handleRemoteDown({
          type: "watch:down",
          watchRefId: watchRef.id,
          watchedActorId,
          reason: { type: "error", error: err },
        });
      });

    return watchRef;
  }

  /**
   * Stop watching an actor.
   * Works for both local and remote watches.
   * @param watchRef The watch reference returned by watch()
   */
  unwatch(watchRef: WatchRef): void {
    // Check if this is a remote watch first
    const remoteEntry = this.remoteWatches.get(watchRef.id);
    if (remoteEntry) {
      this._unwatchRemote(watchRef, remoteEntry);
      return;
    }

    // Local watch
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
   * Removes a remote watch.
   */
  private _unwatchRemote(
    watchRef: WatchRef,
    remoteEntry: RemoteWatchEntry,
  ): void {
    // Remove local tracking
    this.remoteWatches.delete(watchRef.id);

    // Remove from watcher's context
    const watcherActor = this.actors.get(remoteEntry.watcherRef.id.id);
    if (watcherActor) {
      watcherActor.context.watches.delete(watchRef.id);
    }

    this.log.debug("Removing remote watch", {
      watcherId: remoteEntry.watcherRef.id.id,
      watchedId: remoteEntry.watchedActorId,
      watchedNodeId: remoteEntry.watchedNodeId,
      watchRefId: watchRef.id,
    });

    // Notify remote node to remove the watch (fire-and-forget)
    this.transport
      .send(remoteEntry.watchedNodeId, {
        type: "watch:remove",
        watchRefId: watchRef.id,
        watchedActorId: remoteEntry.watchedActorId,
      })
      .catch((err) => {
        // Ignore errors - remote node may be dead
        this.log.debug("Failed to notify remote node of unwatch", {
          error: err.message,
        });
      });
  }

  // ============ Link Management ============

  /**
   * Create a bidirectional link between two actors.
   * When one actor terminates abnormally, the other will also terminate
   * (unless it has trapExit enabled, in which case it receives an ExitMessage).
   * Works for both local and remote actors.
   * @param actor1Ref First actor (must be local)
   * @param actor2Ref Second actor (can be local or remote)
   * @returns A LinkRef that can be used to unlink
   */
  link(actor1Ref: ActorRef, actor2Ref: ActorRef): LinkRef {
    const actor1Id = actor1Ref.id.id;
    const actor2Id = actor2Ref.id.id;
    const actor1NodeId = actor1Ref.id.systemId;
    const actor2NodeId = actor2Ref.id.systemId;

    // Actor1 must be local (the linking actor)
    if (actor1NodeId !== this.id) {
      throw new Error(
        `Cannot link from remote actor ${actor1Id}@${actor1NodeId}. The first actor must be local.`,
      );
    }

    const actor1 = this.actors.get(actor1Id);
    if (!actor1) {
      throw new ActorNotFoundError(actor1Id, this.id);
    }

    // Check if actor2 is remote
    const isRemote = actor2NodeId !== this.id;

    if (isRemote) {
      return this._setupRemoteLink(actor1Ref, actor2Ref, actor1);
    }

    // Local link
    const actor2 = this.actors.get(actor2Id);
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
   * Sets up a link to a remote actor.
   * Sends an RPC to the remote node to register the link.
   */
  private _setupRemoteLink(
    localActorRef: ActorRef,
    remoteActorRef: ActorRef,
    localActor: Actor,
  ): LinkRef {
    const remoteNodeId = remoteActorRef.id.systemId;
    const remoteActorId = remoteActorRef.id.id;
    const localActorId = localActorRef.id.id;

    const linkId = uuidv4();
    const linkRef = new LinkRef(linkId, localActorId, remoteActorId);

    // Store local tracking for remote link
    const remoteEntry: RemoteLinkEntry = {
      linkRef,
      localActorRef,
      remoteNodeId,
      remoteActorId,
    };
    this.remoteLinks.set(linkRef.id, remoteEntry);

    // Add to linkedWith for the local actor
    if (!this.linkedWith.has(localActorId)) {
      this.linkedWith.set(localActorId, new Set());
    }
    this.linkedWith.get(localActorId)!.add(linkId);

    // Store in local actor's context
    localActor.context.links.set(linkId, linkRef);

    this.log.debug("Setting up remote link", {
      localActorId,
      remoteActorId,
      remoteNodeId,
      linkRefId: linkRef.id,
    });

    // Send link request to remote node (fire-and-forget with async response handling)
    this.transport
      .request(
        remoteNodeId,
        {
          type: "link:add",
          linkRefId: linkRef.id,
          linkerNodeId: this.id,
          linkerActorId: localActorId,
          linkedActorId: remoteActorId,
          trapExit: localActor.context.trapExit,
        },
        5000,
      )
      .then((response: { success: boolean; alreadyDead?: boolean }) => {
        if (response.alreadyDead) {
          // Remote actor is already dead, send exit signal
          this.log.debug("Remote linked actor already dead", {
            remoteActorId,
            remoteNodeId,
          });
          this._handleRemoteLinkExit({
            type: "link:exit",
            linkRefId: linkRef.id,
            exitedActorId: remoteActorId,
            reason: { type: "normal" },
          });
        }
      })
      .catch((err) => {
        // Remote node unreachable - treat as if actor is dead
        this.log.warn("Failed to setup remote link, treating as dead", {
          remoteActorId,
          remoteNodeId,
          error: err.message,
        });
        this._handleRemoteLinkExit({
          type: "link:exit",
          linkRefId: linkRef.id,
          exitedActorId: remoteActorId,
          reason: { type: "error", error: err },
        });
      });

    return linkRef;
  }

  /**
   * Remove a link between two actors.
   * Works for both local and remote links.
   * @param linkRef The link reference returned by link()
   */
  unlink(linkRef: LinkRef): void {
    // Check if this is a remote link first
    const remoteEntry = this.remoteLinks.get(linkRef.id);
    if (remoteEntry) {
      this._unlinkRemote(linkRef, remoteEntry);
      return;
    }

    // Local link
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
   * Removes a remote link.
   */
  private _unlinkRemote(linkRef: LinkRef, remoteEntry: RemoteLinkEntry): void {
    // Remove local tracking
    this.remoteLinks.delete(linkRef.id);

    // Remove from linkedWith for local actor
    const localActorId = remoteEntry.localActorRef.id.id;
    const links = this.linkedWith.get(localActorId);
    if (links) {
      links.delete(linkRef.id);
      if (links.size === 0) {
        this.linkedWith.delete(localActorId);
      }
    }

    // Remove from local actor's context
    const localActor = this.actors.get(localActorId);
    if (localActor) {
      localActor.context.links.delete(linkRef.id);
    }

    this.log.debug("Removing remote link", {
      localActorId,
      remoteActorId: remoteEntry.remoteActorId,
      remoteNodeId: remoteEntry.remoteNodeId,
      linkRefId: linkRef.id,
    });

    // Send unlink request to remote node (fire-and-forget)
    this.transport.send(remoteEntry.remoteNodeId, {
      type: "link:remove",
      linkRefId: linkRef.id,
      linkedActorId: remoteEntry.remoteActorId,
    });
  }

  /**
   * Notify all linked actors that an actor has terminated.
   * Called internally when an actor stops or crashes.
   * If the linked actor has trapExit=true, it receives an ExitMessage.
   * Otherwise, the linked actor is also terminated.
   * Works for both local and remote links.
   * @param actorRef The actor that terminated
   * @param reason The reason for termination
   */
  notifyLinkedActors(actorRef: ActorRef, reason: TerminationReason): void {
    const actorId = actorRef.id.id;

    // Notify local linked actors
    this._notifyLocalLinkedActors(actorRef, actorId, reason);

    // Notify remote linked actors (actors on other nodes linked to this one)
    this._notifyRemoteLinkers(actorId, reason);
  }

  /**
   * Notify local actors linked to the terminated actor.
   */
  private _notifyLocalLinkedActors(
    actorRef: ActorRef,
    actorId: string,
    reason: TerminationReason,
  ): void {
    const linkRefIds = this.linkedWith.get(actorId);

    if (!linkRefIds || linkRefIds.size === 0) {
      return;
    }

    // Copy the set since we'll be modifying it during iteration
    const linkRefIdsCopy = Array.from(linkRefIds);

    for (const linkRefId of linkRefIdsCopy) {
      // Check for local link
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
        continue;
      }

      // Check for remote link (this local actor linked to a remote actor)
      const remoteEntry = this.remoteLinks.get(linkRefId);
      if (remoteEntry) {
        // Clean up and notify remote node
        this._notifyRemoteLinkExit(remoteEntry, actorId, reason);
      }
    }
  }

  /**
   * Notify remote nodes that a local actor they linked to has terminated.
   */
  private _notifyRemoteLinkers(
    actorId: string,
    reason: TerminationReason,
  ): void {
    const remoteLinkerSet = this.remoteLinkers.get(actorId);
    if (!remoteLinkerSet || remoteLinkerSet.size === 0) {
      return;
    }

    // Copy since we'll be modifying
    const remoteLinkersCopy = Array.from(remoteLinkerSet);

    for (const remoteLinker of remoteLinkersCopy) {
      this._notifyRemoteLinker(remoteLinker, actorId, reason);

      // Clean up
      remoteLinkerSet.delete(remoteLinker);
    }

    if (remoteLinkerSet.size === 0) {
      this.remoteLinkers.delete(actorId);
    }
  }

  /**
   * Send exit notification to a remote linker.
   */
  private _notifyRemoteLinker(
    remoteLinker: RemoteLinkerInfo,
    exitedActorId: string,
    reason: TerminationReason,
  ): void {
    this.log.debug("Notifying remote linker of actor exit", {
      linkerNodeId: remoteLinker.linkerNodeId,
      linkerActorId: remoteLinker.linkerActorId,
      exitedActorId,
      reason: reason.type,
    });

    // Serialize the reason for transport
    const serializedReason =
      reason.type === "error"
        ? { type: "error", errorMessage: reason.error?.message || "Unknown" }
        : reason;

    this.transport.send(remoteLinker.linkerNodeId, {
      type: "link:exit",
      linkRefId: remoteLinker.linkRefId,
      exitedActorId,
      reason: serializedReason,
    });
  }

  /**
   * Notify remote node that local actor linked to remote actor has exited.
   * Also cleans up local tracking.
   */
  private _notifyRemoteLinkExit(
    remoteEntry: RemoteLinkEntry,
    exitedActorId: string,
    reason: TerminationReason,
  ): void {
    // Clean up local tracking
    this.remoteLinks.delete(remoteEntry.linkRef.id);

    // Remove from linkedWith
    const links = this.linkedWith.get(exitedActorId);
    if (links) {
      links.delete(remoteEntry.linkRef.id);
      if (links.size === 0) {
        this.linkedWith.delete(exitedActorId);
      }
    }

    this.log.debug("Notifying remote node of local linker exit", {
      localActorId: exitedActorId,
      remoteActorId: remoteEntry.remoteActorId,
      remoteNodeId: remoteEntry.remoteNodeId,
      reason: reason.type,
    });

    // Serialize the reason for transport
    const serializedReason =
      reason.type === "error"
        ? { type: "error", errorMessage: reason.error?.message || "Unknown" }
        : reason;

    // Send exit notification to remote node
    this.transport.send(remoteEntry.remoteNodeId, {
      type: "link:exit",
      linkRefId: remoteEntry.linkRef.id,
      exitedActorId,
      reason: serializedReason,
    });
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
   * Notify all watchers (local and remote) that an actor has terminated.
   * Called internally when an actor stops or crashes.
   * @param actorRef The actor that terminated
   * @param reason The reason for termination
   */
  notifyWatchers(actorRef: ActorRef, reason: TerminationReason): void {
    const actorId = actorRef.id.id;

    // Notify local watchers
    const watchRefIds = this.watchedBy.get(actorId);
    if (watchRefIds && watchRefIds.size > 0) {
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

    // Notify remote watchers
    const remoteWatcherSet = this.remoteWatchers.get(actorId);
    if (remoteWatcherSet && remoteWatcherSet.size > 0) {
      // Copy since we'll be modifying during iteration
      const remoteWatchersCopy = Array.from(remoteWatcherSet);

      for (const remoteWatcher of remoteWatchersCopy) {
        this._notifyRemoteWatcher(remoteWatcher, actorId, reason);
        // Clean up remote watcher entry
        remoteWatcherSet.delete(remoteWatcher);
      }

      if (remoteWatcherSet.size === 0) {
        this.remoteWatchers.delete(actorId);
      }
    }
  }

  /**
   * Sends a DOWN notification to a remote watcher.
   */
  private _notifyRemoteWatcher(
    remoteWatcher: RemoteWatcherInfo,
    watchedActorId: string,
    reason: TerminationReason,
  ): void {
    this.log.debug("Notifying remote watcher of actor death", {
      watcherNodeId: remoteWatcher.watcherNodeId,
      watcherActorId: remoteWatcher.watcherActorId,
      watchedActorId,
      reason: reason.type,
    });

    // Send DOWN notification to remote node (fire-and-forget)
    this.transport
      .send(remoteWatcher.watcherNodeId, {
        type: "watch:down",
        watchRefId: remoteWatcher.watchRefId,
        watchedActorId,
        reason: this._serializeTerminationReason(reason),
      })
      .catch((err) => {
        // Ignore errors - remote node may be dead
        this.log.debug("Failed to notify remote watcher", {
          watcherNodeId: remoteWatcher.watcherNodeId,
          error: err.message,
        });
      });
  }

  /**
   * Serializes a TerminationReason for transport (errors aren't serializable).
   */
  private _serializeTerminationReason(reason: TerminationReason): any {
    if (reason.type === "error" && reason.error) {
      return {
        type: "error",
        errorMessage: reason.error.message || String(reason.error),
      };
    }
    return reason;
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
      // Cascading termination: stop all children first (both local and remote)
      const children = Array.from(actor.context.children);
      for (const childRef of children) {
        if (childRef.id.systemId === this.id) {
          // Local child - stop directly
          await this.stop(childRef);
        } else {
          // Remote child - stop via RPC
          await this.stopRemoteChild(childRef.id.id);
        }
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
    // Handle heartbeat:ping RPC
    if (rpcMessage.type === "heartbeat:ping") {
      return this.heartbeatManager.handlePing(rpcMessage as HeartbeatPing);
    }

    // Handle watch:add RPC
    if (rpcMessage.type === "watch:add") {
      return this._handleRemoteWatchAdd(rpcMessage);
    }

    // Handle link:add RPC
    if (rpcMessage.type === "link:add") {
      return this._handleRemoteLinkAdd(rpcMessage);
    }

    // Handle child:spawn RPC
    if (rpcMessage.type === "child:spawn") {
      return this._handleRemoteChildSpawn(rpcMessage);
    }

    // Handle child:restart RPC
    if (rpcMessage.type === "child:restart") {
      return this._handleRemoteChildRestart(rpcMessage);
    }

    // Handle child:stop RPC
    if (rpcMessage.type === "child:stop") {
      return this._handleRemoteChildStop(rpcMessage);
    }

    // Handle actor call
    const { actorId, message } = rpcMessage;
    const actor = this.actors.get(actorId.id);

    if (!actor) {
      throw new ActorNotFoundError(actorId.id, this.id);
    }
    return actor.handleCall(message);
  }

  /**
   * Handles a remote watch registration request.
   * Called when another node wants to watch a local actor.
   */
  private _handleRemoteWatchAdd(request: {
    type: "watch:add";
    watchRefId: string;
    watcherNodeId: string;
    watcherActorId: string;
    watchedActorId: string;
  }): { success: boolean; alreadyDead?: boolean } {
    const { watchRefId, watcherNodeId, watcherActorId, watchedActorId } =
      request;

    this.log.debug("Received remote watch request", {
      watcherNodeId,
      watcherActorId,
      watchedActorId,
      watchRefId,
    });

    // Check if the watched actor exists
    const watchedActor = this.actors.get(watchedActorId);
    if (!watchedActor) {
      // Actor is already dead
      return { success: true, alreadyDead: true };
    }

    // Store the remote watcher
    let watcherSet = this.remoteWatchers.get(watchedActorId);
    if (!watcherSet) {
      watcherSet = new Set();
      this.remoteWatchers.set(watchedActorId, watcherSet);
    }

    const watcherInfo: RemoteWatcherInfo = {
      watchRefId,
      watcherNodeId,
      watcherActorId,
    };
    watcherSet.add(watcherInfo);

    return { success: true };
  }

  /**
   * Handles a remote watch removal request.
   * Called when another node cancels their watch on a local actor.
   */
  private _handleRemoteWatchRemove(request: {
    type: "watch:remove";
    watchRefId: string;
    watchedActorId: string;
  }): void {
    const { watchRefId, watchedActorId } = request;

    this.log.debug("Received remote watch removal", {
      watchedActorId,
      watchRefId,
    });

    const watcherSet = this.remoteWatchers.get(watchedActorId);
    if (!watcherSet) {
      return;
    }

    // Find and remove the watcher entry
    for (const watcher of watcherSet) {
      if (watcher.watchRefId === watchRefId) {
        watcherSet.delete(watcher);
        break;
      }
    }

    if (watcherSet.size === 0) {
      this.remoteWatchers.delete(watchedActorId);
    }
  }

  /**
   * Handles a DOWN notification from a remote node.
   * Called when a remote actor that we were watching has died.
   */
  private _handleRemoteDown(notification: {
    type: "watch:down";
    watchRefId: string;
    watchedActorId: string;
    reason: any;
  }): void {
    const { watchRefId, watchedActorId, reason } = notification;

    this.log.debug("Received remote DOWN notification", {
      watchedActorId,
      watchRefId,
      reason: reason?.type || reason,
    });

    // Find the remote watch entry
    const remoteEntry = this.remoteWatches.get(watchRefId);
    if (!remoteEntry) {
      // Watch was already removed or never existed
      return;
    }

    // Remove the remote watch tracking
    this.remoteWatches.delete(watchRefId);

    // Remove from watcher's context
    const watcherActor = this.actors.get(remoteEntry.watcherRef.id.id);
    if (!watcherActor) {
      // Watcher actor is also gone
      return;
    }

    watcherActor.context.watches.delete(watchRefId);

    // Deserialize the termination reason
    const terminationReason: TerminationReason =
      this._deserializeTerminationReason(reason);

    // Create a pseudo ActorRef for the dead remote actor
    const watchedActorRef = new ActorRef(
      new ActorId(remoteEntry.watchedNodeId, watchedActorId, undefined),
      this,
    );

    // Send DOWN message to the watcher
    const downMessage: DownMessage = {
      type: "down",
      watchRef: remoteEntry.watchRef,
      actorRef: watchedActorRef,
      reason: terminationReason,
    };

    // Deliver via handleInfo asynchronously
    Promise.resolve(watcherActor.handleInfo(downMessage)).catch((err) => {
      this.log.error("Error in handleInfo for remote DOWN message", err, {
        watcherId: remoteEntry.watcherRef.id.id,
        watchedId: watchedActorId,
      });
    });
  }

  /**
   * Deserializes a TerminationReason from transport.
   */
  private _deserializeTerminationReason(reason: any): TerminationReason {
    if (reason?.type === "error" && reason.errorMessage) {
      return {
        type: "error",
        error: new Error(reason.errorMessage),
      };
    }
    return reason as TerminationReason;
  }

  /**
   * Handles a remote link registration request.
   * Called when another node wants to link to a local actor.
   */
  private _handleRemoteLinkAdd(request: {
    type: "link:add";
    linkRefId: string;
    linkerNodeId: string;
    linkerActorId: string;
    linkedActorId: string;
    trapExit: boolean;
  }): { success: boolean; alreadyDead?: boolean } {
    const { linkRefId, linkerNodeId, linkerActorId, linkedActorId, trapExit } =
      request;

    this.log.debug("Received remote link request", {
      linkerNodeId,
      linkerActorId,
      linkedActorId,
      linkRefId,
      trapExit,
    });

    // Check if the linked actor exists
    const linkedActor = this.actors.get(linkedActorId);
    if (!linkedActor) {
      // Actor is already dead
      return { success: true, alreadyDead: true };
    }

    // Store the remote linker
    let linkerSet = this.remoteLinkers.get(linkedActorId);
    if (!linkerSet) {
      linkerSet = new Set();
      this.remoteLinkers.set(linkedActorId, linkerSet);
    }

    const linkerInfo: RemoteLinkerInfo = {
      linkRefId,
      linkerNodeId,
      linkerActorId,
      trapExit,
    };
    linkerSet.add(linkerInfo);

    return { success: true };
  }

  /**
   * Handles a remote link removal request.
   * Called when another node cancels their link to a local actor.
   */
  private _handleRemoteLinkRemove(request: {
    type: "link:remove";
    linkRefId: string;
    linkedActorId: string;
  }): void {
    const { linkRefId, linkedActorId } = request;

    this.log.debug("Received remote link removal", {
      linkedActorId,
      linkRefId,
    });

    const linkerSet = this.remoteLinkers.get(linkedActorId);
    if (!linkerSet) {
      return;
    }

    // Find and remove the linker entry
    for (const linker of linkerSet) {
      if (linker.linkRefId === linkRefId) {
        linkerSet.delete(linker);
        break;
      }
    }

    if (linkerSet.size === 0) {
      this.remoteLinkers.delete(linkedActorId);
    }
  }

  /**
   * Handles an exit notification from a remote node.
   * Called when a remote actor that we were linked to has exited.
   */
  private _handleRemoteLinkExit(notification: {
    type: "link:exit";
    linkRefId: string;
    exitedActorId: string;
    reason: any;
  }): void {
    const { linkRefId, exitedActorId, reason } = notification;

    this.log.debug("Received remote link exit notification", {
      exitedActorId,
      linkRefId,
      reason: reason?.type || reason,
    });

    // Find the remote link entry
    const remoteEntry = this.remoteLinks.get(linkRefId);
    if (!remoteEntry) {
      // Link was already removed or never existed
      return;
    }

    // Remove the remote link tracking
    this.remoteLinks.delete(linkRefId);

    // Remove from linkedWith
    const localActorId = remoteEntry.localActorRef.id.id;
    const links = this.linkedWith.get(localActorId);
    if (links) {
      links.delete(linkRefId);
      if (links.size === 0) {
        this.linkedWith.delete(localActorId);
      }
    }

    // Get the local actor
    const localActor = this.actors.get(localActorId);
    if (!localActor) {
      // Local actor is also gone
      return;
    }

    // Remove from actor's context
    localActor.context.links.delete(linkRefId);

    // Deserialize the termination reason
    const terminationReason: TerminationReason =
      this._deserializeTerminationReason(reason);

    // Create a pseudo ActorRef for the dead remote actor
    const exitedActorRef = new ActorRef(
      new ActorId(remoteEntry.remoteNodeId, exitedActorId, undefined),
      this,
    );

    // Create a pseudo LinkRef for the exit message
    const linkRef = new LinkRef(linkRefId, localActorId, exitedActorId);

    if (localActor.context.trapExit) {
      // Actor is trapping exits - send ExitMessage via handleInfo
      const exitMessage: ExitMessage = {
        type: "exit",
        linkRef,
        actorRef: exitedActorRef,
        reason: terminationReason,
      };

      // Deliver via handleInfo asynchronously
      Promise.resolve(localActor.handleInfo(exitMessage)).catch((err) => {
        this.log.error("Error in handleInfo for remote EXIT message", err, {
          localActorId,
          exitedActorId,
        });
      });
    } else {
      // Actor is not trapping exits - terminate it if reason is abnormal
      if (
        terminationReason.type === "error" ||
        terminationReason.type === "killed"
      ) {
        this.log.debug("Propagating remote exit to local actor", {
          fromActorId: exitedActorId,
          toActorId: localActorId,
          reason: terminationReason.type,
        });
        // Create a linked exit error
        const linkedError = new Error(
          `Linked remote actor ${exitedActorId} terminated: ${terminationReason.type}`,
        );
        this.supervisor.handleCrash(remoteEntry.localActorRef, linkedError);
      }
    }
  }

  // ==================== Remote Child Supervision ====================

  /**
   * Handles a remote child spawn request.
   * Called when another node wants to spawn a supervised child on this node.
   */
  private _handleRemoteChildSpawn(request: {
    type: "child:spawn";
    childInstanceId: string;
    actorClassName: string;
    options: SpawnOptions;
    parentNodeId: string;
    parentActorId: string;
  }): { success: boolean; childActorId?: string; error?: string } {
    const {
      childInstanceId,
      actorClassName,
      options,
      parentNodeId,
      parentActorId,
    } = request;

    this.log.debug("Received remote child spawn request", {
      childInstanceId,
      actorClassName,
      parentNodeId,
      parentActorId,
    });

    // Look up the actor class
    let actorClass = this.actorClasses.get(actorClassName);
    if (!actorClass) {
      const globalClasses = (global as any).actorClasses || {};
      actorClass = globalClasses[actorClassName];
    }

    if (!actorClass) {
      this.log.error(
        "Actor class not registered for remote child spawn",
        undefined,
        {
          actorClassName,
        },
      );
      return {
        success: false,
        error: `Actor class not registered: ${actorClassName}`,
      };
    }

    try {
      // Create the child actor with the pre-generated instance ID
      const { name, args } = options;
      const actorId = new ActorId(this.id, childInstanceId, name);
      const actorRef = new ActorRef(actorId, this);

      const actor = new actorClass();
      actor.self = actorRef;
      actor.context = {
        parent: undefined, // No local parent
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

      this.actors.set(childInstanceId, actor);
      this.mailboxes.set(childInstanceId, []);
      this.actorMetadata.set(childInstanceId, {
        actorClass,
        options,
        parent: undefined, // Remote parent tracked separately
      });

      // Store remote parent info
      this.remoteParents.set(childInstanceId, {
        parentNodeId,
        parentActorId,
      });

      if (name) {
        this.registry.register(name, this.id, childInstanceId);
      }

      // Initialize the actor
      Promise.resolve(actor.init(...(args || [])))
        .then((result) => {
          if (isInitContinue(result)) {
            return Promise.resolve(actor.handleContinue(result.continue));
          }
        })
        .catch((err) => {
          // Remote child crashed during init - will be handled by crash notification
          this.supervisor.handleCrash(actorRef, err);
        });

      this.processMailbox(childInstanceId);

      this.log.debug("Remote child spawned successfully", {
        childInstanceId,
        actorClassName,
        parentNodeId,
      });

      return { success: true, childActorId: childInstanceId };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log.error(
        "Failed to spawn remote child",
        err instanceof Error ? err : undefined,
        {
          childInstanceId,
          actorClassName,
        },
      );
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handles a remote child restart request.
   * Called when parent's node requests a restart of a child on this node.
   */
  private async _handleRemoteChildRestart(request: {
    type: "child:restart";
    oldChildInstanceId: string;
    newChildInstanceId: string;
    parentNodeId: string;
    parentActorId: string;
  }): Promise<{ success: boolean; newChildActorId?: string; error?: string }> {
    const {
      oldChildInstanceId,
      newChildInstanceId,
      parentNodeId,
      parentActorId,
    } = request;

    this.log.debug("Received remote child restart request", {
      oldChildInstanceId,
      newChildInstanceId,
      parentNodeId,
    });

    // Get the metadata for the old child
    const metadata = this.actorMetadata.get(oldChildInstanceId);
    if (!metadata) {
      return {
        success: false,
        error: `Child metadata not found: ${oldChildInstanceId}`,
      };
    }

    // Stop the old child (if still running)
    const oldActor = this.actors.get(oldChildInstanceId);
    if (oldActor) {
      const oldRef = new ActorRef(
        new ActorId(this.id, oldChildInstanceId, metadata.options.name),
        this,
      );
      await this.stop(oldRef);
    }

    // Clean up old remote parent tracking
    this.remoteParents.delete(oldChildInstanceId);

    // Spawn the new child using the same class and options
    const result = this._handleRemoteChildSpawn({
      type: "child:spawn",
      childInstanceId: newChildInstanceId,
      actorClassName: metadata.actorClass.name,
      options: metadata.options,
      parentNodeId,
      parentActorId,
    });

    if (result.success) {
      this.log.info("Remote child restarted successfully", {
        oldChildInstanceId,
        newChildInstanceId,
      });
    }

    return {
      success: result.success,
      newChildActorId: result.childActorId,
      error: result.error,
    };
  }

  /**
   * Handles a remote child stop request.
   * Called when parent's node requests stopping a child on this node.
   */
  private async _handleRemoteChildStop(request: {
    type: "child:stop";
    childInstanceId: string;
    parentNodeId: string;
    parentActorId: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { childInstanceId, parentNodeId } = request;

    this.log.debug("Received remote child stop request", {
      childInstanceId,
      parentNodeId,
    });

    const actor = this.actors.get(childInstanceId);
    if (!actor) {
      // Already stopped
      this.remoteParents.delete(childInstanceId);
      return { success: true };
    }

    try {
      const metadata = this.actorMetadata.get(childInstanceId);
      const actorRef = new ActorRef(
        new ActorId(this.id, childInstanceId, metadata?.options.name),
        this,
      );

      // Clean up remote parent tracking before stopping
      this.remoteParents.delete(childInstanceId);

      await this.stop(actorRef);

      this.log.debug("Remote child stopped successfully", { childInstanceId });
      return { success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log.error(
        "Failed to stop remote child",
        err instanceof Error ? err : undefined,
        {
          childInstanceId,
        },
      );
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handles a crash notification for a remote child.
   * Called when a child on a remote node has crashed and the parent is on this node.
   */
  private _handleRemoteChildCrash(notification: {
    type: "child:crash";
    childInstanceId: string;
    childNodeId: string;
    parentActorId: string;
    reason: TerminationReason;
    errorMessage?: string;
  }): void {
    const {
      childInstanceId,
      childNodeId,
      parentActorId,
      reason,
      errorMessage,
    } = notification;

    this.log.debug("Received remote child crash notification", {
      childInstanceId,
      childNodeId,
      parentActorId,
      reason: reason?.type,
    });

    // Find the remote child entry
    const remoteChild = this.remoteChildren.get(childInstanceId);
    if (!remoteChild) {
      this.log.warn("Remote child entry not found for crash notification", {
        childInstanceId,
      });
      return;
    }

    // Delegate to child supervisor for handling
    this.childSupervisor.handleRemoteChildCrash(
      remoteChild,
      reason,
      errorMessage,
    );
  }

  /**
   * Notifies the remote parent that a child has crashed.
   * Called from supervisor when a child with a remote parent crashes.
   */
  notifyRemoteParentOfCrash(
    childInstanceId: string,
    reason: TerminationReason,
    errorMessage?: string,
  ): void {
    const remoteParent = this.remoteParents.get(childInstanceId);
    if (!remoteParent) {
      return;
    }

    this.log.debug("Notifying remote parent of child crash", {
      childInstanceId,
      parentNodeId: remoteParent.parentNodeId,
      parentActorId: remoteParent.parentActorId,
    });

    this.transport.send(remoteParent.parentNodeId, {
      type: "child:crash",
      childInstanceId,
      childNodeId: this.id,
      parentActorId: remoteParent.parentActorId,
      reason,
      errorMessage,
    });
  }

  /**
   * Checks if a child has a remote parent.
   */
  hasRemoteParent(childInstanceId: string): boolean {
    return this.remoteParents.has(childInstanceId);
  }

  /**
   * Gets the remote child entry for a child instance ID.
   */
  getRemoteChild(childInstanceId: string): RemoteChildEntry | undefined {
    return this.remoteChildren.get(childInstanceId);
  }

  /**
   * Spawns a child actor on a remote node.
   * @param parentRef Reference to the local parent actor
   * @param actorClass The actor class to spawn
   * @param targetNodeId The node where the child should be spawned
   * @param options Spawn options
   * @returns Reference to the spawned remote child, or null if spawn failed
   */
  async spawnChildRemote<T extends Actor>(
    parentRef: ActorRef,
    actorClass: new () => T,
    targetNodeId: string,
    options: SpawnOptions = {},
  ): Promise<ActorRef | null> {
    if (this._isShuttingDown) {
      throw new SystemShuttingDownError("spawn remote child actors");
    }

    const parentId = parentRef.id.id;
    const parentActor = this.actors.get(parentId);

    if (!parentActor) {
      throw new ActorNotFoundError(parentId, this.id);
    }

    // Generate instance ID locally
    const childInstanceId = uuidv4();

    this.log.debug("Spawning remote child", {
      parentId,
      targetNodeId,
      actorClassName: actorClass.name,
      childInstanceId,
    });

    try {
      // Send spawn request to target node
      const response = await this.transport.request(
        targetNodeId,
        {
          type: "child:spawn",
          childInstanceId,
          actorClassName: actorClass.name,
          options,
          parentNodeId: this.id,
          parentActorId: parentId,
        },
        5000, // 5 second timeout
      );

      if (!response.success) {
        this.log.error("Remote child spawn failed", undefined, {
          childInstanceId,
          error: response.error,
        });
        return null;
      }

      // Create a reference to the remote child
      const childActorId = new ActorId(
        targetNodeId,
        childInstanceId,
        options.name,
      );
      const childRef = new ActorRef(childActorId, this);

      // Store remote child entry
      this.remoteChildren.set(childInstanceId, {
        childRef,
        childNodeId: targetNodeId,
        parentRef,
        actorClass,
        options,
      });

      // Add to parent's children set and order
      parentActor.context.children.add(childRef);
      parentActor.context.childOrder.push(childRef);

      this.log.debug("Remote child spawned successfully", {
        parentId,
        childInstanceId,
        targetNodeId,
      });

      return childRef;
    } catch (err) {
      this.log.error(
        "Failed to spawn remote child",
        err instanceof Error ? err : undefined,
        {
          parentId,
          targetNodeId,
          actorClassName: actorClass.name,
        },
      );
      return null;
    }
  }

  /**
   * Restarts a remote child actor.
   * Called by ChildSupervisor when applying supervision strategies.
   */
  async restartRemoteChild(
    remoteChild: RemoteChildEntry,
  ): Promise<ActorRef | null> {
    const { childRef, childNodeId, parentRef, actorClass, options } =
      remoteChild;
    const oldChildInstanceId = childRef.id.id;
    const newChildInstanceId = uuidv4();

    this.log.debug("Restarting remote child", {
      oldChildInstanceId,
      newChildInstanceId,
      childNodeId,
    });

    try {
      // Send restart request to target node
      const response = await this.transport.request(
        childNodeId,
        {
          type: "child:restart",
          oldChildInstanceId,
          newChildInstanceId,
          parentNodeId: this.id,
          parentActorId: parentRef.id.id,
        },
        5000, // 5 second timeout
      );

      if (!response.success) {
        this.log.error("Remote child restart failed", undefined, {
          oldChildInstanceId,
          error: response.error,
        });
        // Clean up the old entry
        this.remoteChildren.delete(oldChildInstanceId);
        return null;
      }

      // Create new reference
      const newChildActorId = new ActorId(
        childNodeId,
        newChildInstanceId,
        options.name,
      );
      const newChildRef = new ActorRef(newChildActorId, this);

      // Update remote child entry
      this.remoteChildren.delete(oldChildInstanceId);
      this.remoteChildren.set(newChildInstanceId, {
        childRef: newChildRef,
        childNodeId,
        parentRef,
        actorClass,
        options,
      });

      // Update parent's children tracking
      const parentActor = this.actors.get(parentRef.id.id);
      if (parentActor) {
        // Remove old ref
        parentActor.context.children.delete(childRef);
        const oldIndex = parentActor.context.childOrder.findIndex(
          (ref) => ref.id.id === oldChildInstanceId,
        );
        if (oldIndex !== -1) {
          parentActor.context.childOrder.splice(oldIndex, 1);
        }

        // Add new ref at the same position
        parentActor.context.children.add(newChildRef);
        if (oldIndex !== -1) {
          parentActor.context.childOrder.splice(oldIndex, 0, newChildRef);
        } else {
          parentActor.context.childOrder.push(newChildRef);
        }
      }

      this.log.info("Remote child restarted", {
        oldChildInstanceId,
        newChildInstanceId,
        childNodeId,
      });

      return newChildRef;
    } catch (err) {
      this.log.error(
        "Failed to restart remote child",
        err instanceof Error ? err : undefined,
        {
          oldChildInstanceId,
          childNodeId,
        },
      );
      // Clean up tracking on failure
      this.remoteChildren.delete(oldChildInstanceId);
      return null;
    }
  }

  /**
   * Stops a remote child actor.
   * Called by ChildSupervisor when applying supervision strategies.
   */
  async stopRemoteChild(childInstanceId: string): Promise<boolean> {
    const remoteChild = this.remoteChildren.get(childInstanceId);
    if (!remoteChild) {
      this.log.warn("Remote child not found for stop", { childInstanceId });
      return false;
    }

    const { childRef, childNodeId, parentRef } = remoteChild;

    this.log.debug("Stopping remote child", {
      childInstanceId,
      childNodeId,
    });

    try {
      // Send stop request to target node
      const response = await this.transport.request(
        childNodeId,
        {
          type: "child:stop",
          childInstanceId,
          parentNodeId: this.id,
          parentActorId: parentRef.id.id,
        },
        5000, // 5 second timeout
      );

      // Clean up tracking regardless of response
      this.remoteChildren.delete(childInstanceId);

      // Remove from parent's children
      const parentActor = this.actors.get(parentRef.id.id);
      if (parentActor) {
        parentActor.context.children.delete(childRef);
        const index = parentActor.context.childOrder.findIndex(
          (ref) => ref.id.id === childInstanceId,
        );
        if (index !== -1) {
          parentActor.context.childOrder.splice(index, 1);
        }
      }

      if (!response.success) {
        this.log.warn("Remote child stop returned error", {
          childInstanceId,
          error: response.error,
        });
      }

      this.log.debug("Remote child stopped", { childInstanceId });
      return true;
    } catch (err) {
      this.log.error(
        "Failed to stop remote child",
        err instanceof Error ? err : undefined,
        {
          childInstanceId,
          childNodeId,
        },
      );
      // Clean up tracking on failure (child may have already stopped)
      this.remoteChildren.delete(childInstanceId);
      return false;
    }
  }

  /**
   * Removes a remote child from tracking without sending stop request.
   * Used when child has exceeded max restarts.
   */
  removeRemoteChild(childInstanceId: string, parentRef: ActorRef): void {
    const remoteChild = this.remoteChildren.get(childInstanceId);
    if (!remoteChild) {
      return;
    }

    this.log.debug("Removing remote child from tracking", {
      childInstanceId,
      parentId: parentRef.id.id,
    });

    // Clean up tracking
    this.remoteChildren.delete(childInstanceId);

    // Remove from parent's children
    const parentActor = this.actors.get(parentRef.id.id);
    if (parentActor) {
      parentActor.context.children.delete(remoteChild.childRef);
      const index = parentActor.context.childOrder.findIndex(
        (ref) => ref.id.id === childInstanceId,
      );
      if (index !== -1) {
        parentActor.context.childOrder.splice(index, 1);
      }
    }
  }

  /**
   * Called when a remote node has left the cluster (crashed or graceful shutdown).
   * Notifies all local actors that were watching actors on the dead node.
   *
   * This should be wired up to the membership layer's 'member_leave' event:
   * ```typescript
   * membership.on('member_leave', (nodeId) => system.handleNodeFailure(nodeId));
   * ```
   *
   * @param deadNodeId The ID of the node that has left the cluster
   */
  handleNodeFailure(deadNodeId: string): void {
    this.log.info("Handling node failure", { deadNodeId });

    // Handle remote watches
    this._handleNodeFailureForWatches(deadNodeId);

    // Handle remote links
    this._handleNodeFailureForLinks(deadNodeId);

    // Handle remote children (children on the dead node)
    this._handleNodeFailureForRemoteChildren(deadNodeId);

    // Handle orphaned children (children whose parent was on the dead node)
    this._handleNodeFailureForOrphanedChildren(deadNodeId);

    this.log.debug("Node failure handling complete", { deadNodeId });
  }

  /**
   * Handle node failure for remote watches.
   */
  private _handleNodeFailureForWatches(deadNodeId: string): void {
    // Find all remote watches pointing to the dead node
    const watchesToNotify: RemoteWatchEntry[] = [];

    for (const [watchRefId, entry] of this.remoteWatches.entries()) {
      if (entry.watchedNodeId === deadNodeId) {
        watchesToNotify.push(entry);
      }
    }

    if (watchesToNotify.length > 0) {
      this.log.info("Notifying watchers of node failure", {
        deadNodeId,
        watchCount: watchesToNotify.length,
      });

      // Send DOWN messages for all watches to the dead node
      for (const entry of watchesToNotify) {
        // Remove from remoteWatches
        this.remoteWatches.delete(entry.watchRef.id);

        // Remove from watcher's context
        const watcherActor = this.actors.get(entry.watcherRef.id.id);
        if (!watcherActor) {
          continue;
        }

        watcherActor.context.watches.delete(entry.watchRef.id);

        // Create a pseudo ActorRef for the dead remote actor
        const watchedActorRef = new ActorRef(
          new ActorId(entry.watchedNodeId, entry.watchedActorId, undefined),
          this,
        );

        // Send DOWN message with 'noconnection' reason
        const downMessage: DownMessage = {
          type: "down",
          watchRef: entry.watchRef,
          actorRef: watchedActorRef,
          reason: { type: "killed" }, // Node failure is treated as killed
        };

        // Deliver via handleInfo asynchronously
        Promise.resolve(watcherActor.handleInfo(downMessage)).catch((err) => {
          this.log.error(
            "Error in handleInfo for node failure DOWN message",
            err,
            {
              watcherId: entry.watcherRef.id.id,
              watchedId: entry.watchedActorId,
              deadNodeId,
            },
          );
        });
      }
    }

    // Also clean up any remote watchers from the dead node
    // (they were watching our local actors, but can't receive notifications anymore)
    for (const [actorId, watcherSet] of this.remoteWatchers.entries()) {
      const toRemove: RemoteWatcherInfo[] = [];
      for (const watcher of watcherSet) {
        if (watcher.watcherNodeId === deadNodeId) {
          toRemove.push(watcher);
        }
      }
      for (const watcher of toRemove) {
        watcherSet.delete(watcher);
      }
      if (watcherSet.size === 0) {
        this.remoteWatchers.delete(actorId);
      }
    }
  }

  /**
   * Handle node failure for remote links.
   */
  private _handleNodeFailureForLinks(deadNodeId: string): void {
    // Find all remote links pointing to the dead node
    const linksToNotify: RemoteLinkEntry[] = [];

    for (const [linkRefId, entry] of this.remoteLinks.entries()) {
      if (entry.remoteNodeId === deadNodeId) {
        linksToNotify.push(entry);
      }
    }

    if (linksToNotify.length > 0) {
      this.log.info("Notifying linked actors of node failure", {
        deadNodeId,
        linkCount: linksToNotify.length,
      });

      // Send exit signals for all links to the dead node
      for (const entry of linksToNotify) {
        // Handle as if we received a link:exit message
        this._handleRemoteLinkExit({
          type: "link:exit",
          linkRefId: entry.linkRef.id,
          exitedActorId: entry.remoteActorId,
          reason: { type: "killed" }, // Node failure is treated as killed
        });
      }
    }

    // Also clean up any remote linkers from the dead node
    // (they were linked to our local actors, but can't receive notifications anymore)
    for (const [actorId, linkerSet] of this.remoteLinkers.entries()) {
      const toRemove: RemoteLinkerInfo[] = [];
      for (const linker of linkerSet) {
        if (linker.linkerNodeId === deadNodeId) {
          toRemove.push(linker);
        }
      }
      for (const linker of toRemove) {
        linkerSet.delete(linker);
      }
      if (linkerSet.size === 0) {
        this.remoteLinkers.delete(actorId);
      }
    }
  }

  /**
   * Handle node failure for remote children.
   * When a node dies, all children hosted on that node are considered dead.
   */
  private _handleNodeFailureForRemoteChildren(deadNodeId: string): void {
    // Find all remote children on the dead node
    const childrenToHandle: RemoteChildEntry[] = [];

    for (const [childInstanceId, entry] of this.remoteChildren.entries()) {
      if (entry.childNodeId === deadNodeId) {
        childrenToHandle.push(entry);
      }
    }

    if (childrenToHandle.length > 0) {
      this.log.info("Handling remote children on failed node", {
        deadNodeId,
        childCount: childrenToHandle.length,
      });

      // Treat each child as if it crashed
      for (const entry of childrenToHandle) {
        // Handle as if we received a child:crash message
        this._handleRemoteChildCrash({
          type: "child:crash",
          childInstanceId: entry.childRef.id.id,
          childNodeId: deadNodeId,
          parentActorId: entry.parentRef.id.id,
          reason: { type: "killed" }, // Node failure is treated as killed
        });
      }
    }
  }

  /**
   * Handle node failure for orphaned children.
   * When a parent's node dies, children on this node become orphaned.
   */
  private _handleNodeFailureForOrphanedChildren(deadNodeId: string): void {
    // Find all local children whose remote parent was on the dead node
    const orphanedChildren: string[] = [];

    for (const [childInstanceId, parentInfo] of this.remoteParents.entries()) {
      if (parentInfo.parentNodeId === deadNodeId) {
        orphanedChildren.push(childInstanceId);
      }
    }

    if (orphanedChildren.length > 0) {
      this.log.info("Stopping orphaned children after parent node failure", {
        deadNodeId,
        orphanCount: orphanedChildren.length,
      });

      // Stop all orphaned children
      for (const childInstanceId of orphanedChildren) {
        // Clean up remote parent tracking
        this.remoteParents.delete(childInstanceId);

        // Stop the orphaned child
        const actor = this.actors.get(childInstanceId);
        if (actor) {
          const metadata = this.actorMetadata.get(childInstanceId);
          const childRef = new ActorRef(
            new ActorId(this.id, childInstanceId, metadata?.options.name),
            this,
          );

          this.log.debug("Stopping orphaned child", {
            childInstanceId,
            parentNodeId: deadNodeId,
          });

          // Stop asynchronously to not block node failure handling
          this.stop(childRef).catch((err) => {
            this.log.error(
              "Error stopping orphaned child",
              err instanceof Error ? err : undefined,
              {
                childInstanceId,
              },
            );
          });
        }
      }
    }
  }

  private _handleRpcCast(rpcMessage: any): void {
    const { type, actorId, message } = rpcMessage;

    // Handle watch:remove message
    if (type === "watch:remove") {
      this._handleRemoteWatchRemove(rpcMessage);
      return;
    }

    // Handle watch:down message (remote actor died)
    if (type === "watch:down") {
      this._handleRemoteDown(rpcMessage);
      return;
    }

    // Handle link:remove message
    if (type === "link:remove") {
      this._handleRemoteLinkRemove(rpcMessage);
      return;
    }

    // Handle link:exit message (remote linked actor exited)
    if (type === "link:exit") {
      this._handleRemoteLinkExit(rpcMessage);
      return;
    }

    // Handle child:crash message (remote child crashed)
    if (type === "child:crash") {
      this._handleRemoteChildCrash(rpcMessage);
      return;
    }

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

      // Wrap in try-catch and route errors through supervisor
      try {
        const result = actor.handleCast(message);
        // Handle async handleCast
        if (result instanceof Promise) {
          result.catch((err) => {
            const actorRef = new ActorRef(actorId, this);
            this.supervisor.handleCrash(actorRef, err);
          });
        }
      } catch (err) {
        const actorRef = new ActorRef(actorId, this);
        this.supervisor.handleCrash(actorRef, err);
      }
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
