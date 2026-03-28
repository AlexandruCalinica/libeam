import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LibeamConfig, NodeDefinition } from "./config.js";
import type { NodeInfo, NodeStatus, SupervisorMessage, WorkerMessage } from "./ipc.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const WORKER_SCRIPT = resolve(__dirname, "worker.js");

interface ManagedNode {
  name: string;
  definition: NodeDefinition;
  process: ChildProcess;
  status?: NodeStatus;
  startedAt: number;
}

export class NodeSupervisor {
  private nodes = new Map<string, ManagedNode>();
  private nextAutoPort = 6000;
  private shutdownInProgress = false;

  constructor(private config: LibeamConfig) {}

  /**
   * Start all nodes defined in config, or only those matching a role filter.
   */
  async startAll(roleFilter?: string): Promise<void> {
    const entries = Object.entries(this.config.nodes);
    for (const [name, definition] of entries) {
      if (roleFilter && !definition.roles?.includes(roleFilter)) continue;
      const count = definition.count ?? 1;
      for (let i = 0; i < count; i++) {
        const instanceName = count > 1 ? `${name}-${i + 1}` : name;
        await this.startNode(instanceName, definition);
      }
    }
  }

  /**
   * Start a single node.
   */
  async startNode(name: string, definition: NodeDefinition): Promise<void> {
    if (this.nodes.has(name)) {
      throw new Error(`Node "${name}" is already running`);
    }

    const port = definition.port === "auto" || definition.port === undefined ? this.nextAutoPort++ : definition.port;

    const seedNodes = this.config.cluster.seedNodes ?? [];

    const child = fork(WORKER_SCRIPT, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        LIBEAM_NODE_NAME: name,
        LIBEAM_ENTRY: definition.entry,
        LIBEAM_PORT: String(port),
        LIBEAM_COOKIE: this.config.cluster.cookie ?? "",
        LIBEAM_SEED_NODES: seedNodes.join(","),
        LIBEAM_ROLES: (definition.roles ?? []).join(","),
      },
    });

    const managed: ManagedNode = {
      name,
      definition,
      process: child,
      startedAt: Date.now(),
    };
    this.nodes.set(name, managed);

    child.on("exit", (code) => {
      this.nodes.delete(name);
      if (!this.shutdownInProgress) {
        process.stderr.write(`[libeam] Node "${name}" exited with code ${code}\n`);
      }
    });

    // Wait for ready message
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Node "${name}" did not become ready within 30s`));
      }, 30000);

      const handler = (msg: WorkerMessage) => {
        if (msg.type === "ready") {
          managed.status = {
            nodeId: msg.nodeId,
            port: msg.port,
            roles: msg.roles,
            actorCount: 0,
            health: "healthy",
            uptime: 0,
          };
          clearTimeout(timeout);
          child.off("message", handler);
          resolve();
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          child.off("message", handler);
          reject(new Error(`Node "${name}" failed to start: ${msg.message}`));
        }
      };
      child.on("message", handler);
    });
  }

  /**
   * Send a message to a worker and wait for a response of a specific type.
   */
  async sendAndWait<T extends WorkerMessage["type"]>(
    name: string,
    msg: SupervisorMessage,
    responseType: T,
    timeout = 10000,
  ): Promise<Extract<WorkerMessage, { type: T }>> {
    const node = this.nodes.get(name);
    if (!node) throw new Error(`Node "${name}" is not running`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        node.process.off("message", handler);
        reject(new Error(`Timeout waiting for "${responseType}" from node "${name}"`));
      }, timeout);

      const handler = (response: WorkerMessage) => {
        if (response.type === responseType) {
          clearTimeout(timer);
          node.process.off("message", handler);
          resolve(response as Extract<WorkerMessage, { type: T }>);
        }
      };
      node.process.on("message", handler);
      node.process.send(msg);
    });
  }

  /**
   * Stop a specific node gracefully.
   */
  async stopNode(name: string, timeout = 5000): Promise<void> {
    const node = this.nodes.get(name);
    if (!node) return;

    try {
      node.process.send({ type: "stop", timeout } satisfies SupervisorMessage);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          node.process.kill("SIGTERM");
          resolve();
        }, timeout + 1000);
        node.process.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch {
      node.process.kill("SIGTERM");
    }
    this.nodes.delete(name);
  }

  /**
   * Stop all nodes gracefully.
   */
  async stopAll(timeout = 5000): Promise<void> {
    this.shutdownInProgress = true;
    const names = Array.from(this.nodes.keys());
    await Promise.all(names.map((name) => this.stopNode(name, timeout)));
    this.shutdownInProgress = false;
  }

  /**
   * Drain a specific node.
   */
  async drainNode(
    name: string,
    target?: string,
    timeout = 30000,
  ): Promise<{ migrated: number; drained: number; failed: string[] }> {
    const response = await this.sendAndWait(name, { type: "drain", target, timeout }, "drain_complete", timeout + 5000);
    return { migrated: response.migrated, drained: response.drained, failed: response.failed };
  }

  /**
   * Get status of all running nodes.
   */
  async getAllStatus(): Promise<NodeInfo[]> {
    const results: NodeInfo[] = [];
    for (const [name, node] of this.nodes) {
      try {
        const response = await this.sendAndWait(name, { type: "status" }, "status", 5000);
        results.push({ name, pid: node.process.pid, status: response.data, alive: true });
      } catch {
        results.push({ name, pid: node.process.pid, alive: !!node.process.pid, status: node.status });
      }
    }
    return results;
  }

  /**
   * Get actors from a specific node.
   */
  async getActors(name: string): Promise<Array<{ actorId: string; name?: string; className: string; migratable: boolean; childCount: number }>> {
    const response = await this.sendAndWait(name, { type: "actors" }, "actors", 5000);
    return response.actors;
  }

  getRunningNodes(): string[] {
    return Array.from(this.nodes.keys());
  }

  getNode(name: string): ManagedNode | undefined {
    return this.nodes.get(name);
  }

  isRunning(): boolean {
    return this.nodes.size > 0;
  }
}
