// examples/timers.ts
//
// Demonstrates: Actor timers (sendAfter, sendInterval, cancelTimer)
// Prerequisites: None
// Run: npx ts-node examples/timers.ts

import {
  Actor,
  ActorSystem,
  ActorRef,
  LocalCluster,
  InMemoryTransport,
  LocalRegistry,
  TimerRef,
} from "../src";



// --- Actor Definitions ---

/**
 * A heartbeat actor that sends periodic heartbeat messages.
 * Demonstrates: sendInterval for repeating timers
 */
class HeartbeatActor extends Actor {
  private heartbeatCount = 0;
  private intervalRef?: TimerRef;

  init() {
    console.log("[Heartbeat] Started - will send heartbeat every 200ms");
    // Start sending heartbeats every 200ms
    this.intervalRef = this.sendInterval({ type: "heartbeat" }, 200);
  }

  handleCast(message: any) {
    if (message.type === "heartbeat") {
      this.heartbeatCount++;
      console.log(`[Heartbeat] Beat #${this.heartbeatCount}`);
    } else if (message.type === "stop") {
      console.log("[Heartbeat] Stopping heartbeat timer");
      if (this.intervalRef) {
        this.cancelTimer(this.intervalRef);
      }
    }
  }

  handleCall(message: any) {
    if (message.type === "getCount") {
      return this.heartbeatCount;
    }
    return null;
  }

  terminate() {
    console.log("[Heartbeat] Terminated");
  }
}

/**
 * A reminder actor that schedules one-shot delayed messages.
 * Demonstrates: sendAfter for delayed one-shot timers
 */
class ReminderActor extends Actor {
  private reminders: string[] = [];

  init() {
    console.log("[Reminder] Started - ready to schedule reminders");
  }

  handleCast(message: any) {
    if (message.type === "schedule") {
      console.log(
        `[Reminder] Scheduling "${message.text}" in ${message.delayMs}ms`,
      );
      this.sendAfter({ type: "remind", text: message.text }, message.delayMs);
    } else if (message.type === "remind") {
      console.log(`[Reminder] REMINDER: ${message.text}`);
      this.reminders.push(message.text);
    }
  }

  handleCall(message: any) {
    if (message.type === "getReminders") {
      return this.reminders;
    }
    return null;
  }

  terminate() {
    console.log("[Reminder] Terminated");
  }
}

/**
 * A debounce actor that cancels previous timers when new input arrives.
 * Demonstrates: cancelTimer to cancel pending timers
 */
class DebounceActor extends Actor {
  private pendingTimer?: TimerRef;
  private lastValue?: string;
  private processedValues: string[] = [];

  init() {
    console.log("[Debounce] Started - will debounce inputs with 300ms delay");
  }

  handleCast(message: any) {
    if (message.type === "input") {
      // Cancel any pending timer
      if (this.pendingTimer) {
        this.cancelTimer(this.pendingTimer);
        console.log(`[Debounce] Cancelled pending timer for "${this.lastValue}"`);
      }

      this.lastValue = message.value;
      console.log(`[Debounce] Received input: "${message.value}" - waiting 300ms`);

      // Schedule new timer
      this.pendingTimer = this.sendAfter(
        { type: "process", value: message.value },
        300,
      );
    } else if (message.type === "process") {
      console.log(`[Debounce] Processing: "${message.value}"`);
      this.processedValues.push(message.value);
      this.pendingTimer = undefined;
    }
  }

  handleCall(message: any) {
    if (message.type === "getProcessed") {
      return this.processedValues;
    }
    return null;
  }

  terminate() {
    console.log("[Debounce] Terminated");
  }
}

/**
 * A timeout actor that implements request timeouts.
 * Demonstrates: Using timers for timeout handling
 */
class TimeoutActor extends Actor {
  private pendingRequests = new Map<
    string,
    { timer: TimerRef; resolve: (v: any) => void }
  >();
  private requestId = 0;

  init() {
    console.log("[Timeout] Started - handles requests with timeouts");
  }

  handleCast(message: any) {
    if (message.type === "timeout") {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        console.log(`[Timeout] Request ${message.requestId} timed out!`);
        this.pendingRequests.delete(message.requestId);
      }
    } else if (message.type === "complete") {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        console.log(`[Timeout] Request ${message.requestId} completed in time`);
        this.cancelTimer(pending.timer);
        this.pendingRequests.delete(message.requestId);
      }
    }
  }

  handleCall(message: any) {
    if (message.type === "startRequest") {
      const id = `req-${++this.requestId}`;
      console.log(
        `[Timeout] Starting request ${id} with ${message.timeoutMs}ms timeout`,
      );

      // Schedule timeout
      const timer = this.sendAfter(
        { type: "timeout", requestId: id },
        message.timeoutMs,
      );
      this.pendingRequests.set(id, { timer, resolve: () => {} });

      return id;
    } else if (message.type === "getPending") {
      return this.pendingRequests.size;
    }
    return null;
  }

  terminate() {
    // Cancel all pending timers
    this.cancelAllTimers();
    console.log("[Timeout] Terminated - cancelled all pending timers");
  }
}

// --- Main ---

async function main() {
  console.log("=== Actor Timers Example ===\n");

  const cluster = new LocalCluster("node1");
  const transport = new InMemoryTransport(cluster.nodeId);
  const registry = new LocalRegistry();
  const system = new ActorSystem(cluster, transport, registry);
  await system.start();

  try {
    // Demo 1: Heartbeat with sendInterval
    console.log("--- Demo 1: Heartbeat (sendInterval) ---\n");

    const heartbeat = system.spawn(HeartbeatActor);

    // Let it beat a few times
    await sleep(550);

    // Stop the heartbeat
    heartbeat.cast({ type: "stop" });
    await sleep(100);

    const count = await heartbeat.call({ type: "getCount" });
    console.log(`\nTotal heartbeats: ${count}\n`);

    // Demo 2: Reminders with sendAfter
    console.log("\n--- Demo 2: Reminders (sendAfter) ---\n");

    const reminder = system.spawn(ReminderActor);

    // Schedule multiple reminders at different times
    reminder.cast({ type: "schedule", text: "Take a break", delayMs: 100 });
    reminder.cast({ type: "schedule", text: "Check email", delayMs: 200 });
    reminder.cast({ type: "schedule", text: "Lunch time", delayMs: 300 });

    // Wait for all reminders
    await sleep(400);

    const reminders = await reminder.call({ type: "getReminders" });
    console.log(`\nAll reminders received: ${JSON.stringify(reminders)}\n`);

    // Demo 3: Debounce with cancelTimer
    console.log("\n--- Demo 3: Debounce (cancelTimer) ---\n");

    const debounce = system.spawn(DebounceActor);

    // Rapid inputs - only the last should be processed
    debounce.cast({ type: "input", value: "a" });
    await sleep(100);
    debounce.cast({ type: "input", value: "ab" });
    await sleep(100);
    debounce.cast({ type: "input", value: "abc" });

    // Wait for debounce to complete
    await sleep(400);

    const processed = await debounce.call({ type: "getProcessed" });
    console.log(`\nProcessed values: ${JSON.stringify(processed)}`);
    console.log("(Only 'abc' was processed - earlier inputs were debounced)\n");

    // Demo 4: Request timeouts
    console.log("\n--- Demo 4: Request Timeouts ---\n");

    const timeout = system.spawn(TimeoutActor);

    // Start a request that will timeout
    const req1 = await timeout.call({
      type: "startRequest",
      timeoutMs: 200,
    });

    // Start a request that we'll complete in time
    const req2 = await timeout.call({
      type: "startRequest",
      timeoutMs: 500,
    });

    // Complete req2 before timeout
    await sleep(100);
    timeout.cast({ type: "complete", requestId: req2 });

    // Wait for req1 to timeout
    await sleep(200);

    const pending = await timeout.call({ type: "getPending" });
    console.log(`\nPending requests: ${pending}`);
    console.log(
      "(req1 timed out and was removed, req2 completed successfully)\n",
    );

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
