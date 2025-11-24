// src/actor_system.ts

import { Actor, ActorId, ActorRef } from './actor';
import { v4 as uuidv4 } from 'uuid';
import { Supervisor, SupervisionOptions } from './supervisor';
import { Transport } from './transport';
import { Registry } from './registry';
import { Cluster } from './cluster';
import { PlacementEngine, PlacementStrategy } from './placement';

type Mailbox = any[];

export interface SpawnOptions {
  name?: string;
  args?: any[];
  strategy?: PlacementStrategy;
}

/**
 * Manages the lifecycle of all actors on a single node.
 */
export class ActorSystem {
  readonly id: string;
  private readonly actors = new Map<string, Actor>();
  private readonly mailboxes = new Map<string, Mailbox>();
  private readonly supervisor: Supervisor;
  private readonly transport: Transport;
  private readonly registry: Registry;
  private readonly placementEngine: PlacementEngine;

  constructor(
    cluster: Cluster,
    transport: Transport,
    registry: Registry,
    supervisorOptions?: SupervisionOptions
  ) {
    this.id = cluster.nodeId;
    this.transport = transport;
    this.registry = registry;
    this.placementEngine = new PlacementEngine(cluster);
    this.supervisor = new Supervisor(this, supervisorOptions || { strategy: 'Restart', maxRestarts: 3, periodMs: 5000 });
  }

  async start(): Promise<void> {
    const rpcCallChannel = `rpc-call:${this.id}`;
    const rpcCastChannel = `rpc-cast:${this.id}`;
    await this.transport.respond(rpcCallChannel, this._handleRpcCall.bind(this));
    await this.transport.subscribe(rpcCastChannel, this._handleRpcCast.bind(this));
  }

  spawn<T extends Actor>(actorClass: new () => T, options: SpawnOptions = {}): ActorRef {
    const { name, args, strategy = 'local' } = options;
    const targetNodeId = this.placementEngine.selectNode(strategy);

    const instanceId = uuidv4();
    const actorId = new ActorId(targetNodeId, instanceId, name);
    const actorRef = new ActorRef(actorId, this);

    if (targetNodeId === this.id) {
      // Local spawn
      const actor = new actorClass();
      actor.self = actorRef;
      actor.context = { children: new Set() };

      this.actors.set(instanceId, actor);
      this.mailboxes.set(instanceId, []);

      if (name) {
        this.registry.register(name, this.id);
      }

      Promise.resolve(actor.init(...(args || []))).catch(err => {
        this.supervisor.handleCrash(actorRef, err);
      });

      this.processMailbox(instanceId);
    } else {
      // Remote spawn is a fire-and-forget operation
      this.transport.publish(`rpc-cast:${targetNodeId}`, {
        type: 'spawn',
        actorClassName: actorClass.name,
        actorId,
        options,
      });
    }

    return actorRef;
  }

  getRef(actorId: ActorId): ActorRef {
    return new ActorRef(actorId, this);
  }

  /**
   * (For testing) Gets the instance IDs of all local actors.
   */
  getLocalActorIds(): string[] {
    return Array.from(this.actors.keys());
  }

  async stop(actorRef: ActorRef): Promise<void> {
    const { id, name } = actorRef.id;
    const actor = this.actors.get(id);
    if (actor) {
      if (name) {
        await this.registry.unregister(name);
      }
      await Promise.resolve(actor.terminate());
      this.actors.delete(id);
      this.mailboxes.delete(id);
    }
  }

  async dispatchCall(actorId: ActorId, message: any, timeout: number): Promise<any> {
    const { id, name, systemId } = actorId;

    const nodeId = name ? await this.registry.lookup(name) : systemId;
    if (!nodeId) throw new Error(`Could not find node for actor: ${actorId}`);

    if (nodeId === this.id && this.actors.has(id)) {
      // Local actor
      const actor = this.actors.get(id)!;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
        Promise.resolve(actor.handleCall(message))
          .then(res => {
            clearTimeout(timer);
            resolve(res);
          })
          .catch(err => {
            clearTimeout(timer);
            reject(err);
          });
      });
    } else {
      // Remote actor
      return this.transport.request(`rpc-call:${nodeId}`, { actorId, message }, timeout);
    }
  }

  async dispatchCast(actorId: ActorId, message: any): Promise<void> {
    const { id, name, systemId } = actorId;
    
    const nodeId = name ? await this.registry.lookup(name) : systemId;
    if (!nodeId) throw new Error(`Could not find node for actor: ${actorId}`);

    if (nodeId === this.id && this.actors.has(id)) {
      // Local actor
      const mailbox = this.mailboxes.get(id);
      if (mailbox) {
        mailbox.push({ type: 'cast', message });
      }
    } else {
      // Remote actor
      await this.transport.publish(`rpc-cast:${nodeId}`, { type: 'cast', actorId, message });
    }
  }

  private async _handleRpcCall(rpcMessage: any): Promise<any> {
    const { actorId, message } = rpcMessage;
    const actor = this.actors.get(actorId.id);

    if (!actor) {
      throw new Error(`RPC Error: Actor ${actorId.id} not found on this node.`);
    }
    return actor.handleCall(message);
  }

  private _handleRpcCast(rpcMessage: any): void {
    const { type, actorId, message } = rpcMessage;

    if (type === 'spawn') {
      // This is a huge simplification. We would need a way to map actorClassName to a class.
      const actorClasses: { [key: string]: new () => Actor } = (global as any).actorClasses || {};
      const actorClass = actorClasses[rpcMessage.actorClassName];
      if (!actorClass) {
        throw new Error(`RPC Error: Actor class ${rpcMessage.actorClassName} not found on this node.`);
      }
      this.spawn(actorClass, rpcMessage.options);
      return;
    }

    if (type === 'cast') {
      const actor = this.actors.get(actorId.id);
      if (!actor) {
        // Actor may not have been created yet, or was stopped.
        // This is fire-and-forget, so we drop it.
        return;
      }
      actor.handleCast(message);
    }
  }

  private async processMailbox(id: string): Promise<void> {
    const mailbox = this.mailboxes.get(id);
    const actor = this.actors.get(id);

    if (!mailbox || !actor) return;

    if (mailbox.length > 0) {
      const { message } = mailbox.shift();
      try {
        await Promise.resolve(actor.handleCast(message));
      } catch (err) {
        this.supervisor.handleCrash(actor.self, err);
      }
    }

    setTimeout(() => this.processMailbox(id), 0);
  }
}
