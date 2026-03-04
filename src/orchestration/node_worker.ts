// src/orchestration/node_worker.ts
//
// Entry point for fork()ed child processes. Used only for testing
// (simulating multi-machine scenarios on one laptop).
// In production, nodes are started directly via createSystem().
//
// Receives config via IPC from parent (TestCluster), boots a real
// distributed system, spawns a NodeAgent, and signals readiness.

import { createSystem } from "../create_system";
import { NodeAgent } from "./node_agent";
import type { System } from "../create_system";
import type { ActorDefinition } from "../types/functional";

/** Message sent from TestCluster to NodeWorker via IPC */
export interface NodeWorkerBootMessage {
  type: "boot";
  config: {
    nodeId: string;
    port: number;
    seedNodes: string[];
    cookie?: string;
    advertiseAddress?: string;
    actorModules?: string[];
  };
}

/** Message sent from NodeWorker to TestCluster via IPC */
export interface NodeWorkerReadyMessage {
  type: "ready";
  nodeId: string;
}

/** Message sent from NodeWorker to TestCluster on boot failure */
export interface NodeWorkerErrorMessage {
  type: "error";
  error: string;
}

/** Shutdown request from TestCluster */
export interface NodeWorkerShutdownMessage {
  type: "shutdown";
}

/** Request from TestCluster to re-publish all registry entries */
export interface NodeWorkerResyncRegistryMessage {
  type: "resync-registry";
}

export type NodeWorkerMessage =
  | NodeWorkerBootMessage
  | NodeWorkerShutdownMessage
  | NodeWorkerResyncRegistryMessage;

export type NodeWorkerResponse =
  | NodeWorkerReadyMessage
  | NodeWorkerErrorMessage;

// Only activate IPC listener when running as a forked child process
if (process.send) {
  let system: System | undefined;

  process.on("message", async (msg: NodeWorkerMessage) => {
    if (msg.type === "boot") {
      try {
        system = await createSystem({
          type: "distributed",
          nodeId: msg.config.nodeId,
          port: msg.config.port,
          seedNodes: msg.config.seedNodes,
          cookie: msg.config.cookie,
          advertiseAddress: msg.config.advertiseAddress ?? "127.0.0.1",
        });

        // Spawn NodeAgent with well-known name
        const agentRef = system.spawn(NodeAgent, {
          name: `node-agent@${system.nodeId}`,
          args: [system],
        });

        // Load actor modules if provided
        if (msg.config.actorModules) {
          for (const modulePath of msg.config.actorModules) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require(modulePath);
            for (const [name, exported] of Object.entries(mod)) {
              if (
                exported &&
                (exported as any).__type === "functional-actor"
              ) {
                // Functional actor — register on NodeAgent via local call
                await agentRef.call("registerActor", name, exported);
              } else if (typeof exported === "function") {
                // Class-based actor
                system.register(exported as any);
              }
            }
          }
        }

        process.send!({
          type: "ready",
          nodeId: system.nodeId,
        } satisfies NodeWorkerReadyMessage);
      } catch (err: any) {
        process.send!({
          type: "error",
          error: err.message ?? String(err),
        } satisfies NodeWorkerErrorMessage);
      }
    }

    if (msg.type === "resync-registry") {
      if (system) {
        // Access the registry sync and re-publish all registrations.
        // This is needed because PUB/SUB connections may not have been
        // established when the initial registration was published.
        const registrySync = (system as any).registrySync;
        if (registrySync && typeof registrySync.republishAll === "function") {
          registrySync.republishAll();
        }
      }
    }

    if (msg.type === "shutdown") {
      if (system) {
        await system.shutdown();
      }
      process.exit(0);
    }
  });

  // Graceful cleanup on parent disconnect
  process.on("disconnect", async () => {
    if (system) {
      await system.shutdown();
    }
    process.exit(0);
  });
}
