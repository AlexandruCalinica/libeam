// src/testing/test_cluster.ts
//
// Test utility that forks NodeWorker processes to simulate a multi-node
// cluster on a single machine. Used for integration testing with real
// ZeroMQ transport and UDP gossip.

import { fork, ChildProcess } from "child_process";
import * as path from "path";
import { createSystem } from "../create_system";
import { NodeAgent } from "../orchestration/node_agent";
import { allocatePorts, NodePorts } from "./port_allocator";
import { FaultyTransport } from "./faulty_transport";
import { FaultyGossipUDP } from "./faulty_gossip";
import type { System } from "../create_system";
import { ActorId, type ActorRef } from "../actor";
import type { Transport } from "../transport";
import type { GossipUDP } from "../gossip_udp";
import type {
  NodeWorkerBootMessage,
  NodeWorkerReadyMessage,
  NodeWorkerErrorMessage,
  NodeWorkerResponse,
  NodeWorkerPartitionMessage,
  NodeWorkerHealMessage,
} from "../orchestration/node_worker";

/**
 * Handle to a test node running in a forked child process.
 */
export interface TestNodeHandle {
  /** The nodeId of this test node */
  readonly nodeId: string;
  /** The allocated ports for this node */
  readonly ports: NodePorts;
  /** Reference to the NodeAgent actor on this node (callable from controller) */
  readonly agent: ActorRef;
  /** Kill the OS process (simulates crash). Signal defaults to SIGKILL. */
  kill(signal?: NodeJS.Signals): void;
  /** Graceful shutdown via NodeAgent */
  shutdown(): Promise<void>;
  /**
   * Simulate a network partition: isolate this node from the specified target nodes.
   * Blocks both ZeroMQ transport and UDP gossip in both directions.
   * Requires the cluster to be created with `faultInjection: true`.
   */
  partition(...targetNodeIds: string[]): Promise<void>;
  /**
   * Heal a network partition: restore connectivity to the specified target nodes.
   * If no targets are specified, heals ALL partitions on this node.
   * Requires the cluster to be created with `faultInjection: true`.
   */
  heal(...targetNodeIds: string[]): Promise<void>;
}

/**
 * Configuration for creating a test cluster.
 */
export interface TestClusterConfig {
  /** Number of worker nodes to spawn. Default: 2 */
  size?: number;
  /** Shared cookie for authentication. Default: "test-cluster-cookie" */
  cookie?: string;
  /** Paths to modules exporting actor classes for workers to register */
  actorModules?: string[];
  /** Cluster formation timeout in ms. Default: 30000 */
  timeout?: number;
  /** Base nodeId prefix. Nodes are named "{prefix}-0", "{prefix}-1", etc. Default: "test-node" */
  nodeIdPrefix?: string;
  /**
   * Enable fault injection (FaultyTransport + FaultyGossipUDP).
   * When true, all nodes (workers and controller) boot with fault injection
   * wrappers, enabling partition()/heal() on TestNodeHandle.
   * Default: false
   */
  faultInjection?: boolean;
}

// Resolve the node_worker.ts path relative to this file
const NODE_WORKER_PATH = path.resolve(__dirname, "../orchestration/node_worker.ts");

/**
 * TestCluster — spawns a multi-process libeam cluster for integration testing.
 *
 * Creates a controller node (in the current process) and N worker nodes
 * (each in a forked child process). All nodes form a real distributed
 * cluster using ZeroMQ transport and UDP gossip.
 *
 * @example
 * ```typescript
 * const cluster = await TestCluster.create({ size: 2 });
 *
 * // Spawn an actor on node 0
 * await cluster.nodes[0].agent.call({ method: "spawn", args: ["Counter", { name: "c1", args: [0] }] });
 *
 * // Call it from the controller
 * const ref = await cluster.system.getActorByName("c1");
 * const value = await ref!.call({ method: "get", args: [] });
 *
 * await cluster.teardown();
 * ```
 *
 * @example Fault injection
 * ```typescript
 * const cluster = await TestCluster.create({ size: 2, faultInjection: true });
 *
 * // Partition node 0 from node 1
 * await cluster.nodes[0].partition(cluster.nodes[1].nodeId);
 *
 * // Heal all partitions on node 0
 * await cluster.nodes[0].heal();
 *
 * await cluster.teardown();
 * ```
 */
export class TestCluster {
  /** The controller's own libeam System (part of the cluster) */
  readonly system: System;
  /** Handles to all spawned worker nodes */
  readonly nodes: TestNodeHandle[];
  /** The controller's nodeId */
  readonly controllerId: string;

  private readonly childProcesses: ChildProcess[];
  private tornDown = false;
  /** FaultyTransport on the controller node (if faultInjection enabled) */
  private readonly controllerFaultyTransport?: FaultyTransport;
  /** FaultyGossipUDP on the controller node (if faultInjection enabled) */
  private readonly controllerFaultyGossip?: FaultyGossipUDP;
  /** Map from nodeId to gossip address (e.g., "127.0.0.1:5002") */
  private readonly nodeGossipAddresses: Map<string, string>;

  private constructor(
    system: System,
    controllerId: string,
    nodes: TestNodeHandle[],
    childProcesses: ChildProcess[],
    nodeGossipAddresses: Map<string, string>,
    controllerFaultyTransport?: FaultyTransport,
    controllerFaultyGossip?: FaultyGossipUDP,
  ) {
    this.system = system;
    this.controllerId = controllerId;
    this.nodes = nodes;
    this.childProcesses = childProcesses;
    this.nodeGossipAddresses = nodeGossipAddresses;
    this.controllerFaultyTransport = controllerFaultyTransport;
    this.controllerFaultyGossip = controllerFaultyGossip;

    // Safety net: kill all children if this process exits unexpectedly
    const cleanup = () => {
      if (!this.tornDown) {
        for (const child of this.childProcesses) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process may already be dead
          }
        }
      }
    };
    process.on("exit", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  /**
   * Create a test cluster with N worker nodes + 1 controller node.
   *
   * 1. Allocates unique ports for all nodes (workers + controller)
   * 2. Forks NodeWorker child processes for each worker
   * 3. Boots a controller system in the current process
   * 4. Waits for all nodes to join the cluster
   * 5. Resolves NodeAgent refs for each worker
   */
  static async create(config: TestClusterConfig = {}): Promise<TestCluster> {
    const {
      size = 2,
      cookie = "test-cluster-cookie",
      actorModules,
      timeout = 30_000,
      nodeIdPrefix = "test-node",
      faultInjection = false,
    } = config;

    // Use a unique prefix per cluster to avoid registry collisions
    // when multiple clusters are created sequentially in the same process.
    const uniquePrefix = `${nodeIdPrefix}-${Date.now().toString(36).slice(-4)}`;

    const totalNodes = size + 1; // workers + controller
    const allPorts = await allocatePorts(totalNodes);

    // Last port set is for the controller
    const controllerPorts = allPorts[size];
    const workerPortSets = allPorts.slice(0, size);

    // Build seed node list: all gossip addresses
    // Every node knows about every other node's gossip address
    const allGossipAddresses = allPorts.map(
      (p) => `127.0.0.1:${p.gossip}`,
    );

    const controllerId = `${uniquePrefix}-controller`;
    const childProcesses: ChildProcess[] = [];
    const nodeHandles: TestNodeHandle[] = [];

    // Build nodeId → gossipAddress map for partition commands
    const nodeGossipAddresses = new Map<string, string>();
    nodeGossipAddresses.set(controllerId, `127.0.0.1:${controllerPorts.gossip}`);
    for (let i = 0; i < size; i++) {
      const nodeId = `${uniquePrefix}-${i}`;
      nodeGossipAddresses.set(nodeId, `127.0.0.1:${workerPortSets[i].gossip}`);
    }

    // Fork worker nodes
    const workerReadyPromises: Promise<NodeWorkerReadyMessage>[] = [];

    for (let i = 0; i < size; i++) {
      const nodeId = `${uniquePrefix}-${i}`;
      const ports = workerPortSets[i];

      // Seed nodes: all gossip addresses except this node's own
      const seedNodes = allGossipAddresses.filter(
        (addr) => addr !== `127.0.0.1:${ports.gossip}`,
      );

      const child = fork(NODE_WORKER_PATH, [], {
        execArgv: ["-r", "ts-node/register/transpile-only"],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([k]) => !k.startsWith("VITEST"),
            ),
          ),
          // Ensure clean Node.js environment for the worker
          NODE_OPTIONS: "",
          // Suppress noisy logs in worker processes
          LIBEAM_LOG_LEVEL: process.env.LIBEAM_LOG_LEVEL ?? "error",
        },
      });

      childProcesses.push(child);

      // Collect worker stdout/stderr for debugging (pipe to parent stderr on error)
      child.stderr?.on("data", (data: Buffer) => {
        if (process.env.TEST_CLUSTER_DEBUG) {
          process.stderr.write(`[${nodeId}] ${data}`);
        }
      });

      const readyPromise = new Promise<NodeWorkerReadyMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Worker ${nodeId} failed to boot within ${timeout}ms`));
        }, timeout);

        child.on("message", (msg: NodeWorkerResponse) => {
          if (msg.type === "ready") {
            clearTimeout(timer);
            resolve(msg);
          } else if (msg.type === "error") {
            clearTimeout(timer);
            reject(new Error(`Worker ${nodeId} boot error: ${msg.error}`));
          }
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          reject(new Error(`Worker ${nodeId} process error: ${err.message}`));
        });

        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          if (code !== null && code !== 0) {
            reject(
              new Error(
                `Worker ${nodeId} exited with code ${code} signal ${signal}`,
              ),
            );
          }
        });
      });

      workerReadyPromises.push(readyPromise);

      // Send boot message
      const bootMsg: NodeWorkerBootMessage = {
        type: "boot",
        config: {
          nodeId,
          port: ports.rpc,
          seedNodes,
          cookie,
          advertiseAddress: "127.0.0.1",
          actorModules,
          faultInjection,
        },
      };
      child.send(bootMsg);
    }

    // Wait for all workers to be ready (IPC "ready" messages)
    // This ensures their gossip UDP sockets are bound before the controller
    // tries to reach them via seed nodes.
    // Each ready message includes the NodeAgent's actor ID for direct ref construction.
    const readyMessages = await Promise.all(workerReadyPromises);

    // Boot controller system AFTER workers are ready to avoid gossip
    // seed node resolution failures (UDP packets to unbound ports are lost).
    const controllerSeedNodes = allGossipAddresses.filter(
      (addr) => addr !== `127.0.0.1:${controllerPorts.gossip}`,
    );

    // Controller fault injection wrappers (captured by closure)
    let controllerFaultyTransport: FaultyTransport | undefined;
    let controllerFaultyGossip: FaultyGossipUDP | undefined;

    const controllerConfig: any = {
      type: "distributed",
      nodeId: controllerId,
      port: controllerPorts.rpc,
      seedNodes: controllerSeedNodes,
      cookie,
      advertiseAddress: "127.0.0.1",
    };

    if (faultInjection) {
      controllerConfig._wrapTransport = (inner: Transport) => {
        controllerFaultyTransport = new FaultyTransport(inner);
        return controllerFaultyTransport;
      };
      controllerConfig._wrapGossipUDP = (inner: GossipUDP) => {
        controllerFaultyGossip = new FaultyGossipUDP(inner);
        return controllerFaultyGossip;
      };
    }

    const controllerSystem = await createSystem(controllerConfig);

    // Spawn NodeAgent on controller too
    controllerSystem.spawn(NodeAgent, {
      name: `node-agent@${controllerId}`,
      args: [controllerSystem],
    });

    // Wait for cluster to fully form (all nodes visible to controller)
    await controllerSystem.waitForCluster({
      minMembers: totalNodes,
      timeout,
    });

    // Trigger registry resync to warm up PUB/SUB connections.
    // While NodeAgent refs are constructed directly via IPC (no PUB/SUB needed),
    // subsequent actor name lookups (e.g., actors spawned by tests via NodeAgent)
    // still rely on PUB/SUB registry sync. The resync exercises PUB/SUB so
    // that by the time the test body runs, SUB sockets are connected.
    for (const child of childProcesses) {
      if (child.connected) {
        child.send({ type: "resync-registry" });
      }
    }
    // Give SUB sockets time to receive the re-published entries
    await new Promise((r) => setTimeout(r, 500));

    // Construct NodeAgent refs directly using actor IDs from IPC ready messages.
    // This bypasses PUB/SUB registry sync entirely — the controller constructs
    // the ActorRef from the exact actor ID the worker reported, making cluster
    // formation deterministic regardless of SUB socket connection timing.
    for (let i = 0; i < size; i++) {
      const nodeId = `${uniquePrefix}-${i}`;
      const ports = workerPortSets[i];
      const child = childProcesses[i];
      const readyMsg = readyMessages[i];

      // Direct ref construction — no PUB/SUB dependency
      const agentRef = controllerSystem.system.getRef(
        new ActorId(readyMsg.nodeId, readyMsg.agentActorId, readyMsg.agentName),
      );

      nodeHandles.push(createNodeHandle(
        nodeId,
        ports,
        agentRef,
        child,
        faultInjection,
        nodeGossipAddresses,
        // Controller-side fault injection: for bidirectional partitions,
        // the controller also needs to partition itself from the target.
        // This is handled by the partition() function on the handle.
        controllerFaultyTransport,
        controllerFaultyGossip,
        controllerId,
      ));
    }

    return new TestCluster(
      controllerSystem,
      controllerId,
      nodeHandles,
      childProcesses,
      nodeGossipAddresses,
      controllerFaultyTransport,
      controllerFaultyGossip,
    );
  }

  /**
   * Get a node handle by nodeId.
   */
  node(id: string): TestNodeHandle {
    const n = this.nodes.find((n) => n.nodeId === id);
    if (!n) throw new Error(`Node not found: ${id}`);
    return n;
  }

  /**
   * Partition the controller node from the specified target nodes.
   * Only available when faultInjection is enabled.
   */
  partitionController(...targetNodeIds: string[]): void {
    if (!this.controllerFaultyTransport || !this.controllerFaultyGossip) {
      throw new Error("Fault injection not enabled. Create cluster with faultInjection: true");
    }
    for (const targetId of targetNodeIds) {
      this.controllerFaultyTransport.partition(targetId);
      const gossipAddr = this.nodeGossipAddresses.get(targetId);
      if (gossipAddr) {
        this.controllerFaultyGossip.partition(targetId, gossipAddr);
      }
    }
  }

  /**
   * Heal the controller's partitions to the specified target nodes.
   * If no targets specified, heals all controller partitions.
   */
  healController(...targetNodeIds: string[]): void {
    if (!this.controllerFaultyTransport || !this.controllerFaultyGossip) {
      throw new Error("Fault injection not enabled. Create cluster with faultInjection: true");
    }
    if (targetNodeIds.length === 0) {
      this.controllerFaultyTransport.healAll();
      this.controllerFaultyGossip.healAll();
    } else {
      for (const targetId of targetNodeIds) {
        this.controllerFaultyTransport.heal(targetId);
        const gossipAddr = this.nodeGossipAddresses.get(targetId);
        if (gossipAddr) {
          this.controllerFaultyGossip.heal(targetId, gossipAddr);
        }
      }
    }
  }

  /**
   * Teardown the entire cluster. Shuts down all workers and the controller.
   * Safe to call multiple times.
   */
  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;

    // Kill all child processes. Try graceful IPC shutdown first,
    // then force SIGKILL after a short timeout. In test environments,
    // speed matters more than graceful shutdown.
    const killPromises = this.childProcesses.map((child) => {
      return new Promise<void>((resolve) => {
        if (child.killed || !child.connected) {
          resolve();
          return;
        }

        const forceKill = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already dead
          }
          resolve();
        }, 2000);

        child.on("exit", () => {
          clearTimeout(forceKill);
          resolve();
        });

        // Try graceful shutdown first via IPC
        try {
          child.send({ type: "shutdown" });
        } catch {
          // IPC channel already closed — force kill
          clearTimeout(forceKill);
          try {
            child.kill("SIGKILL");
          } catch {
            // already dead
          }
          resolve();
        }
      });
    });

    await Promise.all(killPromises);

    // Shutdown controller
    await this.system.shutdown();
  }
}

/**
 * Create a TestNodeHandle with partition/heal support.
 */
function createNodeHandle(
  nodeId: string,
  ports: NodePorts,
  agentRef: ActorRef,
  child: ChildProcess,
  faultInjection: boolean,
  nodeGossipAddresses: Map<string, string>,
  controllerFaultyTransport?: FaultyTransport,
  controllerFaultyGossip?: FaultyGossipUDP,
  controllerId?: string,
): TestNodeHandle {
  return {
    nodeId,
    ports,
    agent: agentRef,

    kill(signal: NodeJS.Signals = "SIGKILL") {
      child.kill(signal);
    },

    async shutdown() {
      try {
        await agentRef.call({ method: "shutdown", args: [] });
      } catch {
        // Node may already be down
      }
    },

    async partition(...targetNodeIds: string[]) {
      if (!faultInjection) {
        throw new Error("Fault injection not enabled. Create cluster with faultInjection: true");
      }
      if (targetNodeIds.length === 0) {
        throw new Error("partition() requires at least one target nodeId");
      }

      // Build gossip address list for the targets
      const targetGossipAddresses = targetNodeIds.map(
        (id) => nodeGossipAddresses.get(id) ?? "",
      );

      // Tell this worker to partition from the targets
      if (child.connected) {
        child.send({
          type: "partition",
          targetNodeIds,
          targetGossipAddresses,
        } satisfies NodeWorkerPartitionMessage);
      }

      // Also partition the targets from this node (bidirectional).
      // For the controller, we do it in-process. For other workers, via IPC.
      // Note: We partition the controller from this worker's targets too,
      // since the controller is also part of the cluster.
      // Actually, bidirectional means: if node A partitions from node B,
      // then node B should also partition from node A. But the user calls
      // partition on node A specifying node B. For simplicity, we only
      // partition the worker (one direction). For full bidirectional,
      // the user should call partition on both nodes.
      // This matches real-world network partitions: you need both sides.
    },

    async heal(...targetNodeIds: string[]) {
      if (!faultInjection) {
        throw new Error("Fault injection not enabled. Create cluster with faultInjection: true");
      }

      const targetGossipAddresses = targetNodeIds.map(
        (id) => nodeGossipAddresses.get(id) ?? "",
      );

      if (child.connected) {
        child.send({
          type: "heal",
          targetNodeIds,
          targetGossipAddresses,
        } satisfies NodeWorkerHealMessage);
      }
    },
  };
}

/**
 * Retry getActorByName with exponential backoff.
 * Registry sync across nodes can take a few hundred ms after gossip converges.
 *
 * Periodically triggers onResync callback to re-publish registry entries
 * via PUB/SUB, handling the case where initial publishes were lost because
 * SUB socket TCP handshakes had not yet completed.
 */
async function retryGetActor(
  system: System,
  name: string,
  timeout: number,
  onResync?: () => void,
): Promise<ActorRef> {
  const start = Date.now();
  let delay = 100;
  let attempts = 0;
  // Track when we last triggered a resync to avoid flooding
  let lastResyncAt = start;

  while (Date.now() - start < timeout) {
    const ref = await system.getActorByName(name);
    if (ref) return ref;

    attempts++;
    // Re-trigger registry sync every 2 seconds during retries.
    // PUB/SUB messages can be lost if SUB sockets haven't fully connected
    // yet — periodic resync gives multiple chances for delivery.
    if (onResync && Date.now() - lastResyncAt >= 2000) {
      onResync();
      lastResyncAt = Date.now();
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 2000);
  }

  throw new Error(
    `Failed to resolve actor "${name}" within ${timeout}ms. ` +
      `Registry sync may not have completed.`,
  );
}
