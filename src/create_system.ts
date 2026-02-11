import { Actor, ActorRef } from "./actor";
import { ActorSystem, SpawnOptions } from "./actor_system";
import { LocalCluster } from "./local_cluster";
import { InMemoryTransport } from "./in_memory_transport";
import { LocalRegistry } from "./local_registry";
import { ZeroMQTransport } from "./zeromq_transport";
import { GossipUDP } from "./gossip_udp";
import { GossipProtocol, GossipOptions } from "./gossip_protocol";
import { DistributedCluster } from "./distributed_cluster";
import { RegistrySync } from "./registry_sync";
import { DistributedRegistry } from "./distributed_registry";
import { Transport } from "./transport";
import { Cluster } from "./cluster";
import { Registry } from "./registry";
import {
  ActorRefFrom,
  ActorRegistry,
  ActorDefinition,
  DistributedConfig,
  LocalConfig,
  TypedActorRef,
} from "./types/functional";
import { v4 as uuidv4 } from "uuid";

const DEFAULT_GOSSIP_OPTIONS: GossipOptions = {
  gossipIntervalMs: 1000,
  cleanupIntervalMs: 2000,
  failureTimeoutMs: 5000,
  gossipFanout: 3,
  seedNodes: [],
};

/**
 * System wrapper that provides a unified API for interacting with the actor system.
 * Exposes escape hatches for advanced use cases.
 */
export interface System {
  /** Spawn an actor (class-based or functional) */
  spawn<
    TArgs extends any[],
    TCalls extends Record<string, (...args: any[]) => any>,
    TCasts extends Record<string, (...args: any[]) => void>,
  >(
    actorClass: ActorDefinition<TArgs, TCalls, TCasts>,
    options?: SpawnOptions,
  ): TypedActorRef<TCalls, TCasts>;
  spawn<T extends Actor>(actorClass: new () => T, options?: SpawnOptions): ActorRef;
  /** Register an actor class for remote spawning */
  register(actorClass: new () => Actor): void;
  /** Look up a named actor (local or remote) */
  getActorByName<K extends keyof ActorRegistry & string>(
    name: K,
  ): Promise<ActorRefFrom<ActorRegistry[K]> | null>;
  getActorByName(name: string): Promise<ActorRef | null>;
  /** Gracefully shut down the system */
  shutdown(): Promise<void>;
  /** The underlying transport layer */
  readonly transport: Transport;
  /** The underlying cluster membership */
  readonly cluster: Cluster;
  /** The underlying actor registry */
  readonly registry: Registry;
  /** The underlying actor system */
  readonly system: ActorSystem;
  /** The node ID */
  readonly nodeId: string;
}

class SystemImpl implements System {
  readonly nodeId: string;

  constructor(
    readonly system: ActorSystem,
    readonly transport: Transport,
    readonly cluster: Cluster,
    readonly registry: Registry,
    private readonly clusterLeave?: () => Promise<void>,
  ) {
    this.nodeId = system.id;
  }

  spawn<
    TArgs extends any[],
    TCalls extends Record<string, (...args: any[]) => any>,
    TCasts extends Record<string, (...args: any[]) => void>,
  >(
    actorClass: ActorDefinition<TArgs, TCalls, TCasts>,
    options?: SpawnOptions,
  ): TypedActorRef<TCalls, TCasts>;
  spawn<T extends Actor>(actorClass: new () => T, options?: SpawnOptions): ActorRef;
  spawn(actorClass: any, options?: SpawnOptions): ActorRef {
    return this.system.spawn(actorClass, options);
  }

  register(actorClass: new () => Actor): void {
    this.system.registerActorClass(actorClass);
  }

  getActorByName<K extends keyof ActorRegistry & string>(
    name: K,
  ): Promise<ActorRefFrom<ActorRegistry[K]> | null>;
  getActorByName(name: string): Promise<ActorRef | null>;
  getActorByName(name: string): Promise<ActorRef | null> {
    return this.system.getActorByName(name);
  }

  async shutdown(): Promise<void> {
    // 1. Shutdown actor system (terminates actors, unregisters names)
    await this.system.shutdown();

    // 2. Leave cluster gracefully (for distributed mode)
    if (this.clusterLeave) {
      await this.clusterLeave();
    }

    // 3. Disconnect transport
    await this.transport.disconnect();

    // 4. Disconnect registry
    await this.registry.disconnect();
  }
}

function createLocalSystem(config?: LocalConfig): System {
  const nodeId = config?.nodeId ?? `local-${uuidv4().slice(0, 8)}`;
  
  const cluster = new LocalCluster(nodeId);
  const transport = new InMemoryTransport(nodeId);
  const registry = new LocalRegistry();

  transport.connect();

  const system = new ActorSystem(
    cluster,
    transport,
    registry,
    config?.supervision,
  );
  system.start();

  return new SystemImpl(system, transport, cluster, registry);
}

async function createDistributedSystem(config: DistributedConfig): Promise<System> {
  const nodeId = config.nodeId ?? `node-${uuidv4().slice(0, 8)}`;
  const bindAddress = config.bindAddress ?? "0.0.0.0";

  let rpcPort: number;
  let pubPort: number;
  let gossipPort: number;

  if (config.ports) {
    rpcPort = config.ports.rpc;
    pubPort = config.ports.pub;
    gossipPort = config.ports.gossip;
  } else if (config.port) {
    rpcPort = config.port;
    pubPort = config.port + 1;
    gossipPort = config.port + 2;
  } else {
    throw new Error("Distributed config requires either 'port' or 'ports'");
  }

  // 1. Setup transport (ZeroMQ)
  const transport = new ZeroMQTransport({
    nodeId,
    rpcPort,
    pubPort,
    bindAddress,
  });
  await transport.connect();

  // 2. Setup gossip protocol for membership
  const gossipUDP = new GossipUDP({
    address: bindAddress,
    port: gossipPort,
  });

  const gossipOptions: GossipOptions = {
    ...DEFAULT_GOSSIP_OPTIONS,
    ...config.gossip,
    seedNodes: config.seedNodes,
  };

  const rpcAddress = `tcp://127.0.0.1:${rpcPort}`;
  const gossipAddress = `127.0.0.1:${gossipPort}`;

  const gossipProtocol = new GossipProtocol(
    nodeId,
    rpcAddress,
    gossipAddress,
    gossipUDP,
    gossipOptions,
  );

  // 3. Setup cluster (wraps gossip protocol)
  const cluster = new DistributedCluster(gossipProtocol);
  await cluster.start();

  // 4. Setup registry sync for actor name resolution
  const registrySync = new RegistrySync(nodeId, transport, cluster);
  const registry = new DistributedRegistry(nodeId, registrySync);

  await registry.connect();

  // 5. Wire cluster membership changes to transport
  cluster.on("member_join", (peerId: string) => {
    const peer = cluster.getPeerState(peerId);
    if (peer && peer.address) {
      transport.updatePeers([[peerId, peer.address]]);
    }
  });

  // 6. Create actor system
  const system = new ActorSystem(
    cluster,
    transport,
    registry,
    config.supervision,
  );
  await system.start();

  const clusterLeave = async () => {
    await cluster.leave();
  };

  return new SystemImpl(system, transport, cluster, registry, clusterLeave);
}

/**
 * Creates an actor system with minimal configuration.
 *
 * @example Local mode (synchronous)
 * ```typescript
 * // Default local system
 * const system = createSystem();
 *
 * // Local system with custom nodeId
 * const system = createSystem({ nodeId: "my-node" });
 * ```
 *
 * @example Distributed mode (asynchronous)
 * ```typescript
 * // Distributed system with port convention (rpc=5000, pub=5001, gossip=5002)
 * const system = await createSystem({
 *   type: "distributed",
 *   port: 5000,
 *   seedNodes: ["127.0.0.1:6002"],  // Connect to another node's gossip port
 * });
 *
 * // Distributed system with explicit ports
 * const system = await createSystem({
 *   type: "distributed",
 *   ports: { rpc: 5000, pub: 5001, gossip: 5002 },
 *   seedNodes: [],
 * });
 * ```
 */
export function createSystem(): System;
export function createSystem(config: LocalConfig): System;
export function createSystem(config: DistributedConfig): Promise<System>;
export function createSystem(
  config?: LocalConfig | DistributedConfig
): System | Promise<System> {
  if (!config || config.type !== "distributed") {
    return createLocalSystem(config as LocalConfig | undefined);
  }
  return createDistributedSystem(config);
}
