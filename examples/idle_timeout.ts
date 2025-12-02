// examples/idle_timeout.ts
//
// Demonstrates: Actor idle timeout for inactivity handling
// Prerequisites: None
// Run: npx ts-node examples/idle_timeout.ts

import {
  Actor,
  ActorSystem,
  ActorRef,
  Cluster,
  InMemoryTransport,
  InMemoryRegistry,
  InfoMessage,
  TimeoutMessage,
} from "../src";

// --- Mock Cluster ---

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

// --- Actor Definitions ---

/**
 * A cache actor that clears entries after being idle.
 * Demonstrates: Basic idle timeout with cleanup action
 */
class CacheActor extends Actor {
  private cache = new Map<string, { value: any; timestamp: number }>();
  private timeoutCount = 0;

  init() {
    console.log("[Cache] Started - will clear after 200ms idle");
    this.setIdleTimeout(200);
  }

  handleCast(message: any) {
    if (message.type === "set") {
      this.cache.set(message.key, {
        value: message.value,
        timestamp: Date.now(),
      });
      console.log(`[Cache] Set "${message.key}" = "${message.value}" (size: ${this.cache.size})`);
    } else if (message.type === "delete") {
      this.cache.delete(message.key);
      console.log(`[Cache] Deleted "${message.key}" (size: ${this.cache.size})`);
    }
  }

  handleCall(message: any) {
    if (message.type === "get") {
      const entry = this.cache.get(message.key);
      return entry?.value ?? null;
    } else if (message.type === "size") {
      return this.cache.size;
    } else if (message.type === "getTimeoutCount") {
      return this.timeoutCount;
    }
    return null;
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "timeout") {
      this.timeoutCount++;
      const timeout = message as TimeoutMessage;
      console.log(`[Cache] IDLE TIMEOUT after ${timeout.idleMs}ms - clearing cache`);
      this.cache.clear();
    }
  }

  terminate() {
    console.log("[Cache] Terminated");
  }
}

/**
 * A session actor that warns and then expires after inactivity.
 * Demonstrates: Changing timeout values and self-termination
 */
class SessionActor extends Actor {
  private userId: string = "";
  private state: "active" | "warning" | "expired" = "active";
  private lastActivity = Date.now();
  private activityLog: string[] = [];

  init(userId: string) {
    this.userId = userId;
    console.log(`[Session:${userId}] Started - active`);
    // First timeout: warn after 150ms
    this.setIdleTimeout(150);
  }

  handleCast(message: any) {
    if (message.type === "activity") {
      this.lastActivity = Date.now();
      this.activityLog.push(message.action);
      console.log(`[Session:${this.userId}] Activity: ${message.action}`);

      // Reset to active state if we were in warning
      if (this.state === "warning") {
        console.log(`[Session:${this.userId}] Back to active (was warning)`);
        this.state = "active";
        this.setIdleTimeout(150); // Reset to warning timeout
      }
    }
  }

  handleCall(message: any) {
    if (message.type === "getState") {
      return this.state;
    } else if (message.type === "getActivityLog") {
      return this.activityLog;
    }
    return null;
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "timeout") {
      const timeout = message as TimeoutMessage;

      if (this.state === "active") {
        // First timeout - switch to warning state
        this.state = "warning";
        console.log(
          `[Session:${this.userId}] WARNING: Idle for ${timeout.idleMs}ms - will expire in 100ms`,
        );
        // Set shorter timeout for expiration
        this.setIdleTimeout(100);
      } else if (this.state === "warning") {
        // Second timeout - expire the session
        this.state = "expired";
        console.log(`[Session:${this.userId}] EXPIRED after ${timeout.idleMs}ms more idle`);
        // Stop further timeouts
        this.setIdleTimeout(0);
      }
    }
  }

  terminate() {
    console.log(`[Session:${this.userId}] Terminated (state: ${this.state})`);
  }
}

/**
 * A connection pool actor that prunes idle connections.
 * Demonstrates: Periodic cleanup triggered by idle timeout
 */
class ConnectionPoolActor extends Actor {
  private connections = new Map<
    string,
    { lastUsed: number; active: boolean }
  >();
  private pruneCount = 0;
  private maxIdleMs = 100; // Connections idle for 100ms get pruned

  init() {
    console.log("[Pool] Started - will prune idle connections every 150ms");
    // Check for idle connections every 150ms
    this.setIdleTimeout(150);
  }

  handleCast(message: any) {
    if (message.type === "acquire") {
      const connId = `conn-${this.connections.size + 1}`;
      this.connections.set(connId, { lastUsed: Date.now(), active: true });
      console.log(`[Pool] Acquired ${connId} (total: ${this.connections.size})`);
    } else if (message.type === "release") {
      const conn = this.connections.get(message.connId);
      if (conn) {
        conn.active = false;
        conn.lastUsed = Date.now();
        console.log(`[Pool] Released ${message.connId}`);
      }
    } else if (message.type === "use") {
      const conn = this.connections.get(message.connId);
      if (conn) {
        conn.lastUsed = Date.now();
      }
    }
  }

  handleCall(message: any) {
    if (message.type === "getConnectionCount") {
      return this.connections.size;
    } else if (message.type === "getPruneCount") {
      return this.pruneCount;
    } else if (message.type === "getConnections") {
      return Array.from(this.connections.keys());
    }
    return null;
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "timeout") {
      // Prune idle connections
      const now = Date.now();
      const toPrune: string[] = [];

      for (const [id, conn] of this.connections.entries()) {
        if (!conn.active && now - conn.lastUsed > this.maxIdleMs) {
          toPrune.push(id);
        }
      }

      if (toPrune.length > 0) {
        for (const id of toPrune) {
          this.connections.delete(id);
          this.pruneCount++;
        }
        console.log(`[Pool] Pruned ${toPrune.length} idle connections: ${toPrune.join(", ")}`);
      } else {
        console.log("[Pool] Prune check: no idle connections to prune");
      }
    }
  }

  terminate() {
    console.log(`[Pool] Terminated (pruned ${this.pruneCount} connections total)`);
  }
}

/**
 * A worker actor that self-stops after being idle.
 * Demonstrates: Actor self-termination on timeout
 */
class IdleWorkerActor extends Actor {
  private workerId: string = "";
  private jobsCompleted = 0;

  init(workerId: string) {
    this.workerId = workerId;
    console.log(`[Worker:${workerId}] Started - will stop after 200ms idle`);
    this.setIdleTimeout(200);
  }

  handleCast(message: any) {
    if (message.type === "job") {
      this.jobsCompleted++;
      console.log(`[Worker:${this.workerId}] Completed job #${this.jobsCompleted}: ${message.task}`);
    }
  }

  handleCall(message: any) {
    if (message.type === "getJobsCompleted") {
      return this.jobsCompleted;
    }
    return null;
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "timeout") {
      const timeout = message as TimeoutMessage;
      console.log(
        `[Worker:${this.workerId}] IDLE for ${timeout.idleMs}ms - stopping self`,
      );
      this.context.system.stop(this.self);
    }
  }

  terminate() {
    console.log(`[Worker:${this.workerId}] Terminated (completed ${this.jobsCompleted} jobs)`);
  }
}

// --- Main ---

async function main() {
  console.log("=== Idle Timeout Example ===\n");
  console.log("Idle timeout sends a TimeoutMessage via handleInfo()");
  console.log("when an actor hasn't received any messages for a period.\n");

  const cluster = new MockCluster("node1");
  const transport = new InMemoryTransport(cluster.nodeId);
  const registry = new InMemoryRegistry();
  const system = new ActorSystem(cluster, transport, registry);
  await system.start();

  try {
    // Demo 1: Cache with idle cleanup
    console.log("--- Demo 1: Cache (idle cleanup) ---\n");

    const cache = system.spawn(CacheActor);

    cache.cast({ type: "set", key: "user:1", value: "Alice" });
    cache.cast({ type: "set", key: "user:2", value: "Bob" });
    await sleep(50);

    let size = await cache.call({ type: "size" });
    console.log(`Cache size: ${size}`);

    // Let it go idle - cache will clear
    console.log("\nWaiting for idle timeout...\n");
    await sleep(250);

    size = await cache.call({ type: "size" });
    const timeouts = await cache.call({ type: "getTimeoutCount" });
    console.log(`Cache size after timeout: ${size}`);
    console.log(`Timeout count: ${timeouts}\n`);

    await system.stop(cache);

    // Demo 2: Session with warning and expiration
    console.log("\n--- Demo 2: Session (warning then expire) ---\n");

    const session = system.spawn(SessionActor, { args: ["user-123"] });

    session.cast({ type: "activity", action: "login" });
    await sleep(50);
    session.cast({ type: "activity", action: "view_page" });
    await sleep(50);

    let state = await session.call({ type: "getState" });
    console.log(`Session state: ${state}`);

    // Let it go idle - should warn first
    console.log("\nWaiting for warning...\n");
    await sleep(160);

    state = await session.call({ type: "getState" });
    console.log(`Session state: ${state}`);

    // Activity resets to active
    session.cast({ type: "activity", action: "click_button" });
    await sleep(50);

    state = await session.call({ type: "getState" });
    console.log(`Session state after activity: ${state}`);

    // Let it expire this time
    console.log("\nWaiting for expiration...\n");
    await sleep(300);

    state = await session.call({ type: "getState" });
    console.log(`Final session state: ${state}\n`);

    await system.stop(session);

    // Demo 3: Connection pool with periodic pruning
    console.log("\n--- Demo 3: Connection Pool (periodic pruning) ---\n");

    const pool = system.spawn(ConnectionPoolActor);

    pool.cast({ type: "acquire" }); // conn-1
    pool.cast({ type: "acquire" }); // conn-2
    pool.cast({ type: "acquire" }); // conn-3
    await sleep(50);

    pool.cast({ type: "release", connId: "conn-1" });
    pool.cast({ type: "release", connId: "conn-2" });
    // conn-3 stays active

    let count = await pool.call({ type: "getConnectionCount" });
    console.log(`\nConnection count: ${count}`);

    // Wait for prune cycle
    console.log("\nWaiting for prune cycle...\n");
    await sleep(200);

    count = await pool.call({ type: "getConnectionCount" });
    const pruned = await pool.call({ type: "getPruneCount" });
    const conns = await pool.call({ type: "getConnections" });
    console.log(`Connection count after prune: ${count}`);
    console.log(`Connections pruned: ${pruned}`);
    console.log(`Remaining: ${JSON.stringify(conns)}`);
    console.log("(conn-1 and conn-2 were pruned, conn-3 is still active)\n");

    await system.stop(pool);

    // Demo 4: Worker that self-stops when idle
    console.log("\n--- Demo 4: Worker (self-stop on idle) ---\n");

    const worker = system.spawn(IdleWorkerActor, { args: ["W1"] });

    worker.cast({ type: "job", task: "process_file" });
    await sleep(50);
    worker.cast({ type: "job", task: "send_email" });
    await sleep(50);

    let jobs = await worker.call({ type: "getJobsCompleted" });
    console.log(`Jobs completed: ${jobs}`);

    // Let it go idle - worker will stop itself
    console.log("\nWaiting for worker to self-stop...\n");
    await sleep(250);

    // Worker should have stopped itself
    const remaining = system.getLocalActorIds();
    console.log(`Remaining actors: ${remaining.length}`);
    console.log("(Worker stopped itself after idle timeout)\n");

    // Cleanup
    await system.shutdown();
  } catch (err) {
    console.error("Error:", err);
    await system.shutdown();
  }

  console.log("=== Done ===");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
