// src/types/functional.ts

import {
  ActorRef,
  isInitContinue,
  type Actor,
  type ActorId,
  type ChildSupervisionOptions,
  type InitContinue,
  type LinkRef,
  type TimerRef,
  type WatchRef,
} from "../actor";
import type { ActorSystem } from "../actor_system";
import type { SpawnOptions } from "../actor_system";
import type { Authenticator } from "../auth";
import type { GossipOptions } from "../gossip_protocol";
import type { SupervisionOptions } from "../supervisor";

export type { InitContinue };
export { isInitContinue };

type CallHandlers = Record<string, (...args: any[]) => any>;
type CastHandlers = Record<string, (...args: any[]) => void>;

type ExtendHandlers<
  THandlers,
  K extends string,
  THandler extends (...args: any[]) => any,
> = THandlers & { [P in K]: THandler };

export type SupervisionConfig = SupervisionOptions;
export type GossipConfig = GossipOptions;

// Module augmentation interface - users extend this in their own .d.ts files
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ActorRegistry {}

// Utility types for extracting handler types from ActorDefinition
export type ExtractCalls<T> = T extends ActorDefinition<any, infer TCalls, any> ? TCalls : {};
export type ExtractCasts<T> = T extends ActorDefinition<any, any, infer TCasts> ? TCasts : {};
export type ActorRefFrom<T> = T extends ActorDefinition<any, infer TCalls, infer TCasts>
  ? TypedActorRef<TCalls, TCasts>
  : ActorRef;

export interface LocalConfig {
  type?: "local";
  nodeId?: string;
  supervision?: SupervisionConfig;
}

export interface DistributedConfig {
  type: "distributed";
  nodeId?: string;
  port?: number;
  ports?: { rpc: number; pub: number; gossip: number };
  bindAddress?: string;
  seedNodes: string[];
  gossip?: GossipConfig;
  supervision?: SupervisionConfig;
  /** Shared secret (≥16 chars). Derives HMAC key for gossip + CurveZMQ keypair for transport. */
  cookie?: string;
  /** HKDF salt for key derivation. Default: "libeam-v2". All nodes in a cluster must use the same salt. */
  salt?: string;
  /** Custom gossip authenticator. Transport auth always uses cookie-derived CurveZMQ keys. */
  auth?: Authenticator;
}

export interface ActorContext {
  self: ActorRef;
  parent?: ActorRef;
  spawn<
    TArgs extends any[],
    TCalls extends CallHandlers,
    TCasts extends CastHandlers,
  >(
    definition: ActorDefinition<TArgs, TCalls, TCasts>,
    options?: SpawnOptions,
  ): TypedActorRef<TCalls, TCasts>;
  watch(ref: ActorRef): WatchRef;
  unwatch(ref: WatchRef): void;
  link(ref: ActorRef): LinkRef;
  unlink(ref: LinkRef): void;
  exit(reason?: string): void;
  setTrapExit(trap: boolean): void;
  getActorByName<K extends keyof ActorRegistry & string>(
    name: K,
  ): Promise<ActorRefFrom<ActorRegistry[K]> | null>;
  getActorByName(name: string): Promise<ActorRef | null>;
  stash(): void;
  unstash(): void;
  unstashAll(): void;
  clearStash(): void;
}

export interface ActorBuilder<
  TCalls extends CallHandlers = {},
  TCasts extends CastHandlers = {},
> {
  onCall<K extends string, THandler extends (...args: any[]) => any>(
    name: K,
    handler: THandler,
  ): this & ActorBuilder<ExtendHandlers<TCalls, K, THandler>, TCasts>;
  onCast<K extends string, THandler extends (...args: any[]) => void>(
    name: K,
    handler: THandler,
  ): this & ActorBuilder<TCalls, ExtendHandlers<TCasts, K, THandler>>;
  onInfo<T extends string>(type: T, handler: (msg: any) => void): this;
  onTerminate(handler: () => void): this;
  onContinue<T>(handler: (data: T) => void | Promise<void>): this;
  sendAfter(message: any, delayMs: number): TimerRef;
  sendInterval(message: any, intervalMs: number): TimerRef;
  setIdleTimeout(timeoutMs: number): this;
  migratable(config: { getState: () => any; setState: (state: any) => void }): this;
  childSupervision(options: ChildSupervisionOptions): this;
}

export type ActorDefinition<
  TArgs extends any[] = any[],
  TCalls extends CallHandlers = {},
  TCasts extends CastHandlers = {},
> = (new () => Actor) & {
  __type: "functional-actor";
  factory: (
    ctx: ActorContext,
    self: ActorBuilder<{}, {}>,
    ...args: TArgs
  ) => void | InitContinue | ActorBuilder<TCalls, TCasts>;
};

const ActorRefBase = ActorRef as new (id: ActorId, system: ActorSystem) => ActorRef;

export class TypedActorRef<
  TCalls extends CallHandlers = {},
  TCasts extends CastHandlers = {},
> extends ActorRefBase {
  call<K extends keyof TCalls & string>(
    method: K,
    ...args: Parameters<TCalls[K]>
  ): Promise<ReturnType<TCalls[K]>>;
  call(
    method: keyof TCalls extends never ? string : never,
    ...args: any[]
  ): Promise<any>;
  call(message: any, timeout?: number): Promise<any>;
  call(methodOrMessage: any, ...rest: any[]): Promise<any> {
    if (typeof methodOrMessage === "string") {
      return super.call({ method: methodOrMessage, args: rest });
    }
    return super.call(methodOrMessage, ...rest);
  }

  cast<K extends keyof TCasts & string>(
    method: K,
    ...args: Parameters<TCasts[K]>
  ): void;
  cast(
    method: keyof TCasts extends never ? string : never,
    ...args: any[]
  ): void;
  cast(message: any): void;
  cast(methodOrMessage: any, ...rest: any[]): void {
    if (typeof methodOrMessage === "string") {
      return super.cast({ method: methodOrMessage, args: rest });
    }
    return super.cast(methodOrMessage);
  }
}
