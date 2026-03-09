// src/orchestration/node_agent.ts

import { createActor } from "../create_actor.js";
import type { System } from "../create_system.js";
import type { SpawnOptions } from "../actor_system.js";
import type { ActorDefinition } from "../types/functional.js";

/**
 * Options passed to `spawn` via NodeAgent.
 * A subset of SpawnOptions — only the fields that make sense for remote orchestration.
 */
export interface NodeAgentSpawnOptions {
  name?: string;
  args?: any[];
}

/**
 * Node information returned by `getNodeInfo`.
 */
export interface NodeInfo {
  nodeId: string;
  uptime: number;
  memoryUsage: NodeJS.MemoryUsage;
  actorCount: number;
}

/**
 * NodeAgent — a regular actor that runs on every node, enabling remote
 * actor management via standard actor calls.
 *
 * Named `node-agent@{nodeId}` so any node can find it via `getActorByName`.
 *
 * Usage:
 * ```typescript
 * const system = await createSystem({ ... });
 *
 * // Register actor classes that can be spawned remotely
 * const agent = system.spawn(NodeAgent, {
 *   name: `node-agent@${system.nodeId}`,
 *   args: [system],
 * });
 *
 * // From any node in the cluster:
 * const remoteAgent = await system.getActorByName("node-agent@node-B");
 * await remoteAgent.call("spawn", "Counter", { name: "order-counter" });
 * await remoteAgent.call("getNodeInfo");
 * ```
 */
export const NodeAgent = createActor((ctx, self, system: System) => {
  // Internal registry for functional actors (class-based actors use ActorSystem.registerActorClass)
  const actorDefinitions = new Map<string, ActorDefinition<any, any, any>>();

  return self
    // ── Health ──────────────────────────────────────────────────

    .onCall("ping", () => "pong" as const)

    .onCall("getNodeInfo", (): NodeInfo => ({
      nodeId: system.nodeId,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      actorCount: system.system.getLocalActorIds().length,
    }))

    // ── Actor Registry ─────────────────────────────────────────

    .onCall(
      "registerActor",
      (name: string, definition: ActorDefinition<any, any, any>) => {
        actorDefinitions.set(name, definition);
      },
    )

    // ── Actor Management ───────────────────────────────────────

    .onCall(
      "spawn",
      (className: string, options?: NodeAgentSpawnOptions): string => {
        // First check functional actor definitions registered via registerActor
        const definition = actorDefinitions.get(className);
        if (definition) {
          const ref = system.spawn(definition, options);
          return ref.id.id;
        }

        // Fall back to class-based actor registry on the ActorSystem
        const actorClass = system.system.getActorClass(className);
        if (!actorClass) {
          throw new Error(`Actor class not registered: ${className}`);
        }
        const ref = system.system.spawn(actorClass, options as SpawnOptions);
        return ref.id.id;
      },
    )

    .onCall("stopActor", async (actorName: string): Promise<boolean> => {
      const ref = await system.getActorByName(actorName);
      if (!ref) return false;
      await system.stop(ref);
      return true;
    })

    .onCall(
      "callActor",
      async (actorName: string, method: string, ...args: any[]): Promise<any> => {
        const ref = await system.getActorByName(actorName);
        if (!ref) throw new Error(`Actor not found: ${actorName}`);
        return ref.call({ method, args });
      },
    )

    .onCall("castActor", async (actorName: string, method: string, ...args: any[]) => {
      const ref = await system.getActorByName(actorName);
      if (!ref) throw new Error(`Actor not found: ${actorName}`);
      ref.cast({ method, args });
    })

    .onCall("getActorIds", (): string[] => {
      return system.system.getLocalActorIds();
    })

    // ── Node Lifecycle ─────────────────────────────────────────

    .onCall("shutdown", async () => {
      // Schedule shutdown on next tick so the call can return first
      setImmediate(() => {
        void system.shutdown();
      });
    });
});
