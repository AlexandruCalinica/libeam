// examples/distributed_ping_pong.ts
//
// Demonstrates: Distributed actors communicating across nodes using ZeroMQ
// Prerequisites: Two terminals or two machines with network access
// Run:
//   Terminal 1: npx ts-node examples/distributed_ping_pong.ts node1
//   Terminal 2: npx ts-node examples/distributed_ping_pong.ts node2
//
// This example shows:
// - Setting up ZeroMQ transport for real network communication
// - Registry-based actor discovery across nodes
// - Using getActorByName() to get remote actor references
// - Bidirectional communication between distributed actors

import {
  Actor,
  ActorRef,
  ActorSystem,
  ActorId,
  ZeroMQTransport,
  RegistryGossip,
  GossipRegistry,
  CustomGossipCluster,
  GossipProtocol,
} from "../src";

// --- Configuration ---
const CONFIG = {
  node1: {
    nodeId: "node1",
    rpcPort: 5555,
    pubPort: 5556,
    address: "tcp://127.0.0.1",
  },
  node2: {
    nodeId: "node2",
    rpcPort: 5557,
    pubPort: 5558,
    address: "tcp://127.0.0.1",
  },
};

// --- Actor Definitions ---

class PingActor extends Actor {
  private pongRef: ActorRef | null = null;
  private count = 0;

  async init() {
    console.log(`[${CONFIG.node1.nodeId}] PingActor initialized, waiting for PongActor...`);
  }

  async handleCast(message: any): Promise<void> {
    if (message.type === "start") {
      // Look up the PongActor by name
      this.pongRef = await this.context.system.getActorByName("pong");
      if (this.pongRef) {
        console.log(`[${CONFIG.node1.nodeId}] Found PongActor, starting ping-pong!`);
        this.pongRef.cast({ type: "ping", from: this.self, count: 0 });
      } else {
        console.log(`[${CONFIG.node1.nodeId}] PongActor not found yet, retrying...`);
        setTimeout(() => this.self.cast({ type: "start" }), 1000);
      }
    } else if (message.type === "pong") {
      this.count = message.count;
      console.log(`[${CONFIG.node1.nodeId}] Received pong #${this.count}`);

      if (this.count < 5) {
        // Continue the game
        setTimeout(() => {
          if (this.pongRef) {
            this.pongRef.cast({ type: "ping", from: this.self, count: this.count + 1 });
          }
        }, 500);
      } else {
        console.log(`[${CONFIG.node1.nodeId}] Game complete!`);
      }
    }
  }

  handleCall(message: any): any {
    if (message.type === "getCount") {
      return this.count;
    }
    return null;
  }
}

class PongActor extends Actor {
  private count = 0;

  init() {
    console.log(`[${CONFIG.node2.nodeId}] PongActor initialized and ready!`);
  }

  handleCast(message: any): void {
    if (message.type === "ping") {
      this.count = message.count;
      console.log(`[${CONFIG.node2.nodeId}] Received ping #${this.count}, sending pong...`);

      // Get the sender's ref and respond
      const senderRef = message.from as ActorRef;
      setTimeout(() => {
        senderRef.cast({ type: "pong", count: this.count });
      }, 500);
    }
  }

  handleCall(message: any): any {
    if (message.type === "getCount") {
      return this.count;
    }
    return null;
  }
}

// --- Helper Functions ---

function createGossipProtocol(nodeId: string, peers: string[]): GossipProtocol {
  // Create a mock gossip protocol for local testing
  // In production, you'd use actual network discovery
  return {
    nodeId,
    getLivePeers: () =>
      peers.map((id) => ({
        id,
        address:
          id === "node1"
            ? `${CONFIG.node1.address}:${CONFIG.node1.rpcPort}`
            : `${CONFIG.node2.address}:${CONFIG.node2.rpcPort}`,
        state: "alive" as const,
        generation: 1,
        metadata: {},
      })),
    on: () => {},
    emit: () => {},
  } as any;
}

async function runNode1() {
  console.log("=== Starting Node 1 (Ping) ===\n");

  const config = CONFIG.node1;
  const peerConfig = CONFIG.node2;

  // Create transport
  const transport = new ZeroMQTransport(
    config.nodeId,
    `${config.address}:${config.rpcPort}`,
    `${config.address}:${config.pubPort}`,
  );

  // Set up peers
  transport.updatePeers([
    [peerConfig.nodeId, `${peerConfig.address}:${peerConfig.rpcPort}`],
  ]);

  await transport.connect();

  // Create cluster and registry
  const gossipProtocol = createGossipProtocol(config.nodeId, [peerConfig.nodeId]);
  const cluster = new CustomGossipCluster(gossipProtocol);
  const registryGossip = new RegistryGossip(config.nodeId, transport, cluster);
  await registryGossip.connect();
  const registry = new GossipRegistry(registryGossip);

  // Create actor system
  const system = new ActorSystem(cluster as any, transport, registry);
  system.registerActorClasses([PingActor, PongActor]);
  await system.start();

  // Spawn the PingActor with a registered name
  const pingRef = system.spawn(PingActor, { name: "ping" });
  console.log(`[${config.nodeId}] PingActor spawned with ID: ${pingRef.id.id}`);

  // Wait a moment for node2 to start, then begin the game
  console.log(`[${config.nodeId}] Waiting for PongActor to be available...`);
  setTimeout(() => {
    pingRef.cast({ type: "start" });
  }, 2000);

  // Keep the process running
  console.log(`[${config.nodeId}] Press Ctrl+C to stop\n`);

  process.on("SIGINT", async () => {
    console.log(`\n[${config.nodeId}] Shutting down...`);
    await system.shutdown();
    await transport.disconnect();
    process.exit(0);
  });
}

async function runNode2() {
  console.log("=== Starting Node 2 (Pong) ===\n");

  const config = CONFIG.node2;
  const peerConfig = CONFIG.node1;

  // Create transport
  const transport = new ZeroMQTransport(
    config.nodeId,
    `${config.address}:${config.rpcPort}`,
    `${config.address}:${config.pubPort}`,
  );

  // Set up peers
  transport.updatePeers([
    [peerConfig.nodeId, `${peerConfig.address}:${peerConfig.rpcPort}`],
  ]);

  await transport.connect();

  // Create cluster and registry
  const gossipProtocol = createGossipProtocol(config.nodeId, [peerConfig.nodeId]);
  const cluster = new CustomGossipCluster(gossipProtocol);
  const registryGossip = new RegistryGossip(config.nodeId, transport, cluster);
  await registryGossip.connect();
  const registry = new GossipRegistry(registryGossip);

  // Create actor system
  const system = new ActorSystem(cluster as any, transport, registry);
  system.registerActorClasses([PingActor, PongActor]);
  await system.start();

  // Spawn the PongActor with a registered name
  const pongRef = system.spawn(PongActor, { name: "pong" });
  console.log(`[${config.nodeId}] PongActor spawned with ID: ${pongRef.id.id}`);
  console.log(`[${config.nodeId}] Waiting for pings...\n`);

  // Keep the process running
  console.log(`[${config.nodeId}] Press Ctrl+C to stop\n`);

  process.on("SIGINT", async () => {
    console.log(`\n[${config.nodeId}] Shutting down...`);
    await system.shutdown();
    await transport.disconnect();
    process.exit(0);
  });
}

// --- Main ---

async function main() {
  const nodeArg = process.argv[2];

  if (nodeArg === "node1") {
    await runNode1();
  } else if (nodeArg === "node2") {
    await runNode2();
  } else {
    console.log("Usage: npx ts-node examples/distributed_ping_pong.ts <node1|node2>");
    console.log("");
    console.log("Run in two separate terminals:");
    console.log("  Terminal 1: npx ts-node examples/distributed_ping_pong.ts node1");
    console.log("  Terminal 2: npx ts-node examples/distributed_ping_pong.ts node2");
    console.log("");
    console.log("This demonstrates distributed actors communicating via ZeroMQ.");
    process.exit(1);
  }
}

main().catch(console.error);
