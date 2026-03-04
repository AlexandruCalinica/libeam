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
import type { System } from "../create_system";
import type { ActorRef } from "../actor";
import type {
  NodeWorkerBootMessage,
  NodeWorkerReadyMessage,
  NodeWorkerErrorMessage,
  NodeWorkerResponse,
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
 */
export class TestCluster {
  /** The controller's own libeam System (part of the cluster) */
  readonly system: System;
  /** Handles to all spawned worker nodes */
  readonly nodes: TestNodeHandle[];

  private readonly childProcesses: ChildProcess[];
  private tornDown = false;

  private constructor(
    system: System,
    nodes: TestNodeHandle[],
    childProcesses: ChildProcess[],
  ) {
    this.system = system;
    this.nodes = nodes;
    this.childProcesses = childProcesses;

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

    // Fork worker nodes
    const workerReadyPromises: Promise<string>[] = [];

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

      const readyPromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Worker ${nodeId} failed to boot within ${timeout}ms`));
        }, timeout);

        child.on("message", (msg: NodeWorkerResponse) => {
          if (msg.type === "ready") {
            clearTimeout(timer);
            resolve(msg.nodeId);
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
        },
      };
      child.send(bootMsg);
    }

    // Wait for all workers to be ready (IPC "ready" messages)
    // This ensures their gossip UDP sockets are bound before the controller
    // tries to reach them via seed nodes.
    await Promise.all(workerReadyPromises);

    // Boot controller system AFTER workers are ready to avoid gossip
    // seed node resolution failures (UDP packets to unbound ports are lost).
    const controllerSeedNodes = allGossipAddresses.filter(
      (addr) => addr !== `127.0.0.1:${controllerPorts.gossip}`,
    );

    const controllerSystem = await createSystem({
      type: "distributed",
      nodeId: controllerId,
      port: controllerPorts.rpc,
      seedNodes: controllerSeedNodes,
      cookie,
      advertiseAddress: "127.0.0.1",
    });

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

    // After cluster formation, SUB sockets are connected but workers
    // may have published their registry entries before the SUB handshake
    // completed. Tell all workers to re-publish their registry entries.
    for (const child of childProcesses) {
      if (child.connected) {
        child.send({ type: "resync-registry" });
      }
    }

    // Give SUB sockets time to receive the re-published entries
    await new Promise((r) => setTimeout(r, 500));

    // Resolve NodeAgent refs for each worker
    for (let i = 0; i < size; i++) {
      const nodeId = `${uniquePrefix}-${i}`;
      const ports = workerPortSets[i];
      const child = childProcesses[i];

      // Retry getActorByName with backoff — registry sync may lag behind gossip
      const agentRef = await retryGetActor(
        controllerSystem,
        `node-agent@${nodeId}`,
        timeout,
      );

      nodeHandles.push({
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
      });
    }

    return new TestCluster(controllerSystem, nodeHandles, childProcesses);
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
 * Retry getActorByName with exponential backoff.
 * Registry sync across nodes can take a few hundred ms after gossip converges.
 */
async function retryGetActor(
  system: System,
  name: string,
  timeout: number,
): Promise<ActorRef> {
  const start = Date.now();
  let delay = 100;

  while (Date.now() - start < timeout) {
    const ref = await system.getActorByName(name);
    if (ref) return ref;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 2000);
  }

  throw new Error(
    `Failed to resolve actor "${name}" within ${timeout}ms. ` +
      `Registry sync may not have completed.`,
  );
}
