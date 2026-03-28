/**
 * Messages sent from supervisor to worker processes.
 */
export type SupervisorMessage =
  | { type: "drain"; target?: string; timeout?: number }
  | { type: "stop"; timeout?: number }
  | { type: "health" }
  | { type: "actors" }
  | { type: "status" };

/**
 * Messages sent from worker processes to supervisor.
 */
export type WorkerMessage =
  | { type: "ready"; nodeId: string; port: number; roles: string[] }
  | {
      type: "health";
      status: "healthy" | "degraded" | "unhealthy";
      details?: Record<string, unknown>;
    }
  | {
      type: "actors";
      actors: Array<{
        actorId: string;
        name?: string;
        className: string;
        migratable: boolean;
        childCount: number;
      }>;
    }
  | { type: "drain_complete"; migrated: number; drained: number; failed: string[] }
  | { type: "stopped" }
  | { type: "status"; data: NodeStatus }
  | { type: "error"; message: string };

export interface NodeStatus {
  nodeId: string;
  port: number;
  roles: string[];
  actorCount: number;
  health: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  version?: string;
}

export interface NodeInfo {
  /** Node name from config (e.g., "gateway", "worker") */
  name: string;
  /** Process ID if running */
  pid?: number;
  /** Status received from worker */
  status?: NodeStatus;
  /** Whether the process is alive */
  alive: boolean;
}
