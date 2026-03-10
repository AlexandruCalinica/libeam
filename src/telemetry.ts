// src/telemetry.ts
//
// Lightweight telemetry/instrumentation for libeam.
// Inspired by Elixir's :telemetry — synchronous event emission with
// zero overhead when no handlers are attached.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Event name — array of strings, like Elixir's [:app, :component, :event] */
export type EventName = readonly string[];

/** Measurements — numeric values only (durations, counts, sizes) */
export type Measurements = Record<string, number>;

/** Metadata — contextual information (ids, classes, reasons) */
export type Metadata = Record<string, unknown>;

/** Handler function signature — called synchronously */
export type TelemetryHandler = (
  eventName: EventName,
  measurements: Measurements,
  metadata: Metadata,
) => void;

/** Handler attachment config (stored internally) */
interface HandlerEntry {
  id: string;
  handler: TelemetryHandler;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

class Telemetry {
  /** event key → set of handler entries */
  private handlers = new Map<string, Set<HandlerEntry>>();
  /** handler id → list of event keys it is attached to */
  private handlerKeys = new Map<string, string[]>();

  // ---- public API ----

  /**
   * Attach a handler to one or more event names.
   * Throws if a handler with the same id is already attached.
   */
  attach(
    id: string,
    eventNames: EventName[],
    handler: TelemetryHandler,
  ): string {
    if (this.handlerKeys.has(id)) {
      throw new Error(
        `Telemetry handler "${id}" is already attached. Detach first.`,
      );
    }

    const entry: HandlerEntry = { id, handler };
    const keys: string[] = [];

    for (const name of eventNames) {
      const key = name.join(".");
      keys.push(key);
      let set = this.handlers.get(key);
      if (!set) {
        set = new Set();
        this.handlers.set(key, set);
      }
      set.add(entry);
    }

    this.handlerKeys.set(id, keys);
    return id;
  }

  /**
   * Detach a previously attached handler by id.
   * Returns true if the handler was found and removed.
   */
  detach(id: string): boolean {
    const keys = this.handlerKeys.get(id);
    if (!keys) return false;

    for (const key of keys) {
      const set = this.handlers.get(key);
      if (set) {
        for (const entry of set) {
          if (entry.id === id) {
            set.delete(entry);
            break;
          }
        }
        if (set.size === 0) this.handlers.delete(key);
      }
    }

    this.handlerKeys.delete(id);
    return true;
  }

  /**
   * Emit a telemetry event. Handlers are called synchronously.
   * If no handlers are attached for this event, this is a no-op (zero allocation).
   * Handler errors are silently caught — they never crash the actor system.
   */
  execute(
    eventName: EventName,
    measurements: Measurements,
    metadata: Metadata,
  ): void {
    const key = eventName.join(".");
    const set = this.handlers.get(key);
    if (!set || set.size === 0) return;

    for (const entry of set) {
      try {
        entry.handler(eventName, measurements, metadata);
      } catch {
        // Handler errors are silently ignored (Elixir :telemetry behaviour)
      }
    }
  }

  /**
   * Wrap a function in start/stop/exception telemetry events.
   *
   * - Emits `[...eventName, "start"]` before execution
   * - Emits `[...eventName, "stop"]` after success with `duration_ms`
   * - Emits `[...eventName, "exception"]` on error with `duration_ms` + error
   *
   * Supports both sync and async functions transparently.
   */
  span<T>(eventName: EventName, metadata: Metadata, fn: () => T): T {
    const startName = [...eventName, "start"] as EventName;
    const stopName = [...eventName, "stop"] as EventName;
    const exceptionName = [...eventName, "exception"] as EventName;

    this.execute(startName, { system_time: Date.now() }, metadata);
    const start = performance.now();

    try {
      const result = fn();

      // Handle async (thenable) return values
      if (result && typeof (result as any).then === "function") {
        return (result as any).then(
          (v: any) => {
            this.execute(
              stopName,
              { duration_ms: performance.now() - start },
              metadata,
            );
            return v;
          },
          (err: any) => {
            this.execute(
              exceptionName,
              { duration_ms: performance.now() - start },
              { ...metadata, error: err },
            );
            throw err;
          },
        ) as T;
      }

      this.execute(
        stopName,
        { duration_ms: performance.now() - start },
        metadata,
      );
      return result;
    } catch (err) {
      this.execute(
        exceptionName,
        { duration_ms: performance.now() - start },
        { ...metadata, error: err },
      );
      throw err;
    }
  }

  /**
   * Check if any handlers are attached for the given event name.
   * Used to gate instrumentation on hot paths (zero-cost when unattached).
   */
  hasHandlers(eventName: EventName): boolean {
    const key = eventName.join(".");
    const set = this.handlers.get(key);
    return set !== undefined && set.size > 0;
  }

  /** List all attached handler ids. */
  listHandlers(): string[] {
    return Array.from(this.handlerKeys.keys());
  }

  /** Remove all handlers. Useful for test teardown. */
  reset(): void {
    this.handlers.clear();
    this.handlerKeys.clear();
  }
}

/** Global telemetry singleton. */
export const telemetry: Telemetry = new Telemetry();

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

export const TelemetryEvents = {
  actor: {
    spawn: ["libeam", "actor", "spawn"] as const,
    stop: ["libeam", "actor", "stop"] as const,
    init: ["libeam", "actor", "init"] as const,
    handleCall: ["libeam", "actor", "handle_call"] as const,
    handleCast: ["libeam", "actor", "handle_cast"] as const,
  },
  supervisor: {
    crash: ["libeam", "supervisor", "crash"] as const,
    restart: ["libeam", "supervisor", "restart"] as const,
    maxRestarts: ["libeam", "supervisor", "max_restarts"] as const,
  },
  mailbox: {
    overflow: ["libeam", "mailbox", "overflow"] as const,
  },
  genStage: {
    subscribe: ["libeam", "gen_stage", "subscribe"] as const,
    cancel: ["libeam", "gen_stage", "cancel"] as const,
    dispatch: ["libeam", "gen_stage", "dispatch"] as const,
    bufferOverflow: ["libeam", "gen_stage", "buffer_overflow"] as const,
  },
  cluster: {
    join: ["libeam", "cluster", "join"] as const,
    leave: ["libeam", "cluster", "leave"] as const,
  },
  system: {
    shutdown: ["libeam", "system", "shutdown"] as const,
  },
} as const;
