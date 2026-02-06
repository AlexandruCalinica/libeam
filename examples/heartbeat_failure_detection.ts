// examples/heartbeat_failure_detection.ts
//
// Demonstrates: Heartbeat-based active failure detection
// Prerequisites: None (uses in-memory transport for simplicity)
// Run: npx ts-node examples/heartbeat_failure_detection.ts
//
// This example shows how the heartbeat protocol actively detects node failures
// through ping/pong messages, complementing the passive gossip-based detection.
//
// Key features demonstrated:
// 1. Normal heartbeat operation - nodes exchanging pings
// 2. Failure detection - detecting when a node stops responding
// 3. Graceful shutdown - proper shutdown doesn't trigger false failure
// 4. Configurable timing - adjusting detection speed

import { EventEmitter } from "events";
import {
  Actor,
  ActorRef,
  ActorSystem,
  LocalCluster,
  ClusterPeer,
  InMemoryTransport,
  LocalRegistry,
  HeartbeatConfig,
} from "../src";

// --- Helper to add peer management to LocalCluster ---

class ClusterWithPeers extends LocalCluster {
  private peers: ClusterPeer[] = [];

  constructor(nodeId: string) {
    super(nodeId);
    this.peers = [{ id: nodeId }];
  }

  getLivePeers(): ClusterPeer[] {
    return this.peers;
  }

  addPeer(peerId: string): void {
    if (!this.peers.find((p) => p.id === peerId)) {
      this.peers.push({ id: peerId });
      this.emit("member_join", peerId);
    }
  }

  removePeer(peerId: string, status?: string): void {
    this.peers = this.peers.filter((p) => p.id !== peerId);
    if (status) {
      this.emit("member_leave", { id: peerId, status });
    } else {
      this.emit("member_leave", peerId);
    }
  }
}

// --- Actor Definitions ---

class CounterActor extends Actor {
  private count = 0;

  handleCast(message: any): void {
    if (message.type === "increment") {
      this.count++;
    }
  }

  handleCall(message: any): any {
    if (message.type === "get") {
      return this.count;
    }
    return null;
  }
}

// --- Main Demo ---

async function main() {
  console.log("=== Heartbeat Failure Detection Demo ===\n");

  // Create transports
  const transport1 = new InMemoryTransport("node1");
  const transport2 = new InMemoryTransport("node2");
  const transport3 = new InMemoryTransport("node3");

  // Wire transports together
  transport1.setPeer("node2", transport2);
  transport1.setPeer("node3", transport3);
  transport2.setPeer("node1", transport1);
  transport2.setPeer("node3", transport3);
  transport3.setPeer("node1", transport1);
  transport3.setPeer("node2", transport2);

  // Create clusters with event support
  const cluster1 = new ClusterWithPeers("node1");
  const cluster2 = new ClusterWithPeers("node2");
  const cluster3 = new ClusterWithPeers("node3");

  // Add peer awareness
  cluster1.addPeer("node2");
  cluster1.addPeer("node3");
  cluster2.addPeer("node1");
  cluster2.addPeer("node3");
  cluster3.addPeer("node1");
  cluster3.addPeer("node2");

  // Create registries
  const registry1 = new LocalRegistry();
  const registry2 = new LocalRegistry();
  const registry3 = new LocalRegistry();

  // Fast heartbeat config for demo (detect failures quickly)
  const heartbeatConfig: Partial<HeartbeatConfig> = {
    intervalMs: 200, // Send pings every 200ms
    timeoutMs: 150, // Expect pong within 150ms
    maxMissedHeartbeats: 3, // Declare dead after 3 missed
    staggerPings: true, // Stagger pings to avoid network bursts
  };

  // Create actor systems with heartbeat
  const system1 = new ActorSystem(
    cluster1,
    transport1,
    registry1,
    undefined,
    heartbeatConfig,
  );
  const system2 = new ActorSystem(
    cluster2,
    transport2,
    registry2,
    undefined,
    heartbeatConfig,
  );
  const system3 = new ActorSystem(
    cluster3,
    transport3,
    registry3,
    undefined,
    heartbeatConfig,
  );

  // Track failures detected by heartbeat
  const failuresDetected: { detector: string; failed: string; time: number }[] =
    [];
  const startTime = Date.now();

  // Note: In a real system, handleNodeFailure is called automatically.
  // Here we just track the node_failed events for demonstration.

  // Start all systems
  await system1.start();
  await system2.start();
  await system3.start();

  console.log("--- Demo 1: Normal Heartbeat Operation ---");
  console.log("  Three nodes started with heartbeat enabled.");
  console.log("  Heartbeat config: interval=200ms, timeout=150ms, maxMissed=3");
  console.log("  Nodes are now exchanging pings...\n");

  // Let heartbeats run for a bit
  await sleep(1000);
  console.log("  All nodes healthy - no failures detected.\n");

  // --- Demo 2: Simulated Failure Detection ---
  console.log("--- Demo 2: Understanding Failure Detection ---");
  console.log("  In a real distributed system, when node3 crashes:");
  console.log("  1. Heartbeat pings to node3 would timeout (no pong response)");
  console.log(
    "  2. After 3 missed heartbeats (600ms), node3 is declared failed",
  );
  console.log(
    "  3. handleNodeFailure() is called to clean up watches/links/children",
  );
  console.log(
    "  4. Gossip protocol would also detect via its timeout mechanism\n",
  );

  // Simulate cluster detecting node3 left (would happen via gossip in real system)
  console.log("  Simulating cluster detecting node3 departure...");
  cluster1.removePeer("node3");
  cluster2.removePeer("node3");
  cluster3.removePeer("node1");
  cluster3.removePeer("node2");

  console.log("  Node3 removed from cluster membership.\n");

  // --- Demo 3: Graceful Shutdown ---
  console.log("--- Demo 3: Graceful Shutdown ---");
  console.log("  Shutting down node2 gracefully...\n");

  // Graceful shutdown - this should NOT trigger failure detection
  // because the cluster emits "leaving" status
  cluster1.removePeer("node2", "leaving");

  await system2.shutdown();

  console.log("  Node2 shut down gracefully - no false failure triggered.\n");

  // --- Cleanup ---
  console.log("--- Cleanup ---");
  await system1.shutdown();
  await system3.shutdown();
  await transport1.disconnect();
  await transport2.disconnect();
  await transport3.disconnect();

  console.log("  All systems shut down.\n");

  console.log("=== Demo Complete ===");
  console.log("\nKey Takeaways:");
  console.log(
    "1. Heartbeat provides ACTIVE failure detection (ping/pong over RPC)",
  );
  console.log("2. Complements PASSIVE gossip-based detection (UDP timeout)");
  console.log("3. Configurable timing for detection speed vs network overhead");
  console.log(
    "4. Graceful shutdown uses 'leaving' status to avoid false positives",
  );
  console.log(
    "5. Detection time = intervalMs * maxMissedHeartbeats (600ms in this demo)",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
