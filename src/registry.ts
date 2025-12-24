// src/registry.ts

/**
 * Information about a registered actor's location.
 */
export interface ActorLocation {
  /** The node ID where the actor resides */
  nodeId: string;
  /** The actor's unique instance ID */
  actorId: string;
}

/**
 * A distributed registry for mapping actor names to their locations.
 */
export interface NameReservation {
  reservationId: string;
  name: string;
  nodeId: string;
  expiresAt: number;
}

export interface Registry {
  register(name: string, nodeId: string, actorId: string): Promise<void>;

  unregister(name: string): Promise<void>;

  lookup(name: string): Promise<ActorLocation | null>;

  getNodeActors(nodeId: string): Promise<string[]>;

  connect(): Promise<void>;

  disconnect(): Promise<void>;

  reserveName?(
    name: string,
    nodeId: string,
    ttlMs?: number,
  ): Promise<{ reservationId: string } | null>;

  confirmReservation?(reservationId: string, actorId: string): Promise<boolean>;

  releaseReservation?(reservationId: string): Promise<void>;
}
