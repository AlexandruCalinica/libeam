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
// - GossipProtocol with GossipUDP for cluster membership
// - Registry-based actor discovery across nodes
// - Using getActorByName() to get remote actor references
// - Bidirectional communication between distributed actors

import {
  Actor,
  ActorRef,
  ActorSystem,
  ZeroMQTransport,
  RegistryGossip,
  GossipRegistry,
  CustomGossipCluster,
  GossipProtocol,
  GossipUDP,
} from "../src";

// --- Configuration ---
const CONFIG = {
  node1: {
    nodeId: "node1",
    rpcPort: 5555,
    pubPort: 5556,
    gossipPort: 6001,
    address: "127.0.0.1",
  },
  node2: {
    nodeId: "node2",
    rpcPort: 5557,
    pubPort: 5558,
    gossipPort: 6002,
    address: "127.0.0.1",
  },
};

// --- Actor Definitions ---

class PingActor extends Actor {
  private pongRef: ActorRef | null = null;
  private count = 0;

  async init() {
    console.log(
      `[${CONFIG.node1.nodeId}] PingActor initialized, waiting for PongActor...`,
    );
  }

  async handleCast(message: any): Promise<void> {
    if (message.type === "start") {
      // Look up the PongActor by name using the registry
      this.pongRef = await this.context.system.getActorByName("pong");
      if (this.pongRef) {
        console.log(
          `[${CONFIG.node1.nodeId}] Found PongActor, starting ping-pong!`,
        );
        // Send our registered name so the receiver can look us up
        this.pongRef.cast({ type: "ping", fromName: "ping", count: 0 });
      } else {
        console.log(
          `[${CONFIG.node1.nodeId}] PongActor not found yet, retrying in 1s...`,
        );
        setTimeout(() => this.self.cast({ type: "start" }), 1000);
      }
    } else if (message.type === "pong") {
      this.count = message.count;
      console.log(`[${CONFIG.node1.nodeId}] Received pong #${this.count}`);

      if (this.count < 5) {
        // Continue the game
        setTimeout(() => {
          if (this.pongRef) {
            this.pongRef.cast({
              type: "ping",
              fromName: "ping",
              count: this.count + 1,
            });
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
  private pingRef: ActorRef | null = null;

  init() {
    console.log(`[${CONFIG.node2.nodeId}] PongActor initialized and ready!`);
  }

  async handleCast(message: any): Promise<void> {
    if (message.type === "ping") {
      this.count = message.count;
      console.log(
        `[${CONFIG.node2.nodeId}] Received ping #${this.count}, sending pong...`,
      );

      // Look up the sender by name if we don't have a cached ref
      if (!this.pingRef && message.fromName) {
        this.pingRef = await this.context.system.getActorByName(
          message.fromName,
        );
      }

      if (this.pingRef) {
        setTimeout(() => {
          this.pingRef!.cast({ type: "pong", count: this.count });
        }, 500);
      } else {
        console.log(
          `[${CONFIG.node2.nodeId}] Could not find ping actor to respond!`,
        );
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

// --- Node Setup Functions ---

async function runNode1() {
  console.log("=== Starting Node 1 (Ping) ===\n");

  const config = CONFIG.node1;
  const peerConfig = CONFIG.node2;

  // Create ZeroMQ transport
  const transport = new ZeroMQTransport({
    nodeId: config.nodeId,
    rpcPort: config.rpcPort,
    pubPort: config.pubPort,
  });

  // IMPORTANT: connect() first to initialize sockets, then updatePeers()
  await transport.connect();

  // Set up peers - RPC address for ZeroMQ (must be after connect for SUB socket)
  transport.updatePeers([
    [peerConfig.nodeId, `tcp://${peerConfig.address}:${peerConfig.rpcPort}`],
  ]);
  console.log(`[${config.nodeId}] Transport connected, peer configured`);

  // Create GossipUDP for cluster membership
  const gossipUDP = new GossipUDP({
    address: config.address,
    port: config.gossipPort,
  });

  // Create GossipProtocol with real UDP
  const gossipProtocol = new GossipProtocol(
    config.nodeId,
    `tcp://${config.address}:${config.rpcPort}`, // RPC address
    `${config.address}:${config.gossipPort}`, // Gossip UDP address
    gossipUDP,
    {
      seedNodes: [`${peerConfig.address}:${peerConfig.gossipPort}`],
      gossipIntervalMs: 500,
      cleanupIntervalMs: 1000,
      failureTimeoutMs: 5000,
      gossipFanout: 2,
    },
  );

  // Create cluster wrapper and start gossip protocol
  const cluster = new CustomGossipCluster(gossipProtocol);
  await cluster.start();
  console.log(`[${config.nodeId}] Cluster started, gossip protocol running`);

  // Create registry for actor discovery
  const registryGossip = new RegistryGossip(config.nodeId, transport, cluster);
  await registryGossip.connect();
  const registry = new GossipRegistry(config.nodeId, registryGossip);
  console.log(`[${config.nodeId}] Registry connected`);

  // Create actor system
  const system = new ActorSystem(cluster, transport, registry);
  system.registerActorClasses([PingActor, PongActor]);
  await system.start();
  console.log(`[${config.nodeId}] Actor system started`);

  // Spawn the PingActor with a registered name
  const pingRef = system.spawn(PingActor, { name: "ping" });
  console.log(`[${config.nodeId}] PingActor spawned with ID: ${pingRef.id.id}`);

  // Wait a moment for node2 to start, then begin the game
  console.log(`[${config.nodeId}] Waiting for PongActor to be available...`);
  setTimeout(() => {
    pingRef.cast({ type: "start" });
  }, 3000);

  // Keep the process running
  console.log(`[${config.nodeId}] Press Ctrl+C to stop\n`);

  process.on("SIGINT", async () => {
    console.log(`\n[${config.nodeId}] Shutting down...`);
    await system.shutdown();
    await cluster.leave();
    await transport.disconnect();
    process.exit(0);
  });
}

async function runNode2() {
  console.log("=== Starting Node 2 (Pong) ===\n");

  const config = CONFIG.node2;
  const peerConfig = CONFIG.node1;

  // Create ZeroMQ transport
  const transport = new ZeroMQTransport({
    nodeId: config.nodeId,
    rpcPort: config.rpcPort,
    pubPort: config.pubPort,
  });

  // IMPORTANT: connect() first to initialize sockets, then updatePeers()
  await transport.connect();

  // Set up peers - RPC address for ZeroMQ (must be after connect for SUB socket)
  transport.updatePeers([
    [peerConfig.nodeId, `tcp://${peerConfig.address}:${peerConfig.rpcPort}`],
  ]);
  console.log(`[${config.nodeId}] Transport connected, peer configured`);

  // Create GossipUDP for cluster membership
  const gossipUDP = new GossipUDP({
    address: config.address,
    port: config.gossipPort,
  });

  // Create GossipProtocol with real UDP
  const gossipProtocol = new GossipProtocol(
    config.nodeId,
    `tcp://${config.address}:${config.rpcPort}`, // RPC address
    `${config.address}:${config.gossipPort}`, // Gossip UDP address
    gossipUDP,
    {
      seedNodes: [`${peerConfig.address}:${peerConfig.gossipPort}`],
      gossipIntervalMs: 500,
      cleanupIntervalMs: 1000,
      failureTimeoutMs: 5000,
      gossipFanout: 2,
    },
  );

  // Create cluster wrapper and start gossip protocol
  const cluster = new CustomGossipCluster(gossipProtocol);
  await cluster.start();
  console.log(`[${config.nodeId}] Cluster started, gossip protocol running`);

  // Create registry for actor discovery
  const registryGossip = new RegistryGossip(config.nodeId, transport, cluster);
  await registryGossip.connect();
  const registry = new GossipRegistry(config.nodeId, registryGossip);
  console.log(`[${config.nodeId}] Registry connected`);

  // Create actor system
  const system = new ActorSystem(cluster, transport, registry);
  system.registerActorClasses([PingActor, PongActor]);
  await system.start();
  console.log(`[${config.nodeId}] Actor system started`);

  // Spawn the PongActor with a registered name
  const pongRef = system.spawn(PongActor, { name: "pong" });
  console.log(`[${config.nodeId}] PongActor spawned with ID: ${pongRef.id.id}`);
  console.log(`[${config.nodeId}] Waiting for pings...\n`);

  // Keep the process running
  console.log(`[${config.nodeId}] Press Ctrl+C to stop\n`);

  process.on("SIGINT", async () => {
    console.log(`\n[${config.nodeId}] Shutting down...`);
    await system.shutdown();
    await cluster.leave();
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
    console.log(
      "Usage: npx ts-node examples/distributed_ping_pong.ts <node1|node2>",
    );
    console.log("");
    console.log("Run in two separate terminals:");
    console.log(
      "  Terminal 1: npx ts-node examples/distributed_ping_pong.ts node1",
    );
    console.log(
      "  Terminal 2: npx ts-node examples/distributed_ping_pong.ts node2",
    );
    console.log("");
    console.log(
      "This demonstrates distributed actors communicating via ZeroMQ",
    );
    console.log("with GossipProtocol for cluster membership discovery.");
    process.exit(1);
  }
}

main().catch(console.error);
