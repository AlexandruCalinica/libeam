// src/agent.ts
//
// Agent: A simple abstraction for state management.
// Wraps an actor with get/update/getAndUpdate operations.

import { Actor, ActorRef } from "./actor";
import { ActorSystem, SpawnOptions } from "./actor_system";

/**
 * Message types for Agent internal communication
 */
type AgentMessage<T> =
  | { type: "get" }
  | { type: "update"; fn: (state: T) => T }
  | { type: "getAndUpdate"; fn: (state: T) => T };

/**
 * Internal actor that backs an Agent.
 * @internal
 */
class AgentActor<T> extends Actor<AgentMessage<T>, AgentMessage<T>, T> {
  private state!: T;

  init(initialState: T) {
    this.state = initialState;
  }

  handleCall(message: AgentMessage<T>): T {
    if (message.type === "get") {
      return this.state;
    } else if (message.type === "update") {
      this.state = message.fn(this.state);
      return this.state;
    } else if (message.type === "getAndUpdate") {
      const oldState = this.state;
      this.state = message.fn(this.state);
      return oldState;
    }
    return this.state;
  }

  handleCast(message: AgentMessage<T>): void {
    if (message.type === "update") {
      this.state = message.fn(this.state);
    }
  }
}

/**
 * Agent is a simple abstraction for managing state.
 *
 * It provides a synchronous-feeling API for state operations while
 * being backed by an actor for concurrency safety.
 *
 * @template T The type of state managed by the agent
 *
 * @example
 * ```typescript
 * // Create an agent with initial state
 * const counter = await Agent.start(system, 0);
 *
 * // Get current state
 * const value = await counter.get();
 * console.log(value); // 0
 *
 * // Update state
 * await counter.update(n => n + 1);
 * console.log(await counter.get()); // 1
 *
 * // Get and update atomically
 * const oldValue = await counter.getAndUpdate(n => n * 2);
 * console.log(oldValue); // 1
 * console.log(await counter.get()); // 2
 *
 * // Fire-and-forget update
 * counter.cast(n => n + 10);
 *
 * // Stop the agent
 * await counter.stop();
 * ```
 */
export class Agent<T> {
  private constructor(
    private readonly actorRef: ActorRef<AgentMessage<T>, AgentMessage<T>, T>,
    private readonly system: ActorSystem,
  ) {}

  /**
   * Starts a new Agent with the given initial state.
   *
   * @param system The actor system to spawn the agent in
   * @param initialState The initial state of the agent
   * @param options Optional spawn options (e.g., name)
   * @returns A new Agent instance
   *
   * @example
   * ```typescript
   * const counter = await Agent.start(system, 0);
   * const cache = await Agent.start(system, new Map<string, any>());
   * const config = await Agent.start(system, { debug: false, maxRetries: 3 });
   * ```
   */
  static start<T>(
    system: ActorSystem,
    initialState: T,
    options: SpawnOptions = {},
  ): Agent<T> {
    const ref = system.spawn(AgentActor<T>, {
      ...options,
      args: [initialState],
    }) as ActorRef<AgentMessage<T>, AgentMessage<T>, T>;
    return new Agent<T>(ref, system);
  }

  /**
   * Gets the current state of the agent.
   *
   * @param timeout Timeout in milliseconds (default: 5000)
   * @returns The current state
   *
   * @example
   * ```typescript
   * const value = await counter.get();
   * ```
   */
  get(timeout = 5000): Promise<T> {
    return this.actorRef.call({ type: "get" }, timeout);
  }

  /**
   * Updates the state using the given function.
   * Waits for the update to complete.
   *
   * @param fn Function that takes current state and returns new state
   * @param timeout Timeout in milliseconds (default: 5000)
   * @returns The new state after update
   *
   * @example
   * ```typescript
   * await counter.update(n => n + 1);
   * await cache.update(map => map.set("key", "value"));
   * ```
   */
  update(fn: (state: T) => T, timeout = 5000): Promise<T> {
    return this.actorRef.call({ type: "update", fn }, timeout);
  }

  /**
   * Gets the current state and updates it atomically.
   * Returns the state BEFORE the update.
   *
   * @param fn Function that takes current state and returns new state
   * @param timeout Timeout in milliseconds (default: 5000)
   * @returns The state before the update
   *
   * @example
   * ```typescript
   * // Pop from a list
   * const first = await listAgent.getAndUpdate(list => list.slice(1));
   *
   * // Swap value
   * const old = await counter.getAndUpdate(() => newValue);
   * ```
   */
  getAndUpdate(fn: (state: T) => T, timeout = 5000): Promise<T> {
    return this.actorRef.call({ type: "getAndUpdate", fn }, timeout);
  }

  /**
   * Updates the state without waiting for completion (fire-and-forget).
   * Use this when you don't need to know when the update completes.
   *
   * @param fn Function that takes current state and returns new state
   *
   * @example
   * ```typescript
   * // Fire-and-forget increment
   * counter.cast(n => n + 1);
   * ```
   */
  cast(fn: (state: T) => T): void {
    this.actorRef.cast({ type: "update", fn });
  }

  /**
   * Stops the agent.
   *
   * @example
   * ```typescript
   * await counter.stop();
   * ```
   */
  stop(): Promise<void> {
    return this.system.stop(this.actorRef);
  }

  /**
   * Gets the underlying ActorRef.
   * Useful for watching/linking or other actor operations.
   */
  getRef(): ActorRef<AgentMessage<T>, AgentMessage<T>, T> {
    return this.actorRef;
  }
}
