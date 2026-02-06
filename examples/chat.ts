// examples/chat.ts

import {
  Actor,
  ActorRef,
  ActorSystem,
  LocalCluster,
  LocalRegistry,
  InMemoryTransport,
} from "../src";

// --- Actor Definitions ---

class ChatRoomActor extends Actor {
  private participants: Map<string, ActorRef> = new Map();

  init() {
    console.log("[ChatRoom] The chat room is now open.");
  }

  handleCall(message: { type: "get_participants" }): string[] {
    return Array.from(this.participants.keys());
  }

  handleCast(
    message:
      | { type: "join"; name: string; ref: ActorRef }
      | { type: "message"; from: string; text: string },
  ): void {
    if (message.type === "join") {
      this.participants.set(message.name, message.ref);
      this.broadcast(`${message.name} has joined the chat.`);
      console.log(
        `[ChatRoom] ${message.name} joined. Participants: ${this.participants.size}`,
      );
    } else if (message.type === "message") {
      this.broadcast(`[${message.from}] ${message.text}`);
    }
  }

  private broadcast(text: string) {
    for (const p of this.participants.values()) {
      p.cast({ type: "room_message", text });
    }
  }
}

class UserActor extends Actor {
  private name: string = "";

  init(name: string, roomRef: ActorRef) {
    this.name = name;
    console.log(`[${this.name}] Actor initialized, joining room...`);
    roomRef.cast({ type: "join", name: this.name, ref: this.self });
  }

  handleCast(
    message:
      | { type: "room_message"; text: string }
      | { type: "send"; text: string; roomRef: ActorRef },
  ) {
    if (message.type === "room_message") {
      console.log(`[${this.name}] Received: ${message.text}`);
    } else if (message.type === "send") {
      console.log(`[${this.name}] Sending: ${message.text}`);
      message.roomRef.cast({
        type: "message",
        from: this.name,
        text: message.text,
      });
    }
  }
}

// --- Helper to add member management to LocalCluster ---

class ClusterWithMembers extends LocalCluster {
  private members: string[] = [];

  constructor(nodeId: string) {
    super(nodeId);
    this.members = [nodeId];
  }

  addMember(nodeId: string): void {
    if (!this.members.includes(nodeId)) {
      this.members.push(nodeId);
    }
  }

  override getMembers(): string[] {
    return [...this.members];
  }
}

// --- Main Simulation ---

async function main() {
  // Shared infrastructure
  const transport1 = new InMemoryTransport("node1");
  const transport2 = new InMemoryTransport("node2");

  // Wire transports together
  transport1.setPeer("node2", transport2);
  transport2.setPeer("node1", transport1);

  await transport1.connect();
  await transport2.connect();

  const registry1 = new LocalRegistry();
  const registry2 = new LocalRegistry();
  // @ts-ignore - share registry for demo
  registry2.registry = registry1.registry;

  // --- Node 1 Setup ---
  const cluster1 = new ClusterWithMembers("node1");
  cluster1.addMember("node2");
  const node1 = new ActorSystem(cluster1, transport1, registry1);

  // --- Node 2 Setup ---
  const cluster2 = new ClusterWithMembers("node2");
  cluster2.addMember("node1");
  const node2 = new ActorSystem(cluster2, transport2, registry2);

  // Register actor classes on both nodes for remote spawning
  node1.registerActorClasses([ChatRoomActor, UserActor]);
  node2.registerActorClasses([ChatRoomActor, UserActor]);

  // Start the nodes
  await node1.start();
  await node2.start();

  console.log("--- Cluster is running with two nodes: node1, node2 ---");

  // Spawn the main chat room on node1
  console.log("--- Spawning ChatRoom on node1 ---");
  const roomRef = node1.spawn(ChatRoomActor, {
    name: "chat_room",
    strategy: "local",
  });

  // Spawn users, letting the placement engine decide where they go
  console.log("--- Spawning 3 users with round-robin placement ---");
  const user1 = node1.spawn(UserActor, {
    args: ["Alice", roomRef],
    strategy: "round-robin",
  });
  const user2 = node1.spawn(UserActor, {
    args: ["Bob", roomRef],
    strategy: "round-robin",
  });
  const user3 = node1.spawn(UserActor, {
    args: ["Charlie", roomRef],
    strategy: "round-robin",
  });

  await new Promise((r) => setTimeout(r, 500)); // wait for users to join

  // Simulate sending messages
  console.log("--- Simulating chat messages ---");
  user1.cast({ type: "send", text: "Hello everyone!", roomRef });
  await new Promise((r) => setTimeout(r, 200));
  user2.cast({ type: "send", text: "Hi Alice!", roomRef });
  await new Promise((r) => setTimeout(r, 200));
  user3.cast({ type: "send", text: "Hey Bob, welcome!", roomRef });

  await new Promise((r) => setTimeout(r, 500));

  console.log("--- Final State ---");
  console.log("Node 1 actors:", node1.getLocalActorIds().length);
  console.log("Node 2 actors:", node2.getLocalActorIds().length);

  // Cleanup
  await transport1.disconnect();
  await transport2.disconnect();
}

main().catch(console.error);
