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
export interface Registry {
  /**
   * Registers an actor name to its location.
   * This will overwrite any existing registration for the same name.
   * @param name The name of the actor.
   * @param nodeId The ID of the node where the actor resides.
   * @param actorId The actor's unique instance ID.
   */
  register(name: string, nodeId: string, actorId: string): Promise<void>;

  /**
   * Unregisters an actor name.
   * @param name The name of the actor to unregister.
   */
  unregister(name: string): Promise<void>;

  /**
   * Looks up the location for a given actor name.
   * @param name The name of the actor.
   * @returns The actor location, or null if the actor is not registered.
   */
  lookup(name: string): Promise<ActorLocation | null>;

  /**
   * Retrieves all actor names registered to a specific node.
   * @param nodeId The ID of the node.
   * @returns An array of actor names.
   */
  getNodeActors(nodeId: string): Promise<string[]>;

  /**
   * Connects to the registry backend.
   */
  connect(): Promise<void>;

  /**
   * Disconnects from the registry backend.
   */
  disconnect(): Promise<void>;
}
