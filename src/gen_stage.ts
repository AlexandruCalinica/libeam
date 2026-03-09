// src/gen_stage.ts
//
// GenStage: Demand-driven producer-consumer pipelines with back-pressure.
// Adapted from Elixir's GenStage protocol.
//
// Stages exchange events via a demand protocol: consumers tell producers
// how many events they can handle, producers never emit more than requested.
//
// Three stage types:
//   Producer         — emits events in response to demand
//   Consumer         — receives and processes events
//   ProducerConsumer — receives events, transforms, re-emits downstream
//
// Follows the Agent/DynamicSupervisor pattern: internal actor + typed wrapper.

import {
  Actor,
  ActorRef,
  ChildSupervisionOptions,
  DownMessage,
  InfoMessage,
  WatchRef,
} from "./actor.js";
import { ActorSystem, SpawnOptions } from "./actor_system.js";
import { ChildCounts, ChildInfo } from "./dynamic_supervisor.js";
import { createLogger, Logger } from "./logger.js";
import { telemetry, TelemetryEvents } from "./telemetry.js";

// ============ Configuration ============

/**
 * Options for a Producer stage.
 */
export interface ProducerOptions {
  /** Max buffered events when no demand. Default: 10000 */
  bufferSize?: number;
  /** Keep "first" or "last" events when buffer overflows. Default: "last" */
  bufferKeep?: "first" | "last";
  /** Dispatcher strategy. Default: { type: "demand" } */
  dispatcher?: DispatcherConfig;
  /**
   * Demand mode. Default: "forward"
   * - "forward": demand from consumers is processed immediately (default)
   * - "accumulate": demand is accumulated but not forwarded to handleDemand.
   *   Call `producer.demand("forward")` to resume after all consumers have subscribed.
   *   Inspired by Elixir's `{:producer, state, demand: :accumulate}`.
   */
  demand?: "accumulate" | "forward";
}

/** Hash function for PartitionDispatcher. Return partition index or null to discard. */
export type PartitionHashFunction = (event: any) => number | null;

/** Dispatcher configuration for producers. */
export type DispatcherConfig =
  | { type: "demand" }
  | { type: "broadcast" }
  | { type: "partition"; partitions: number; hash?: PartitionHashFunction };

/**
 * Options for subscribing a consumer to a producer.
 */
export interface SubscriptionOptions {
  /** Max events in flight per subscription. Default: 1000 */
  maxDemand?: number;
  /** Threshold to request more events. Default: floor(maxDemand * 0.75) */
  minDemand?: number;
  /** Cancel behavior. Default: "temporary"
   *  - "permanent": consumer crashes if producer cancels
   *  - "transient": consumer ignores normal cancels, crashes on others
   *  - "temporary": consumer always ignores cancels (default)
   */
  cancel?: "permanent" | "transient" | "temporary";
  /** Partition to subscribe to (required for PartitionDispatcher). */
  partition?: number | string;
}

export interface ChildSpec {
  actorClass: any;
  args?: any[];
  spawnOptions?: Omit<SpawnOptions, "strategy" | "role" | "args">;
}

export interface ConsumerSupervisorOptions {
  maxRestarts?: number;
  periodMs?: number;
}

// ============ Subscription Info ============

/** Producer-side tracking of a subscribed consumer. */
interface ProducerSub {
  consumerRef: ActorRef;
  demand: number;
  maxDemand: number;
  minDemand: number;
}

/** Consumer-side tracking of a subscription to a producer. */
interface ConsumerSub {
  producerRef: ActorRef;
  pendingDemand: number;
  maxDemand: number;
  minDemand: number;
  cancel: "permanent" | "transient" | "temporary";
}

/** Subscription reference returned from subscribe(). */
export interface SubscriptionRef {
  tag: string;
  producerRef: ActorRef;
}

// ============ User Callbacks ============

/**
 * Callbacks for a Producer stage.
 * @template TState The producer's internal state type
 */
export interface ProducerCallbacks<TState> {
  /** Initialize state. Receives spawn args. */
  init: (...args: any[]) => TState;
  /** Called when demand arrives. Return [events, newState]. */
  handleDemand: (demand: number, state: TState) => [events: any[], newState: TState];
}

/**
 * Callbacks for a Consumer stage.
 * @template TState The consumer's internal state type
 */
export interface ConsumerCallbacks<TState> {
  /** Initialize state (optional). */
  init?: (...args: any[]) => TState;
  /** Called when events arrive from a producer. Return new state. */
  handleEvents: (
    events: any[],
    from: { tag: string; producerRef: ActorRef },
    state: TState,
  ) => TState;
}

/**
 * Callbacks for a ProducerConsumer stage.
 * @template TState The stage's internal state type
 */
export interface ProducerConsumerCallbacks<TState> {
  /** Initialize state (optional). */
  init?: (...args: any[]) => TState;
  /** Called when events arrive. Return [outputEvents, newState]. */
  handleEvents: (
    events: any[],
    from: { tag: string; producerRef: ActorRef },
    state: TState,
  ) => [events: any[], newState: TState];
}

export interface ConsumerSupervisorCallbacks<TState> {
  init?: (...args: any[]) => TState;
}

// ============ Internal Protocol ============

type StageCall =
  | {
    __stage: "subscribe";
    tag: string;
    consumerRef: ActorRef;
    maxDemand: number;
    minDemand: number;
    partition?: number | string;
  };

type StageCast =
  | { __stage: "ask"; tag: string; demand: number }
  | { __stage: "events"; tag: string; producerRef: ActorRef; events: any[] }
  | { __stage: "cancel"; tag: string; reason: string };

type ConsumerSupCall =
  | { __consumerSup: "which_children" }
  | { __consumerSup: "count_children" };

// ============ Dispatcher Interface ============

/** Result of dispatching events to subscribers. */
interface DispatchResult {
  dispatched: Array<{ consumerRef: ActorRef; tag: string; events: any[] }>;
  remaining: any[];
}

/** Options passed to dispatcher on subscriber registration. */
interface DispatcherSubscribeOpts {
  partition?: number | string;
}

/** Interface all dispatchers implement. @internal */
interface Dispatcher {
  subscribe(tag: string, sub: ProducerSub, opts?: DispatcherSubscribeOpts): void;
  cancel(tag: string): void;
  ask(tag: string, demand: number): number;
  dispatch(events: any[]): DispatchResult;
  hasSubscribers(): boolean;
  has(tag: string): boolean;
}

// ============ DemandDispatcher ============

/**
 * Default dispatcher: sends events to the consumer with the highest pending demand.
 * @internal
 */
class DemandDispatcher implements Dispatcher {
  private subscribers = new Map<string, ProducerSub>();

  subscribe(tag: string, sub: ProducerSub): void {
    this.subscribers.set(tag, sub);
  }

  cancel(tag: string): void {
    this.subscribers.delete(tag);
  }

  ask(tag: string, demand: number): number {
    const sub = this.subscribers.get(tag);
    if (sub) sub.demand += demand;
    return this.totalDemand();
  }

  private totalDemand(): number {
    let total = 0;
    for (const sub of this.subscribers.values()) {
      total += sub.demand;
    }
    return total;
  }

  /**
   * Dispatch events to subscribers based on demand.
   * Returns events that could not be dispatched (no demand).
   */
  dispatch(events: any[]): DispatchResult {
    const dispatched: DispatchResult["dispatched"] = [];
    let idx = 0;
    const len = events.length;

    // Fast path: single subscriber (very common — P→C topology)
    if (this.subscribers.size === 1) {
      const [tag, sub] = this.subscribers.entries().next().value as [string, ProducerSub];
      if (sub.demand > 0) {
        const count = Math.min(sub.demand, len);
        // Use subarray view instead of splice to avoid copying
        const batch = count === len ? events : events.slice(0, count);
        sub.demand -= count;
        dispatched.push({ consumerRef: sub.consumerRef, tag, events: batch });
        idx = count;
      }
      return { dispatched, remaining: idx >= len ? [] : events.slice(idx) };
    }

    // Multi-subscriber: find highest-demand subscriber in a loop (avoid sort + entries copy)
    // Repeat until events exhausted or no more demand.
    while (idx < len) {
      let bestTag: string | null = null;
      let bestSub: ProducerSub | null = null;
      let bestDemand = 0;
      for (const [tag, sub] of this.subscribers) {
        if (sub.demand > bestDemand) {
          bestTag = tag;
          bestSub = sub;
          bestDemand = sub.demand;
        }
      }
      if (!bestSub || bestDemand <= 0) break;
      const count = Math.min(bestDemand, len - idx);
      const batch = events.slice(idx, idx + count);
      bestSub.demand -= count;
      dispatched.push({ consumerRef: bestSub.consumerRef, tag: bestTag!, events: batch });
      idx += count;
    }

    return { dispatched, remaining: idx >= len ? [] : events.slice(idx) };
  }

  hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  has(tag: string): boolean {
    return this.subscribers.has(tag);
  }
}

class BroadcastDispatcher implements Dispatcher {
  private subscribers = new Map<string, ProducerSub>();
  private waiting = 0;
  private requested = 0;

  subscribe(tag: string, sub: ProducerSub): void {
    // Compensate: restore pending waiting demand to existing subscribers before
    // resetting. Mirrors Elixir's adjust_demand(-waiting, demands) — without this,
    // existing subscribers lose 'waiting' units of demand when a new subscriber joins.
    if (this.waiting > 0) {
      for (const existingSub of this.subscribers.values()) {
        existingSub.demand += this.waiting;
      }
    }
    this.subscribers.set(tag, sub);
    this.waiting = 0;
  }

  cancel(tag: string): void {
    this.subscribers.delete(tag);
    if (this.subscribers.size === 0) {
      this.waiting = 0;
      this.requested = 0;
      return;
    }
    this.syncDemands();
  }

  ask(tag: string, demand: number): number {
    const sub = this.subscribers.get(tag);
    if (!sub) return 0;
    sub.demand += demand;
    return this.syncDemands();
  }

  dispatch(events: any[]): DispatchResult {
    if (this.waiting === 0 || this.subscribers.size === 0) {
      return { dispatched: [], remaining: events };
    }

    const count = Math.min(events.length, this.waiting);
    // Avoid slicing when all events are dispatched (common fast path)
    const deliverNow = count === events.length ? events : events.slice(0, count);
    const deliverLater = count === events.length ? [] : events.slice(count);
    this.waiting -= count;
    this.requested -= count;

    const dispatched: DispatchResult["dispatched"] = [];
    for (const [tag, sub] of this.subscribers) {
      dispatched.push({ consumerRef: sub.consumerRef, tag, events: deliverNow });
    }

    return { dispatched, remaining: deliverLater };
  }

  hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  has(tag: string): boolean {
    return this.subscribers.has(tag);
  }

  private syncDemands(): number {
    if (this.subscribers.size === 0) return 0;
    let min = Infinity;
    for (const sub of this.subscribers.values()) {
      min = Math.min(min, sub.demand);
    }
    if (min <= 0) return 0;
    for (const sub of this.subscribers.values()) {
      sub.demand -= min;
    }
    this.waiting += min;
    const request = Math.max(0, this.waiting - this.requested);
    this.requested += request;
    return request;
  }
}

class PartitionDispatcher implements Dispatcher {
  private partitionCount: number;
  private hash: PartitionHashFunction;
  private partitions: Array<{ tag: string; sub: ProducerSub } | null>;
  private tagToPartition = new Map<string, number>();
  private partitionBuffers: any[][];

  constructor(partitions: number, hash?: PartitionHashFunction) {
    this.partitionCount = partitions;
    this.hash = hash ?? ((event: any) => {
      if (typeof event === "number") return event % partitions;
      if (typeof event === "string") return Math.abs(simpleHash(event)) % partitions;
      if (typeof event === "object" && event !== null && "key" in event) {
        const key = (event as { key: unknown }).key;
        if (typeof key === "number") return key % partitions;
        if (typeof key === "string") return Math.abs(simpleHash(key)) % partitions;
      }
      return 0;
    });
    this.partitions = new Array(partitions).fill(null);
    this.partitionBuffers = new Array(partitions);
    for (let i = 0; i < partitions; i++) {
      this.partitionBuffers[i] = [];
    }
  }

  subscribe(tag: string, sub: ProducerSub, opts?: DispatcherSubscribeOpts): void {
    const partition = opts?.partition;
    if (partition === undefined || partition === null) {
      throw new Error("PartitionDispatcher requires a 'partition' option on subscribe");
    }
    const p = typeof partition === "string" ? parseInt(partition, 10) : partition;
    if (p < 0 || p >= this.partitionCount || !Number.isInteger(p)) {
      throw new Error(`Invalid partition ${partition}. Must be 0..${this.partitionCount - 1}`);
    }
    const existing = this.partitions[p];
    if (existing !== null && existing !== undefined) {
      throw new Error(`Partition ${p} is already taken by subscriber ${existing.tag}`);
    }
    this.partitions[p] = { tag, sub };
    this.tagToPartition.set(tag, p);
  }

  cancel(tag: string): void {
    const p = this.tagToPartition.get(tag);
    if (p === undefined) return;
    this.partitions[p] = null;
    this.tagToPartition.delete(tag);
  }

  ask(tag: string, demand: number): number {
    const p = this.tagToPartition.get(tag);
    if (p === undefined) return 0;
    const entry = this.partitions[p];
    if (!entry) return 0;
    entry.sub.demand += demand;
    return demand;
  }

  dispatch(events: any[]): DispatchResult {
    // Pre-allocated per-partition event buckets (array index = partition)
    const buckets: any[][] = new Array(this.partitionCount);
    const remaining: any[] = [];

    for (const event of events) {
      const p = this.hash(event);
      if (p === null) continue;

      if (p < 0 || p >= this.partitionCount) {
        throw new Error(`Hash returned invalid partition ${p}. Must be 0..${this.partitionCount - 1} or null`);
      }

      const entry = this.partitions[p];
      if (!entry || entry.sub.demand <= 0) {
        this.partitionBuffers[p].push(event);
        continue;
      }

      entry.sub.demand--;
      if (!buckets[p]) buckets[p] = [];
      buckets[p].push(event);
    }

    // Drain partition buffers
    for (let p = 0; p < this.partitionCount; p++) {
      const buf = this.partitionBuffers[p];
      if (buf.length === 0) continue;
      const entry = this.partitions[p];
      if (!entry || entry.sub.demand <= 0) continue;
      const count = Math.min(entry.sub.demand, buf.length);
      const drained = buf.splice(0, count);
      entry.sub.demand -= count;
      if (!buckets[p]) buckets[p] = drained;
      else buckets[p].push(...drained);
    }

    // Build dispatched array from non-empty buckets
    const dispatched: DispatchResult["dispatched"] = [];
    for (let p = 0; p < this.partitionCount; p++) {
      if (!buckets[p]?.length) continue;
      const entry = this.partitions[p]!;
      dispatched.push({ consumerRef: entry.sub.consumerRef, tag: entry.tag, events: buckets[p] });
    }

    return { dispatched, remaining };
  }

  hasSubscribers(): boolean {
    for (let p = 0; p < this.partitionCount; p++) {
      if (this.partitions[p] !== null) return true;
    }
    return false;
  }

  has(tag: string): boolean {
    return this.tagToPartition.has(tag);
  }
}

/** Simple string hash (djb2). @internal */
function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

function createDispatcher(config?: DispatcherConfig): Dispatcher {
  if (!config || config.type === "demand") return new DemandDispatcher();
  if (config.type === "broadcast") return new BroadcastDispatcher();
  if (config.type === "partition") return new PartitionDispatcher(config.partitions, config.hash);
  return new DemandDispatcher();
}

// ============ ProducerStageActor ============

/**
 * Internal actor backing a Producer stage.
 * Manages subscriptions, demand, event buffering, and dispatching.
 * @internal
 */
class ProducerStageActor extends Actor {
  private userState: any;
  private callbacks!: ProducerCallbacks<any>;
  private dispatcher!: Dispatcher;
  private buffer: any[] = [];
  private bufferSize = 10000;
  private bufferKeep: "first" | "last" = "last";
  private demandMode: "accumulate" | "forward" = "forward";
  private accumulatedDemand = 0;
  private log!: Logger;

  init(callbacks: ProducerCallbacks<any>, options?: ProducerOptions, ...args: any[]) {
    this.callbacks = callbacks;
    this.dispatcher = createDispatcher(options?.dispatcher);
    if (options?.bufferSize !== undefined) this.bufferSize = options.bufferSize;
    if (options?.bufferKeep !== undefined) this.bufferKeep = options.bufferKeep;
    if (options?.demand !== undefined) this.demandMode = options.demand;
    this.log = createLogger("GenStage.Producer", this.context.system.id);
    this.userState = this.callbacks.init(...args);
  }

  handleCall(message: any): any {
    if (message?.__stage === "subscribe") {
      return this.handleSubscribe(message as StageCall & { __stage: "subscribe" });
    }
    return undefined;
  }

  handleCast(message: any): void {
    // Handle demand mode switch
    if (message?.__producer_set_demand_mode) {
      this.switchDemandMode(message.__producer_set_demand_mode as "forward");
      return;
    }
    if (!message?.__stage) return;
    const msg = message as StageCast;
    switch (msg.__stage) {
      case "ask":
        this.handleAsk(msg.tag, msg.demand);
        break;
      case "cancel":
        this.handleCancel(msg.tag, msg.reason);
        break;
    }
  }

  private handleSubscribe(msg: StageCall & { __stage: "subscribe" }): boolean {
    this.dispatcher.subscribe(msg.tag, {
      consumerRef: msg.consumerRef,
      demand: 0,
      maxDemand: msg.maxDemand,
      minDemand: msg.minDemand,
    }, { partition: msg.partition });
    telemetry.execute(TelemetryEvents.genStage.subscribe, {}, {
      producer_id: this.self.id.id,
      consumer_tag: msg.tag,
    });
    this.log.debug("Consumer subscribed", { tag: msg.tag });
    return true;
  }

  private handleAsk(tag: string, demand: number): void {
    if (demand <= 0) return;
    const upstreamDemand = this.dispatcher.ask(tag, demand);

    // Try to drain buffered events (including dispatcher-internal buffers
    // such as PartitionDispatcher's per-partition buffers).
    {
      const { dispatched, remaining } = this.dispatcher.dispatch(this.buffer);
      this.buffer = remaining;
      this.sendDispatched(dispatched);
    }

    // If dispatcher requests upstream events, ask user (or accumulate)
    if (upstreamDemand > 0) {
      if (this.demandMode === "accumulate") {
        this.accumulatedDemand += upstreamDemand;
        return;
      }
      const [events, newState] = this.callbacks.handleDemand(upstreamDemand, this.userState);
      this.userState = newState;
      if (events.length > 0) {
        this.dispatchOrBuffer(events);
      }
    }
  }

  private handleCancel(tag: string, reason: string): void {
    this.dispatcher.cancel(tag);
    telemetry.execute(TelemetryEvents.genStage.cancel, {}, {
      producer_id: this.self.id.id,
      consumer_tag: tag,
      reason,
    });
    this.log.debug("Consumer cancelled", { tag, reason });
  }

  private switchDemandMode(mode: "forward"): void {
    this.demandMode = mode;
    if (this.accumulatedDemand > 0) {
      const demand = this.accumulatedDemand;
      this.accumulatedDemand = 0;
      const [events, newState] = this.callbacks.handleDemand(demand, this.userState);
      this.userState = newState;
      if (events.length > 0) {
        this.dispatchOrBuffer(events);
      }
    }
  }
  private dispatchOrBuffer(events: any[]): void {
    if (!this.dispatcher.hasSubscribers()) {
      this.addToBuffer(events);
      return;
    }

    const { dispatched, remaining } = this.dispatcher.dispatch(events);
    if (events.length > 0) {
      telemetry.execute(TelemetryEvents.genStage.dispatch, { event_count: events.length }, {
        producer_id: this.self.id.id,
      });
    }
    this.sendDispatched(dispatched);

    if (remaining.length > 0) {
      this.addToBuffer(remaining);
    }
  }

  private addToBuffer(events: any[]): void {
    if (this.bufferKeep === "last") {
      this.buffer.push(...events);
      // Trim from front if over limit
      if (this.buffer.length > this.bufferSize) {
        const overflow = this.buffer.length - this.bufferSize;
        this.buffer.splice(0, overflow);
        telemetry.execute(TelemetryEvents.genStage.bufferOverflow, { dropped_count: overflow, buffer_size: this.bufferSize }, {
          producer_id: this.self.id.id,
        });
        this.log.warn("Producer buffer overflow, dropped oldest events", { dropped: overflow });
      }
    } else {
      // "first" — keep existing, drop new if over limit
      const space = this.bufferSize - this.buffer.length;
      if (space > 0) {
        this.buffer.push(...events.slice(0, space));
      }
      if (events.length > space) {
        const droppedCount = events.length - Math.max(space, 0);
        telemetry.execute(TelemetryEvents.genStage.bufferOverflow, { dropped_count: droppedCount, buffer_size: this.bufferSize }, {
          producer_id: this.self.id.id,
        });
        this.log.warn("Producer buffer overflow, dropped newest events", { dropped: droppedCount });
      }
    }
  }

  private sendDispatched(dispatched: Array<{ consumerRef: ActorRef; tag: string; events: any[] }>): void {
    for (const d of dispatched) {
      d.consumerRef.cast({
        __stage: "events",
        tag: d.tag,
        producerRef: this.self,
        events: d.events,
      } satisfies StageCast);
    }
  }
}

// ============ ConsumerStageActor ============

/**
 * Internal actor backing a Consumer stage.
 * Manages subscriptions to upstream producers and demand tracking.
 * @internal
 */
class ConsumerStageActor extends Actor {
  private userState: any;
  private callbacks!: ConsumerCallbacks<any>;
  private subscriptions = new Map<string, ConsumerSub>();
  private log!: Logger;

  init(callbacks: ConsumerCallbacks<any>, ...args: any[]) {
    this.callbacks = callbacks;
    this.log = createLogger("GenStage.Consumer", this.context.system.id);
    this.userState = this.callbacks.init ? this.callbacks.init(...args) : undefined;
  }

  handleCall(_message: any): any {
    return undefined;
  }

  handleCast(message: any): void {
    // Handle deferred initial demand (scheduled via sendAfter in scheduleInitialDemand)
    if (message?.__deferred_ask) {
      const tag = message.__deferred_ask as string;
      const sub = this.subscriptions.get(tag);
      if (sub) {
        this.askProducer(tag, sub, sub.maxDemand);
      }
      return;
    }
    if (!message?.__stage) return;
    const msg = message as StageCast;
    switch (msg.__stage) {
      case "events":
        this.handleEvents(msg.tag, msg.producerRef, msg.events);
        break;
      case "cancel":
        this.handleCancelFromProducer(msg.tag, msg.reason);
        break;
    }
  }

  /** Called by the Consumer wrapper to initiate a subscription. */
  subscribeToProducer(
    producerRef: ActorRef,
    options: SubscriptionOptions,
  ): { tag: string } {
    const tag = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const maxDemand = options.maxDemand ?? 1000;
    const minDemand = options.minDemand ?? Math.floor(maxDemand * 0.75);

    this.subscriptions.set(tag, {
      producerRef,
      pendingDemand: 0,
      maxDemand,
      minDemand,
      cancel: options.cancel ?? "temporary",
    });

    return { tag };
  }

  /** Called after successful subscribe call to producer — sends initial demand. */
  sendInitialDemand(tag: string): void {
    const sub = this.subscriptions.get(tag);
    if (!sub) return;
    this.askProducer(tag, sub, sub.maxDemand);
  }

  /**
   * Schedule initial demand to be sent on the next tick via sendAfter(0).
   * This ensures that when multiple consumers subscribe sequentially,
   * all subscribe calls complete before any initial demand reaches the producer.
   * Critical for BroadcastDispatcher correctness.
   */
  scheduleInitialDemand(tag: string): void {
    this.sendAfter({ __deferred_ask: tag }, 0);
  }

  cancelSubscription(tag: string, reason: string): boolean {
    const sub = this.subscriptions.get(tag);
    if (!sub) return false;

    sub.producerRef.cast({
      __stage: "cancel",
      tag,
      reason,
    } satisfies StageCast);

    this.subscriptions.delete(tag);
    return true;
  }

  cancelAll(reason: string): void {
    for (const [tag, sub] of this.subscriptions) {
      sub.producerRef.cast({
        __stage: "cancel",
        tag,
        reason,
      } satisfies StageCast);
    }
    this.subscriptions.clear();
  }

  private handleEvents(tag: string, producerRef: ActorRef, events: any[]): void {
    const sub = this.subscriptions.get(tag);
    if (!sub) {
      this.log.warn("Received events for unknown subscription", { tag });
      return;
    }

    sub.pendingDemand -= events.length;
    if (sub.pendingDemand < 0) sub.pendingDemand = 0;

    this.userState = this.callbacks.handleEvents(
      events,
      { tag, producerRef },
      this.userState,
    );

    // Re-ask if demand dropped to minDemand threshold
    if (sub.pendingDemand <= sub.minDemand) {
      const askAmount = sub.maxDemand - sub.pendingDemand;
      this.askProducer(tag, sub, askAmount);
    }
  }

  private handleCancelFromProducer(tag: string, _reason: string): void {
    this.subscriptions.delete(tag);
    this.log.debug("Producer cancelled subscription", { tag });
  }

  private askProducer(tag: string, sub: ConsumerSub, demand: number): void {
    sub.pendingDemand += demand;
    const msg = {
      __stage: "ask" as const,
      tag,
      demand,
    } satisfies StageCast;
    // Fast path: synchronous demand for local producers.
    // Collapses demand→emit→process from 2+ event-loop ticks to 1 tight loop.
    const pid = sub.producerRef.id;
    if (!pid.name && pid.systemId === this.context.system.id) {
      if (this.context.system._syncLocalCast(pid.id, msg)) return;
    }
    sub.producerRef.cast(msg);
  }
}

class ConsumerSupervisorActor extends Actor {
  private childSpec!: ChildSpec;
  private maxRestarts = 3;
  private periodMs = 5000;
  private subscriptions = new Map<string, ConsumerSub>();
  private activeWorkers = new Map<string, {
    ref: ActorRef;
    watchRef: WatchRef;
    event: any;
    subscriptionTag: string;
  }>();
  private releasedDemand = new Map<string, number>();
  private log!: Logger;

  init(childSpec: ChildSpec, options?: ConsumerSupervisorOptions, ..._args: any[]) {
    this.childSpec = childSpec;
    if (options?.maxRestarts !== undefined) this.maxRestarts = options.maxRestarts;
    if (options?.periodMs !== undefined) this.periodMs = options.periodMs;
    this.log = createLogger("GenStage.ConsumerSupervisor", this.context.system.id);
  }

  childSupervision(): ChildSupervisionOptions {
    return {
      strategy: "one-for-one",
      maxRestarts: this.maxRestarts,
      periodMs: this.periodMs,
    };
  }

  handleCall(message: any): any {
    const msg = message as ConsumerSupCall;
    if (msg?.__consumerSup === "which_children") {
      return this.getChildrenInfo();
    }
    if (msg?.__consumerSup === "count_children") {
      return this.getChildrenCounts();
    }
    return undefined;
  }

  handleCast(message: any): void {
    // Handle deferred initial demand (scheduled via sendAfter in scheduleInitialDemand)
    if (message?.__deferred_ask) {
      const tag = message.__deferred_ask as string;
      const sub = this.subscriptions.get(tag);
      if (sub) {
        this.askProducer(tag, sub, sub.maxDemand);
      }
      return;
    }
    if (!message?.__stage) return;
    const msg = message as StageCast;
    switch (msg.__stage) {
      case "events":
        this.handleEvents(msg.tag, msg.producerRef, msg.events);
        break;
      case "cancel":
        this.handleCancelFromProducer(msg.tag, msg.reason);
        break;
    }
  }

  handleInfo(message: InfoMessage): void {
    if (message.type === "down") {
      this.handleWorkerDown(message as DownMessage);
    }
  }

  subscribeToProducer(producerRef: ActorRef, options: SubscriptionOptions): { tag: string } {
    const tag = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const maxDemand = options.maxDemand ?? 1000;
    const minDemand = options.minDemand ?? Math.floor(maxDemand * 0.75);

    this.subscriptions.set(tag, {
      producerRef,
      pendingDemand: 0,
      maxDemand,
      minDemand,
      cancel: options.cancel ?? "temporary",
    });
    this.releasedDemand.set(tag, 0);

    return { tag };
  }

  sendInitialDemand(tag: string): void {
    const sub = this.subscriptions.get(tag);
    if (!sub) return;
    this.askProducer(tag, sub, sub.maxDemand);
  }

  /** Schedule initial demand deferred to next tick. See ConsumerStageActor.scheduleInitialDemand. */
  scheduleInitialDemand(tag: string): void {
    this.sendAfter({ __deferred_ask: tag }, 0);
  }

  cancelSubscription(tag: string, reason: string): boolean {
    const sub = this.subscriptions.get(tag);
    if (!sub) return false;

    sub.producerRef.cast({
      __stage: "cancel",
      tag,
      reason,
    } satisfies StageCast);

    this.subscriptions.delete(tag);
    this.releasedDemand.delete(tag);
    return true;
  }

  cancelAll(reason: string): void {
    for (const [tag, sub] of this.subscriptions) {
      sub.producerRef.cast({
        __stage: "cancel",
        tag,
        reason,
      } satisfies StageCast);
    }
    this.subscriptions.clear();
    this.releasedDemand.clear();
  }

  private handleEvents(tag: string, _producerRef: ActorRef, events: any[]): void {
    const sub = this.subscriptions.get(tag);
    if (!sub) return;

    sub.pendingDemand -= events.length;
    if (sub.pendingDemand < 0) sub.pendingDemand = 0;

    for (const event of events) {
      try {
        const childRef = this.context.system.spawnChild(
          this.self,
          this.childSpec.actorClass,
          {
            ...this.childSpec.spawnOptions,
            args: [...(this.childSpec.args || []), event],
          },
        );
        const watchRef = this.watch(childRef);
        this.activeWorkers.set(childRef.id.id, {
          ref: childRef,
          watchRef,
          event,
          subscriptionTag: tag,
        });
      } catch (error) {
        this.log.error(
          "Failed to spawn worker for event",
          error instanceof Error ? error : undefined,
          { tag },
        );
        this.releasedDemand.set(tag, (this.releasedDemand.get(tag) || 0) + 1);
      }
    }

    this.maybeAskForMore(tag, sub);
  }

  private handleWorkerDown(down: DownMessage): void {
    const workerId = down.actorRef.id.id;
    const worker = this.activeWorkers.get(workerId);
    if (!worker) return;

    this.activeWorkers.delete(workerId);

    const tag = worker.subscriptionTag;
    const sub = this.subscriptions.get(tag);
    if (sub) {
      this.releasedDemand.set(tag, (this.releasedDemand.get(tag) || 0) + 1);
      this.maybeAskForMore(tag, sub);
    }
  }

  private maybeAskForMore(tag: string, sub: ConsumerSub): void {
    const released = this.releasedDemand.get(tag) || 0;
    if (released >= sub.minDemand) {
      this.releasedDemand.set(tag, 0);
      this.askProducer(tag, sub, released);
    }
  }

  private askProducer(tag: string, sub: ConsumerSub, demand: number): void {
    sub.pendingDemand += demand;
    const msg = {
      __stage: "ask" as const,
      tag,
      demand,
    } satisfies StageCast;
    // Fast path: synchronous demand for local producers.
    const pid = sub.producerRef.id;
    if (!pid.name && pid.systemId === this.context.system.id) {
      if (this.context.system._syncLocalCast(pid.id, msg)) return;
    }
    sub.producerRef.cast(msg);
  }

  private handleCancelFromProducer(tag: string, _reason: string): void {
    this.subscriptions.delete(tag);
    this.releasedDemand.delete(tag);
    this.log.debug("Producer cancelled subscription", { tag });
  }

  private getChildrenInfo(): ChildInfo[] {
    const result: ChildInfo[] = [];
    for (const worker of this.activeWorkers.values()) {
      const metadata = this.context.system.getActorMetadata(worker.ref.id.id);
      result.push({
        ref: worker.ref,
        className: metadata?.actorClass?.name || "Unknown",
        name: worker.ref.id.name,
      });
    }
    return result;
  }

  private getChildrenCounts(): ChildCounts {
    const count = this.activeWorkers.size;
    return { specs: count, active: count };
  }
}

// ============ ProducerConsumerStageActor ============

/**
 * Internal actor backing a ProducerConsumer stage.
 * Consumer side: subscribes to upstream producers, receives events.
 * Producer side: dispatches transformed events to downstream consumers.
 * @internal
 */
class ProducerConsumerStageActor extends Actor {
  private userState: any;
  private callbacks!: ProducerConsumerCallbacks<any>;

  // Consumer side (upstream)
  private upstreamSubs = new Map<string, ConsumerSub>();

  // Producer side (downstream)
  private dispatcher!: Dispatcher;
  private buffer: any[] = [];
  private bufferSize = 10000;
  private bufferKeep: "first" | "last" = "last";

  private log!: Logger;

  init(
    callbacks: ProducerConsumerCallbacks<any>,
    producerOptions?: ProducerOptions,
    ...args: any[]
  ) {
    this.callbacks = callbacks;
    this.dispatcher = createDispatcher(producerOptions?.dispatcher);
    if (producerOptions?.bufferSize !== undefined) this.bufferSize = producerOptions.bufferSize;
    if (producerOptions?.bufferKeep !== undefined) this.bufferKeep = producerOptions.bufferKeep;
    this.log = createLogger("GenStage.ProducerConsumer", this.context.system.id);
    this.userState = this.callbacks.init ? this.callbacks.init(...args) : undefined;
  }

  handleCall(message: any): any {
    if (message?.__stage === "subscribe") {
      // Downstream consumer subscribing
      const msg = message as StageCall & { __stage: "subscribe" };
      this.dispatcher.subscribe(msg.tag, {
        consumerRef: msg.consumerRef,
        demand: 0,
        maxDemand: msg.maxDemand,
        minDemand: msg.minDemand,
      }, { partition: msg.partition });
      this.log.debug("Downstream consumer subscribed", { tag: msg.tag });
      return true;
    }
    return undefined;
  }

  handleCast(message: any): void {
    // Handle deferred initial demand (scheduled via sendAfter in scheduleInitialDemand)
    if (message?.__deferred_ask) {
      const tag = message.__deferred_ask as string;
      const sub = this.upstreamSubs.get(tag);
      if (sub) {
        sub.pendingDemand += sub.maxDemand;
        sub.producerRef.cast({
          __stage: "ask",
          tag,
          demand: sub.maxDemand,
        } satisfies StageCast);
      }
      return;
    }
    if (!message?.__stage) return;
    const msg = message as StageCast;
    switch (msg.__stage) {
      case "events":
        this.handleUpstreamEvents(msg.tag, msg.producerRef, msg.events);
        break;
      case "ask":
        this.handleDownstreamAsk(msg.tag, msg.demand);
        break;
      case "cancel":
        this.handleCancel(msg.tag, msg.reason);
        break;
    }
  }

  // --- Consumer-side (upstream) ---

  subscribeToProducer(producerRef: ActorRef, options: SubscriptionOptions): { tag: string } {
    const tag = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const maxDemand = options.maxDemand ?? 1000;
    const minDemand = options.minDemand ?? Math.floor(maxDemand * 0.75);

    this.upstreamSubs.set(tag, {
      producerRef,
      pendingDemand: 0,
      maxDemand,
      minDemand,
      cancel: options.cancel ?? "temporary",
    });

    return { tag };
  }

  sendInitialDemand(tag: string): void {
    const sub = this.upstreamSubs.get(tag);
    if (!sub) return;
    sub.pendingDemand += sub.maxDemand;
    sub.producerRef.cast({
      __stage: "ask",
      tag,
      demand: sub.maxDemand,
    } satisfies StageCast);
  }

  /** Schedule initial demand deferred to next tick. See ConsumerStageActor.scheduleInitialDemand. */
  scheduleInitialDemand(tag: string): void {
    this.sendAfter({ __deferred_ask: tag }, 0);
  }

  cancelUpstream(tag: string, reason: string): boolean {
    const sub = this.upstreamSubs.get(tag);
    if (!sub) return false;
    sub.producerRef.cast({ __stage: "cancel", tag, reason } satisfies StageCast);
    this.upstreamSubs.delete(tag);
    return true;
  }

  cancelAllUpstream(reason: string): void {
    for (const [tag, sub] of this.upstreamSubs) {
      sub.producerRef.cast({ __stage: "cancel", tag, reason } satisfies StageCast);
    }
    this.upstreamSubs.clear();
  }

  private handleUpstreamEvents(tag: string, producerRef: ActorRef, events: any[]): void {
    const sub = this.upstreamSubs.get(tag);
    if (!sub) return;

    sub.pendingDemand -= events.length;
    if (sub.pendingDemand < 0) sub.pendingDemand = 0;

    // Transform via user callback
    const [outEvents, newState] = this.callbacks.handleEvents(
      events,
      { tag, producerRef },
      this.userState,
    );
    this.userState = newState;

    // Dispatch transformed events downstream
    if (outEvents.length > 0) {
      this.dispatchOrBuffer(outEvents);
    }

    // Re-ask upstream if needed
    if (sub.pendingDemand <= sub.minDemand) {
      const askAmount = sub.maxDemand - sub.pendingDemand;
      sub.pendingDemand += askAmount;
      const msg = { __stage: "ask" as const, tag, demand: askAmount } satisfies StageCast;
      const pid = sub.producerRef.id;
      if (!pid.name && pid.systemId === this.context.system.id) {
        if (this.context.system._syncLocalCast(pid.id, msg)) return;
      }
      sub.producerRef.cast(msg);
    }
  }

  // --- Producer-side (downstream) ---

  private handleDownstreamAsk(tag: string, demand: number): void {
    if (demand <= 0) return;
    this.dispatcher.ask(tag, demand);

    // Drain buffer first
    if (this.buffer.length > 0) {
      const { dispatched, remaining } = this.dispatcher.dispatch(this.buffer);
      this.buffer = remaining;
      this.sendDispatched(dispatched);
    }
  }

  private handleCancel(tag: string, reason: string): void {
    // Could be upstream or downstream cancel
    if (this.dispatcher.has(tag)) {
      this.dispatcher.cancel(tag);
      this.log.debug("Downstream consumer cancelled", { tag, reason });
    } else if (this.upstreamSubs.has(tag)) {
      this.upstreamSubs.delete(tag);
      this.log.debug("Upstream producer cancelled", { tag, reason });
    }
  }

  private dispatchOrBuffer(events: any[]): void {
    if (!this.dispatcher.hasSubscribers()) {
      this.addToBuffer(events);
      return;
    }
    const { dispatched, remaining } = this.dispatcher.dispatch(events);
    this.sendDispatched(dispatched);
    if (remaining.length > 0) {
      this.addToBuffer(remaining);
    }
  }

  private addToBuffer(events: any[]): void {
    if (this.bufferKeep === "last") {
      this.buffer.push(...events);
      if (this.buffer.length > this.bufferSize) {
        const overflow = this.buffer.length - this.bufferSize;
        this.buffer.splice(0, overflow);
      }
    } else {
      const space = this.bufferSize - this.buffer.length;
      if (space > 0) {
        this.buffer.push(...events.slice(0, space));
      }
    }
  }

  private sendDispatched(dispatched: Array<{ consumerRef: ActorRef; tag: string; events: any[] }>): void {
    for (const d of dispatched) {
      d.consumerRef.cast({
        __stage: "events",
        tag: d.tag,
        producerRef: this.self,
        events: d.events,
      } satisfies StageCast);
    }
  }
}

// ============ Public Wrappers ============

/**
 * A Producer stage that emits events in response to consumer demand.
 *
 * @example
 * ```typescript
 * const producer = Producer.start(system, {
 *   init: () => 0,
 *   handleDemand: (demand, counter) => {
 *     const events = Array.from({length: demand}, (_, i) => counter + i);
 *     return [events, counter + demand];
 *   },
 * });
 * ```
 */
export class Producer {
  private constructor(
    private readonly actorRef: ActorRef,
    private readonly system: ActorSystem,
  ) {}

  /**
   * Start a new Producer stage.
   *
   * @param system The actor system
   * @param callbacks Producer callbacks (init, handleDemand)
   * @param options Producer options (bufferSize, bufferKeep)
   * @param spawnOptions Spawn options for the underlying actor (name, etc.)
   * @param args Arguments passed to callbacks.init()
   */
  static start<TState>(
    system: ActorSystem,
    callbacks: ProducerCallbacks<TState>,
    options?: ProducerOptions,
    spawnOptions: SpawnOptions = {},
    ...args: any[]
  ): Producer {
    const ref = system.spawn(ProducerStageActor, {
      ...spawnOptions,
      args: [callbacks, options, ...args],
    });
    return new Producer(ref, system);
  }

  /** Stop the producer and cancel all subscriptions. */
  stop(): Promise<void> {
    return this.system.stop(this.actorRef);
  }

  /**
   * Switch the producer's demand mode.
   * Call `producer.demand("forward")` after subscribing all consumers
   * to resume event production when started with `demand: "accumulate"`.
   */
  demand(mode: "forward"): void {
    this.actorRef.cast({ __producer_set_demand_mode: mode });
  }

  /** Get the producer's ActorRef (for subscribing consumers). */
  getRef(): ActorRef {
    return this.actorRef;
  }
}

/**
 * A Consumer stage that receives events from upstream producers.
 *
 * @example
 * ```typescript
 * const consumer = Consumer.start(system, {
 *   handleEvents: (events, _from, state) => {
 *     console.log("Received:", events);
 *     return state;
 *   },
 * });
 *
 * await consumer.subscribe(producer.getRef(), { maxDemand: 10 });
 * ```
 */
export class Consumer {
  private readonly actor: ConsumerStageActor;

  private constructor(
    private readonly actorRef: ActorRef,
    private readonly system: ActorSystem,
  ) {
    this.actor = system.getActor(actorRef.id.id) as ConsumerStageActor;
  }

  /**
   * Start a new Consumer stage.
   *
   * @param system The actor system
   * @param callbacks Consumer callbacks (handleEvents, optional init)
   * @param spawnOptions Spawn options for the underlying actor
   * @param args Arguments passed to callbacks.init()
   */
  static start<TState>(
    system: ActorSystem,
    callbacks: ConsumerCallbacks<TState>,
    spawnOptions: SpawnOptions = {},
    ...args: any[]
  ): Consumer {
    const ref = system.spawn(ConsumerStageActor, {
      ...spawnOptions,
      args: [callbacks, ...args],
    });
    return new Consumer(ref, system);
  }

  /**
   * Subscribe to a producer. Returns a subscription reference.
   *
   * @param producerRef The producer's ActorRef
   * @param options Subscription options (maxDemand, minDemand, cancel)
   */
  async subscribe(
    producerRef: ActorRef,
    options: SubscriptionOptions = {},
  ): Promise<SubscriptionRef> {
    const maxDemand = options.maxDemand ?? 1000;
    const minDemand = options.minDemand ?? Math.floor(maxDemand * 0.75);

    // Register subscription locally
    const { tag } = this.actor.subscribeToProducer(producerRef, options);

    // Send subscribe call to producer (sync — confirms registration)
    await producerRef.call({
      __stage: "subscribe",
      tag,
      consumerRef: this.actorRef,
      maxDemand,
      minDemand,
      partition: options.partition,
    } satisfies StageCall);

    // Send initial demand
    this.actor.scheduleInitialDemand(tag);

    return { tag, producerRef };
  }

  /**
   * Cancel a subscription.
   *
   * @param ref The subscription to cancel
   */
  cancel(ref: SubscriptionRef): boolean {
    return this.actor.cancelSubscription(ref.tag, "cancel");
  }

  /** Stop the consumer and cancel all subscriptions. */
  async stop(): Promise<void> {
    this.actor.cancelAll("shutdown");
    return this.system.stop(this.actorRef);
  }

  /** Get the consumer's ActorRef. */
  getRef(): ActorRef {
    return this.actorRef;
  }
}

export class ConsumerSupervisor {
  private readonly actor: ConsumerSupervisorActor;

  private constructor(
    private readonly actorRef: ActorRef,
    private readonly system: ActorSystem,
  ) {
    this.actor = system.getActor(actorRef.id.id) as ConsumerSupervisorActor;
  }

  static start(
    system: ActorSystem,
    childSpec: ChildSpec,
    options?: ConsumerSupervisorOptions,
    spawnOptions: SpawnOptions = {},
  ): ConsumerSupervisor {
    const ref = system.spawn(ConsumerSupervisorActor, {
      ...spawnOptions,
      args: [childSpec, options],
    });
    return new ConsumerSupervisor(ref, system);
  }

  async subscribe(
    producerRef: ActorRef,
    options: SubscriptionOptions = {},
  ): Promise<SubscriptionRef> {
    const maxDemand = options.maxDemand ?? 1000;
    const minDemand = options.minDemand ?? Math.floor(maxDemand * 0.75);

    const { tag } = this.actor.subscribeToProducer(producerRef, options);

    await producerRef.call({
      __stage: "subscribe",
      tag,
      consumerRef: this.actorRef,
      maxDemand,
      minDemand,
      partition: options.partition,
    } satisfies StageCall);

    this.actor.scheduleInitialDemand(tag);
    return { tag, producerRef };
  }

  cancel(ref: SubscriptionRef): boolean {
    return this.actor.cancelSubscription(ref.tag, "cancel");
  }

  whichChildren(): Promise<ChildInfo[]> {
    return this.actorRef.call({ __consumerSup: "which_children" } satisfies ConsumerSupCall);
  }

  countChildren(): Promise<ChildCounts> {
    return this.actorRef.call({ __consumerSup: "count_children" } satisfies ConsumerSupCall);
  }

  async stop(): Promise<void> {
    this.actor.cancelAll("shutdown");
    return this.system.stop(this.actorRef);
  }

  getRef(): ActorRef {
    return this.actorRef;
  }
}

/**
 * A ProducerConsumer stage that transforms events between upstream and downstream.
 *
 * @example
 * ```typescript
 * const multiplier = ProducerConsumer.start(system, {
 *   init: (factor: number) => factor,
 *   handleEvents: (events, _from, factor) => {
 *     return [events.map(e => e * factor), factor];
 *   },
 * });
 *
 * await multiplier.subscribe(producer.getRef(), { maxDemand: 10 });
 * // Then: consumer.subscribe(multiplier.getRef(), { maxDemand: 10 });
 * ```
 */
export class ProducerConsumer {
  private readonly actor: ProducerConsumerStageActor;

  private constructor(
    private readonly actorRef: ActorRef,
    private readonly system: ActorSystem,
  ) {
    this.actor = system.getActor(actorRef.id.id) as ProducerConsumerStageActor;
  }

  /**
   * Start a new ProducerConsumer stage.
   *
   * @param system The actor system
   * @param callbacks ProducerConsumer callbacks (handleEvents, optional init)
   * @param producerOptions Options for the producer side (bufferSize, bufferKeep)
   * @param spawnOptions Spawn options for the underlying actor
   * @param args Arguments passed to callbacks.init()
   */
  static start<TState>(
    system: ActorSystem,
    callbacks: ProducerConsumerCallbacks<TState>,
    producerOptions?: ProducerOptions,
    spawnOptions: SpawnOptions = {},
    ...args: any[]
  ): ProducerConsumer {
    const ref = system.spawn(ProducerConsumerStageActor, {
      ...spawnOptions,
      args: [callbacks, producerOptions, ...args],
    });
    return new ProducerConsumer(ref, system);
  }

  /**
   * Subscribe to an upstream producer.
   */
  async subscribe(
    producerRef: ActorRef,
    options: SubscriptionOptions = {},
  ): Promise<SubscriptionRef> {
    const maxDemand = options.maxDemand ?? 1000;
    const minDemand = options.minDemand ?? Math.floor(maxDemand * 0.75);

    const { tag } = this.actor.subscribeToProducer(producerRef, options);

    await producerRef.call({
      __stage: "subscribe",
      tag,
      consumerRef: this.actorRef,
      maxDemand,
      minDemand,
      partition: options.partition,
    } satisfies StageCall);

    this.actor.scheduleInitialDemand(tag);

    return { tag, producerRef };
  }

  /**
   * Cancel an upstream subscription.
   */
  cancelUpstream(ref: SubscriptionRef): boolean {
    return this.actor.cancelUpstream(ref.tag, "cancel");
  }

  /** Stop the stage, cancelling all upstream and downstream subscriptions. */
  async stop(): Promise<void> {
    this.actor.cancelAllUpstream("shutdown");
    return this.system.stop(this.actorRef);
  }

  /** Get the stage's ActorRef (for subscribing downstream consumers or upstream producers). */
  getRef(): ActorRef {
    return this.actorRef;
  }
}
