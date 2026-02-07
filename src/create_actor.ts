import {
  Actor,
  ActorRef,
  ChildSupervisionOptions,
  DEFAULT_CHILD_SUPERVISION,
  InitContinue,
  isInitContinue,
  LinkRef,
  TimerRef,
  WatchRef,
} from "./actor";
import type { SpawnOptions } from "./actor_system";
import type {
  ActorBuilder,
  ActorContext,
  ActorDefinition,
  TypedActorRef,
} from "./types/functional";

type CallHandler = (...args: any[]) => any;
type CastHandler = (...args: any[]) => void;
type CallHandlers = Record<string, CallHandler>;
type CastHandlers = Record<string, CastHandler>;

interface HandlerRegistry {
  calls: Map<string, CallHandler>;
  casts: Map<string, CastHandler>;
  infos: Map<string, (message: any) => void>;
  terminate: Array<() => void | Promise<void>>;
  continueHandler?: (data: any) => void | Promise<void>;
  migratable?: { getState: () => any; setState: (state: any) => void };
  childSupervisionConfig?: ChildSupervisionOptions;
}

class ActorBuilderImpl implements ActorBuilder {
  private readonly handlers: HandlerRegistry;

  constructor(private readonly actor: Actor) {
    this.handlers = {
      calls: new Map(),
      casts: new Map(),
      infos: new Map(),
      terminate: [],
    };
  }

  getHandlers(): HandlerRegistry {
    return this.handlers;
  }

  call<K extends string, THandler extends (...args: any[]) => any>(
    name: K,
    handler: THandler,
  ): this {
    this.handlers.calls.set(name, handler);
    return this;
  }

  cast<K extends string, THandler extends (...args: any[]) => void>(
    name: K,
    handler: THandler,
  ): this {
    this.handlers.casts.set(name, handler);
    return this;
  }

  info<T extends string>(type: T, handler: (msg: any) => void): this {
    this.handlers.infos.set(type, handler);
    return this;
  }

  onTerminate(handler: () => void | Promise<void>): this {
    this.handlers.terminate.push(handler);
    return this;
  }

  onContinue<T>(handler: (data: T) => void | Promise<void>): this {
    this.handlers.continueHandler = handler;
    return this;
  }

  sendAfter(message: any, delayMs: number): TimerRef {
    return this.actor.context.system.startActorTimer(
      this.actor.self,
      message,
      delayMs,
      false,
    );
  }

  sendInterval(message: any, intervalMs: number): TimerRef {
    return this.actor.context.system.startActorTimer(
      this.actor.self,
      message,
      intervalMs,
      true,
    );
  }

  setIdleTimeout(timeoutMs: number): this {
    this.actor.context.system.setActorIdleTimeout(this.actor.self, timeoutMs);
    return this;
  }

  migratable(config: { getState: () => any; setState: (state: any) => void }): this {
    this.handlers.migratable = config;
    return this;
  }

  childSupervision(options: ChildSupervisionOptions): this {
    this.handlers.childSupervisionConfig = options;
    return this;
  }
}

type CallMessage = { method: string; args: any[] };
type CastMessage = { method: string; args: any[] };

type FunctionalContextActor = Actor & {
  publicStash(): void;
  publicUnstash(): void;
  publicUnstashAll(): void;
  publicClearStash(): void;
};

function createActorContext(actor: FunctionalContextActor): ActorContext {
  return {
    self: actor.self,
    parent: actor.context.parent,
    spawn<TArgs extends any[], TCalls extends CallHandlers, TCasts extends CastHandlers>(
      definition: ActorDefinition<TArgs, TCalls, TCasts>,
      options?: SpawnOptions,
    ): TypedActorRef<TCalls, TCasts> {
      return actor.context.system.spawnChild(
        actor.self,
        definition as unknown as new () => Actor,
        options,
      ) as TypedActorRef<TCalls, TCasts>;
    },
    watch(ref: ActorRef): WatchRef {
      return actor.context.system.watch(actor.self, ref);
    },
    unwatch(ref: WatchRef): void {
      actor.context.system.unwatch(ref);
    },
    link(ref: ActorRef): LinkRef {
      return actor.context.system.link(actor.self, ref);
    },
    unlink(ref: LinkRef): void {
      actor.context.system.unlink(ref);
    },
    exit(reason?: string): void {
      if (!reason || reason === "normal") {
        void actor.context.system.stop(actor.self);
        return;
      }

      if (reason === "kill") {
        void actor.context.system.stop(actor.self);
        return;
      }

      actor.context.system.sendExit(actor.self, actor.self, reason);
    },
    setTrapExit(trap: boolean): void {
      actor.context.trapExit = trap;
    },
    stash(): void {
      actor.publicStash();
    },
    unstash(): void {
      actor.publicUnstash();
    },
    unstashAll(): void {
      actor.publicUnstashAll();
    },
    clearStash(): void {
      actor.publicClearStash();
    },
  };
}

export function createActor<
  TArgs extends any[],
  TCalls extends CallHandlers = CallHandlers,
  TCasts extends CastHandlers = CastHandlers,
>(
  factory: (
    ctx: ActorContext,
    self: ActorBuilder<{}, {}>,
    ...args: TArgs
  ) => void | InitContinue | ActorBuilder<TCalls, TCasts>,
): ActorDefinition<TArgs, TCalls, TCasts> {
  class FunctionalActor extends Actor<CastMessage, CallMessage, any> {
    private handlers!: HandlerRegistry;

    init(...args: any[]): void | InitContinue {
      const builder = new ActorBuilderImpl(this);
      this.handlers = builder.getHandlers();
      const ctx = createActorContext(this);
      const typedArgs = args as unknown as TArgs;
      const result = factory(ctx, builder, ...typedArgs);
      if (this.handlers.migratable) {
        const { getState, setState } = this.handlers.migratable;
        (this as any).getState = getState;
        (this as any).setState = setState;
      }
      if (isInitContinue(result)) {
        return result;
      }
    }

    handleContinue(data: any): void | Promise<void> {
      return this.handlers.continueHandler?.(data);
    }

    childSupervision(): ChildSupervisionOptions {
      return this.handlers.childSupervisionConfig ?? DEFAULT_CHILD_SUPERVISION;
    }

    public publicStash(): void {
      this.stash();
    }

    public publicUnstash(): void {
      this.unstash();
    }

    public publicUnstashAll(): void {
      this.unstashAll();
    }

    public publicClearStash(): void {
      this.clearStash();
    }

    handleCall(message: CallMessage): any {
      const handler = this.handlers.calls.get(message.method);
      if (!handler) {
        throw new Error(`Unknown call method: ${message.method}`);
      }
      return handler(...message.args);
    }

    handleCast(message: CastMessage): void {
      const handler = this.handlers.casts.get(message.method);
      if (handler) {
        handler(...message.args);
      }
    }

    handleInfo(message: any): void | Promise<void> {
      const type = message?.type;
      if (typeof type !== "string") {
        return;
      }

      const handler = this.handlers.infos.get(type);
      if (handler) {
        return handler(message);
      }
    }

    async terminate(): Promise<void> {
      for (const handler of this.handlers.terminate) {
        await handler();
      }
    }
  }

  (FunctionalActor as any).__type = "functional-actor";
  (FunctionalActor as any).factory = factory;

  return FunctionalActor as unknown as ActorDefinition<TArgs, TCalls, TCasts>;
}
