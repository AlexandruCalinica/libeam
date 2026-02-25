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

import { Actor, ActorRef } from "./actor";
import { ActorSystem, SpawnOptions } from "./actor_system";
import { createLogger, Logger } from "./logger";

// ============ Configuration ============

/**
 * Options for a Producer stage.
 */
export interface ProducerOptions {
  /** Max buffered events when no demand. Default: 10000 */
  bufferSize?: number;
  /** Keep "first" or "last" events when buffer overflows. Default: "last" */
  bufferKeep?: "first" | "last";
}

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

// ============ Internal Protocol ============

type StageCall =
  | { __stage: "subscribe"; tag: string; consumerRef: ActorRef; maxDemand: number; minDemand: number };

type StageCast =
  | { __stage: "ask"; tag: string; demand: number }
  | { __stage: "events"; tag: string; producerRef: ActorRef; events: any[] }
  | { __stage: "cancel"; tag: string; reason: string };

// ============ DemandDispatcher ============

/**
 * Default dispatcher: sends events to the consumer with the highest pending demand.
 * @internal
 */
class DemandDispatcher {
  private subscribers = new Map<string, ProducerSub>();

  addSubscriber(tag: string, sub: ProducerSub): void {
    this.subscribers.set(tag, sub);
  }

  removeSubscriber(tag: string): void {
    this.subscribers.delete(tag);
  }

  getSubscriber(tag: string): ProducerSub | undefined {
    return this.subscribers.get(tag);
  }

  addDemand(tag: string, demand: number): void {
    const sub = this.subscribers.get(tag);
    if (sub) sub.demand += demand;
  }

  totalDemand(): number {
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
  dispatch(events: any[]): { dispatched: Array<{ consumerRef: ActorRef; tag: string; events: any[] }>; remaining: any[] } {
    const dispatched: Array<{ consumerRef: ActorRef; tag: string; events: any[] }> = [];
    let remaining = [...events];

    // Sort subscribers by demand DESC — highest demand served first
    const sorted = [...this.subscribers.entries()]
      .filter(([, sub]) => sub.demand > 0)
      .sort(([, a], [, b]) => b.demand - a.demand);

    for (const [tag, sub] of sorted) {
      if (remaining.length === 0) break;
      const count = Math.min(sub.demand, remaining.length);
      const batch = remaining.splice(0, count);
      sub.demand -= count;
      dispatched.push({ consumerRef: sub.consumerRef, tag, events: batch });
    }

    return { dispatched, remaining };
  }

  hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  getAllTags(): string[] {
    return [...this.subscribers.keys()];
  }
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
  private dispatcher = new DemandDispatcher();
  private buffer: any[] = [];
  private bufferSize = 10000;
  private bufferKeep: "first" | "last" = "last";
  private log!: Logger;

  init(callbacks: ProducerCallbacks<any>, options?: ProducerOptions, ...args: any[]) {
    this.callbacks = callbacks;
    if (options?.bufferSize !== undefined) this.bufferSize = options.bufferSize;
    if (options?.bufferKeep !== undefined) this.bufferKeep = options.bufferKeep;
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
    this.dispatcher.addSubscriber(msg.tag, {
      consumerRef: msg.consumerRef,
      demand: 0,
      maxDemand: msg.maxDemand,
      minDemand: msg.minDemand,
    });
    this.log.debug("Consumer subscribed", { tag: msg.tag });
    return true;
  }

  private handleAsk(tag: string, demand: number): void {
    if (demand <= 0) return;
    this.dispatcher.addDemand(tag, demand);

    // First, try to drain buffered events
    if (this.buffer.length > 0) {
      const { dispatched, remaining } = this.dispatcher.dispatch(this.buffer);
      this.buffer = remaining;
      this.sendDispatched(dispatched);
    }

    // If there's still demand, ask user for more events
    const totalDemand = this.dispatcher.totalDemand();
    if (totalDemand > 0) {
      const [events, newState] = this.callbacks.handleDemand(totalDemand, this.userState);
      this.userState = newState;
      if (events.length > 0) {
        this.dispatchOrBuffer(events);
      }
    }
  }

  private handleCancel(tag: string, reason: string): void {
    this.dispatcher.removeSubscriber(tag);
    this.log.debug("Consumer cancelled", { tag, reason });
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
      // Trim from front if over limit
      if (this.buffer.length > this.bufferSize) {
        const overflow = this.buffer.length - this.bufferSize;
        this.buffer.splice(0, overflow);
        this.log.warn("Producer buffer overflow, dropped oldest events", { dropped: overflow });
      }
    } else {
      // "first" — keep existing, drop new if over limit
      const space = this.bufferSize - this.buffer.length;
      if (space > 0) {
        this.buffer.push(...events.slice(0, space));
      }
      if (events.length > space) {
        this.log.warn("Producer buffer overflow, dropped newest events", { dropped: events.length - Math.max(space, 0) });
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
    sub.producerRef.cast({
      __stage: "ask",
      tag,
      demand,
    } satisfies StageCast);
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
  private dispatcher = new DemandDispatcher();
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
    if (producerOptions?.bufferSize !== undefined) this.bufferSize = producerOptions.bufferSize;
    if (producerOptions?.bufferKeep !== undefined) this.bufferKeep = producerOptions.bufferKeep;
    this.log = createLogger("GenStage.ProducerConsumer", this.context.system.id);
    this.userState = this.callbacks.init ? this.callbacks.init(...args) : undefined;
  }

  handleCall(message: any): any {
    if (message?.__stage === "subscribe") {
      // Downstream consumer subscribing
      const msg = message as StageCall & { __stage: "subscribe" };
      this.dispatcher.addSubscriber(msg.tag, {
        consumerRef: msg.consumerRef,
        demand: 0,
        maxDemand: msg.maxDemand,
        minDemand: msg.minDemand,
      });
      this.log.debug("Downstream consumer subscribed", { tag: msg.tag });
      return true;
    }
    return undefined;
  }

  handleCast(message: any): void {
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
      sub.producerRef.cast({
        __stage: "ask",
        tag,
        demand: askAmount,
      } satisfies StageCast);
    }
  }

  // --- Producer-side (downstream) ---

  private handleDownstreamAsk(tag: string, demand: number): void {
    if (demand <= 0) return;
    this.dispatcher.addDemand(tag, demand);

    // Drain buffer first
    if (this.buffer.length > 0) {
      const { dispatched, remaining } = this.dispatcher.dispatch(this.buffer);
      this.buffer = remaining;
      this.sendDispatched(dispatched);
    }
  }

  private handleCancel(tag: string, reason: string): void {
    // Could be upstream or downstream cancel
    if (this.dispatcher.getSubscriber(tag)) {
      this.dispatcher.removeSubscriber(tag);
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
    } satisfies StageCall);

    // Send initial demand
    this.actor.sendInitialDemand(tag);

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
    } satisfies StageCall);

    this.actor.sendInitialDemand(tag);

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
