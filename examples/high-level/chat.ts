// examples/high-level/chat.ts
//
// Demonstrates: Multi-actor communication with functional API
// Run: npx tsx examples/high-level/chat.ts
//
// This example shows:
// - Multiple actor types communicating via message passing
// - ChatRoom broadcasting to User actors
// - Single-node chat (no distributed setup needed)

import { createSystem, createActor, ActorRef } from "../../src";

const methodMsg = (method: string, ...args: any[]) => ({ method, args });

// --- Actor Definitions ---

const ChatRoom = createActor((ctx, self) => {
  const participants = new Map<string, ActorRef>();

  self
    .call("getParticipants", () => Array.from(participants.keys()))
    .cast("join", (name: string, ref: ActorRef) => {
      participants.set(name, ref);
      broadcast(`${name} has joined the chat.`);
      console.log(`  [ChatRoom] ${name} joined (${participants.size} total)`);
    })
    .cast("leave", (name: string) => {
      participants.delete(name);
      broadcast(`${name} has left the chat.`);
      console.log(`  [ChatRoom] ${name} left (${participants.size} total)`);
    })
    .cast("message", (from: string, text: string) => {
      broadcast(`[${from}] ${text}`);
    });

  function broadcast(text: string) {
    for (const ref of participants.values()) {
      ref.cast(methodMsg("notify", text));
    }
  }
});

const User = createActor((ctx, self, name: string, roomRef: ActorRef) => {
  const received: string[] = [];

  // Join the room on init
  roomRef.cast(methodMsg("join", name, ctx.self));

  self
    .call("getMessages", () => [...received])
    .cast("notify", (text: string) => {
      received.push(text);
      console.log(`  [${name}] ${text}`);
    })
    .cast("say", (text: string) => {
      roomRef.cast(methodMsg("message", name, text));
    });
});

// --- Main ---

async function main() {
  console.log("=== Functional Chat ===\n");
  const system = createSystem();

  try {
    // Create room
    const room = system.spawn(ChatRoom);

    // Create users (they auto-join on spawn)
    const alice = system.spawn(User, { args: ["Alice", room] });
    const bob = system.spawn(User, { args: ["Bob", room] });
    const charlie = system.spawn(User, { args: ["Charlie", room] });
    await new Promise((r) => setTimeout(r, 100));

    const members = await room.call("getParticipants");
    console.log(`\n  Participants: ${JSON.stringify(members)}\n`);

    // Simulate conversation
    console.log("--- Conversation ---\n");
    alice.cast("say", "Hello everyone!");
    await new Promise((r) => setTimeout(r, 100));

    bob.cast("say", "Hi Alice!");
    await new Promise((r) => setTimeout(r, 100));

    charlie.cast("say", "Hey folks, what's up?");
    await new Promise((r) => setTimeout(r, 100));

    // Check Alice's received messages
    const aliceMessages = await alice.call("getMessages");
    console.log(`\n  Alice received ${aliceMessages.length} messages`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
