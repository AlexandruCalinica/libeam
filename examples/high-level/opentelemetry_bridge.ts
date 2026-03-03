// examples/high-level/opentelemetry_bridge.ts
//
// Demonstrates: Bridging libeam telemetry to OpenTelemetry
// Run: npx tsx examples/high-level/opentelemetry_bridge.ts
//
// This example shows how to map libeam's built-in telemetry events to
// OpenTelemetry spans and metrics. It uses a lightweight in-process
// simulation of the OTel API so no external dependencies are needed.
//
// In production, replace the simulated OTel classes with:
//   import { trace, metrics } from "@opentelemetry/api";

import { createSystem, createActor, telemetry, TelemetryEvents } from "../../src";
import type { EventName, Measurements, Metadata } from "../../src";

// ---------------------------------------------------------------------------
// Simulated OpenTelemetry API (replace with @opentelemetry/api in production)
// ---------------------------------------------------------------------------

interface Span {
  name: string;
  attributes: Record<string, unknown>;
  startTime: number;
  endTime?: number;
  status: "ok" | "error";
  end(): void;
}

interface Counter {
  name: string;
  add(value: number, attributes?: Record<string, unknown>): void;
}

interface Histogram {
  name: string;
  record(value: number, attributes?: Record<string, unknown>): void;
}

// In-memory collectors for demonstration
const collectedSpans: Span[] = [];
const collectedMetrics: { name: string; value: number; attributes: Record<string, unknown> }[] = [];

const tracer = {
  startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
    const span: Span = {
      name,
      attributes,
      startTime: Date.now(),
      status: "ok",
      end() {
        this.endTime = Date.now();
        collectedSpans.push(this);
      },
    };
    return span;
  },
};

function createCounter(name: string): Counter {
  return {
    name,
    add(value: number, attributes: Record<string, unknown> = {}) {
      collectedMetrics.push({ name, value, attributes });
    },
  };
}

function createHistogram(name: string): Histogram {
  return {
    name,
    record(value: number, attributes: Record<string, unknown> = {}) {
      collectedMetrics.push({ name, value, attributes });
    },
  };
}

// ---------------------------------------------------------------------------
// OpenTelemetry Bridge
// ---------------------------------------------------------------------------

/**
 * Bridges libeam telemetry events to OpenTelemetry traces and metrics.
 *
 * Spans are created for actor lifecycle operations (init, stop, handleCall,
 * handleCast). Counters track discrete events (spawn, crash, restart).
 * Histograms record durations for latency analysis.
 *
 * Usage with real OpenTelemetry:
 *
 *   import { trace, metrics } from "@opentelemetry/api";
 *   const tracer = trace.getTracer("libeam");
 *   const meter = metrics.getMeter("libeam");
 *   const bridge = new OpenTelemetryBridge(tracer, meter);
 *   bridge.install();
 */
class OpenTelemetryBridge {
  private handlerIds: string[] = [];
  private activeSpans = new Map<string, Span>();

  // Metrics
  private actorSpawnCounter = createCounter("libeam.actor.spawns");
  private actorStopCounter = createCounter("libeam.actor.stops");
  private supervisorCrashCounter = createCounter("libeam.supervisor.crashes");
  private supervisorRestartCounter = createCounter("libeam.supervisor.restarts");
  private mailboxOverflowCounter = createCounter("libeam.mailbox.overflows");
  private callDuration = createHistogram("libeam.actor.call.duration_ms");
  private castDuration = createHistogram("libeam.actor.cast.duration_ms");

  /**
   * Install all telemetry handlers. Call once at startup.
   */
  install(): void {
    this.installLifecycleMetrics();
    this.installCallTracing();
    this.installCastTracing();
    this.installSupervisionMetrics();
    this.installMailboxMetrics();
  }

  /**
   * Remove all telemetry handlers. Call on shutdown.
   */
  uninstall(): void {
    for (const id of this.handlerIds) {
      telemetry.detach(id);
    }
    this.handlerIds = [];
    this.activeSpans.clear();
  }

  // --- Lifecycle: spawn + stop counters ---

  private installLifecycleMetrics(): void {
    this.handlerIds.push(
      telemetry.attach(
        "otel-lifecycle",
        [
          TelemetryEvents.actor.spawn,
          [...TelemetryEvents.actor.stop, "stop"],
        ],
        (event: EventName, measurements: Measurements, metadata: Metadata) => {
          const name = event.join(".");
          if (name === "libeam.actor.spawn") {
            this.actorSpawnCounter.add(1, {
              actor_class: metadata.actor_class as string,
              node_id: metadata.node_id as string,
            });
          } else if (name === "libeam.actor.stop.stop") {
            this.actorStopCounter.add(1, {
              actor_id: metadata.actor_id as string,
            });
          }
        },
      ),
    );
  }

  // --- handleCall: span per call with duration histogram ---

  private installCallTracing(): void {
    this.handlerIds.push(
      telemetry.attach(
        "otel-call",
        [
          [...TelemetryEvents.actor.handleCall, "start"],
          [...TelemetryEvents.actor.handleCall, "stop"],
          [...TelemetryEvents.actor.handleCall, "exception"],
        ],
        (event: EventName, measurements: Measurements, metadata: Metadata) => {
          const phase = event[event.length - 1];
          const actorId = metadata.actor_id as string;
          const spanKey = `call:${actorId}`;

          if (phase === "start") {
            const span = tracer.startSpan("libeam.actor.handleCall", {
              actor_id: actorId,
            });
            this.activeSpans.set(spanKey, span);
          } else if (phase === "stop") {
            const span = this.activeSpans.get(spanKey);
            if (span) {
              this.activeSpans.delete(spanKey);
              span.end();
              this.callDuration.record(measurements.duration_ms, {
                actor_id: actorId,
              });
            }
          } else if (phase === "exception") {
            const span = this.activeSpans.get(spanKey);
            if (span) {
              this.activeSpans.delete(spanKey);
              span.status = "error";
              span.attributes.error = metadata.error;
              span.end();
              this.callDuration.record(measurements.duration_ms, {
                actor_id: actorId,
                error: true,
              });
            }
          }
        },
      ),
    );
  }

  // --- handleCast: span per cast with duration histogram ---

  private installCastTracing(): void {
    this.handlerIds.push(
      telemetry.attach(
        "otel-cast",
        [
          [...TelemetryEvents.actor.handleCast, "start"],
          [...TelemetryEvents.actor.handleCast, "stop"],
          [...TelemetryEvents.actor.handleCast, "exception"],
        ],
        (event: EventName, measurements: Measurements, metadata: Metadata) => {
          const phase = event[event.length - 1];
          const actorId = metadata.actor_id as string;
          const spanKey = `cast:${actorId}`;

          if (phase === "start") {
            const span = tracer.startSpan("libeam.actor.handleCast", {
              actor_id: actorId,
            });
            this.activeSpans.set(spanKey, span);
          } else if (phase === "stop") {
            const span = this.activeSpans.get(spanKey);
            if (span) {
              this.activeSpans.delete(spanKey);
              span.end();
              this.castDuration.record(measurements.duration_ms, {
                actor_id: actorId,
              });
            }
          } else if (phase === "exception") {
            const span = this.activeSpans.get(spanKey);
            if (span) {
              this.activeSpans.delete(spanKey);
              span.status = "error";
              span.attributes.error = metadata.error;
              span.end();
              this.castDuration.record(measurements.duration_ms, {
                actor_id: actorId,
                error: true,
              });
            }
          }
        },
      ),
    );
  }

  // --- Supervision: crash + restart counters ---

  private installSupervisionMetrics(): void {
    this.handlerIds.push(
      telemetry.attach(
        "otel-supervision",
        [
          TelemetryEvents.supervisor.crash,
          TelemetryEvents.supervisor.restart,
        ],
        (event: EventName, _measurements: Measurements, metadata: Metadata) => {
          const name = event.join(".");
          if (name === "libeam.supervisor.crash") {
            this.supervisorCrashCounter.add(1, {
              actor_id: metadata.actor_id as string,
              strategy: metadata.strategy as string,
            });
          } else if (name === "libeam.supervisor.restart") {
            this.supervisorRestartCounter.add(1, {
              actor_id: metadata.actor_id as string,
              attempt: metadata.attempt as number,
            });
          }
        },
      ),
    );
  }

  // --- Mailbox overflow counter ---

  private installMailboxMetrics(): void {
    this.handlerIds.push(
      telemetry.attach(
        "otel-mailbox",
        [TelemetryEvents.mailbox.overflow],
        (_event: EventName, _measurements: Measurements, metadata: Metadata) => {
          this.mailboxOverflowCounter.add(1, {
            actor_id: metadata.actor_id as string,
            message_type: metadata.message_type as string,
          });
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Demo actors
// ---------------------------------------------------------------------------

const Counter = createActor((ctx, self, initial: number) => {
  let count = initial;

  return self
    .onCall("get", () => count)
    .onCall("increment", () => ++count)
    .onCast("add", (n: number) => {
      count += n;
    });
});

const CrashyActor = createActor((_ctx, self) => {
  return self
    .onCall("ok", () => "fine")
    .onCast("crash", () => {
      throw new Error("intentional crash");
    });
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== OpenTelemetry Bridge ===\n");

  // 1. Install the bridge
  const bridge = new OpenTelemetryBridge();
  bridge.install();
  console.log("Bridge installed — libeam events → OpenTelemetry\n");

  const system = createSystem();

  try {
    // 2. Spawn actors (triggers libeam.actor.spawn → counter metric)
    const counter = system.spawn(Counter, { args: [0] });
    const crashy = system.spawn(CrashyActor);
    console.log("Spawned 2 actors");

    // 3. Call/cast operations (triggers handleCall/handleCast → spans + histograms)
    await counter.call("get");
    await counter.call("increment");
    await counter.call("increment");
    counter.cast("add", 10);
    await new Promise((r) => setTimeout(r, 50));
    console.log(`Counter value: ${await counter.call("get")}`);

    await crashy.call("ok");

    // 4. Trigger a crash (triggers supervisor.crash → counter metric)
    crashy.cast("crash");
    await new Promise((r) => setTimeout(r, 200));
    console.log("Crash handled by supervisor");

    // 5. Stop an actor (triggers libeam.actor.stop → counter metric)
    await system.stop(counter);
  } finally {
    await system.shutdown();
    bridge.uninstall();
  }

  // 6. Print collected telemetry
  console.log("\n--- Collected Spans ---\n");
  for (const span of collectedSpans) {
    const duration = span.endTime! - span.startTime;
    const status = span.status === "error" ? " [ERROR]" : "";
    console.log(`  ${span.name}${status}  ${duration}ms  actor=${span.attributes.actor_id}`);
  }

  console.log("\n--- Collected Metrics ---\n");
  const grouped = new Map<string, { total: number; entries: typeof collectedMetrics }>();
  for (const m of collectedMetrics) {
    const existing = grouped.get(m.name) ?? { total: 0, entries: [] };
    existing.total += m.value;
    existing.entries.push(m);
    grouped.set(m.name, existing);
  }
  for (const [name, data] of grouped) {
    if (name.endsWith("duration_ms")) {
      const values = data.entries.map((e) => e.value);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      console.log(`  ${name}: ${values.length} samples, avg=${avg.toFixed(2)}ms`);
    } else {
      console.log(`  ${name}: ${data.total}`);
    }
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
