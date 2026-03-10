// src/orchestration/node_worker.ts
//
// Entry point for fork()ed child processes. Used only for testing
// (simulating multi-machine scenarios on one laptop).
// In production, nodes are started directly via createSystem().
//
// Receives config via IPC from parent (TestCluster), boots a real
// distributed system, spawns a NodeAgent, and signals readiness.

import { createSystem } from "../create_system.js";
import { NodeAgent } from "./node_agent.js";
import type { System } from "../create_system.js";
import type { ActorDefinition } from "../types/functional.js";
import type { FaultyTransport } from "../testing/faulty_transport.js";
import type { FaultyGossipUDP } from "../testing/faulty_gossip.js";

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
    /** Enable fault injection wrappers (FaultyTransport + FaultyGossipUDP) */
    faultInjection?: boolean;
  };
}

/** Message sent from NodeWorker to TestCluster via IPC */
export interface NodeWorkerReadyMessage {
  type: "ready";
  nodeId: string;
  /** Internal actor ID of the NodeAgent (for direct ref construction) */
  agentActorId: string;
  /** Registered name of the NodeAgent */
  agentName: string;
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

/** Request from TestCluster to partition this node from specified peers */
export interface NodeWorkerPartitionMessage {
  type: "partition";
  /** NodeIDs to partition from */
  targetNodeIds: string[];
  /** Gossip addresses to block (e.g., ["127.0.0.1:5002"]) */
  targetGossipAddresses: string[];
}

/** Request from TestCluster to heal partitions */
export interface NodeWorkerHealMessage {
  type: "heal";
  /** NodeIDs to heal (empty = heal all) */
  targetNodeIds: string[];
  /** Gossip addresses to unblock */
  targetGossipAddresses: string[];
}

export type NodeWorkerMessage =
  | NodeWorkerBootMessage
  | NodeWorkerShutdownMessage
  | NodeWorkerResyncRegistryMessage
  | NodeWorkerPartitionMessage
  | NodeWorkerHealMessage;

export type NodeWorkerResponse =
  | NodeWorkerReadyMessage
  | NodeWorkerErrorMessage;

// Only activate IPC listener when running as a forked child process
if (process.send) {
  let system: System | undefined;
  let faultyTransport: FaultyTransport | undefined;
  let faultyGossip: FaultyGossipUDP | undefined;

  process.on("message", async (msg: NodeWorkerMessage) => {
    if (msg.type === "boot") {
      try {
        // Build createSystem config with optional fault injection wrappers
        const createSystemConfig: any = {
          type: "distributed",
          nodeId: msg.config.nodeId,
          port: msg.config.port,
          seedNodes: msg.config.seedNodes,
          cookie: msg.config.cookie,
          advertiseAddress: msg.config.advertiseAddress ?? "127.0.0.1",
        };

        if (msg.config.faultInjection) {
          // Lazy-import to avoid loading testing modules in non-fault-injection workers
          const { FaultyTransport: FT } = await import("../testing/faulty_transport.js");
          const { FaultyGossipUDP: FG } = await import("../testing/faulty_gossip.js");

          createSystemConfig._wrapTransport = (inner: any) => {
            faultyTransport = new FT(inner);
            return faultyTransport;
          };
          createSystemConfig._wrapGossipUDP = (inner: any) => {
            faultyGossip = new FG(inner);
            return faultyGossip;
          };
        }

        system = await createSystem(createSystemConfig);

        // Spawn NodeAgent with well-known name
        const agentRef = system.spawn(NodeAgent, {
          name: `node-agent@${system.nodeId}`,
          args: [system],
        });

        // Load actor modules if provided
        if (msg.config.actorModules) {
          for (const modulePath of msg.config.actorModules) {
            const mod = await import(modulePath);
            for (const [name, exported] of Object.entries(mod)) {
              if (
                exported &&
                (exported as any).__type === "functional-actor"
              ) {
                // Functional actor — register on NodeAgent via local call
                await agentRef.call("registerActor", name, exported as ActorDefinition<any, any, any>);
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
          agentActorId: agentRef.id.id,
          agentName: `node-agent@${system.nodeId}`,
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

    if (msg.type === "partition") {
      if (faultyTransport) {
        for (const nodeId of msg.targetNodeIds) {
          faultyTransport.partition(nodeId);
        }
      }
      if (faultyGossip) {
        for (let i = 0; i < msg.targetNodeIds.length; i++) {
          const nodeId = msg.targetNodeIds[i];
          const gossipAddr = msg.targetGossipAddresses[i];
          if (nodeId && gossipAddr) {
            faultyGossip.partition(nodeId, gossipAddr);
          }
        }
      }
    }

    if (msg.type === "heal") {
      if (msg.targetNodeIds.length === 0) {
        // Heal all
        if (faultyTransport) faultyTransport.healAll();
        if (faultyGossip) faultyGossip.healAll();
      } else {
        if (faultyTransport) {
          for (const nodeId of msg.targetNodeIds) {
            faultyTransport.heal(nodeId);
          }
        }
        if (faultyGossip) {
          for (let i = 0; i < msg.targetNodeIds.length; i++) {
            const nodeId = msg.targetNodeIds[i];
            const gossipAddr = msg.targetGossipAddresses[i];
            if (nodeId && gossipAddr) {
              faultyGossip.heal(nodeId, gossipAddr);
            }
          }
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
