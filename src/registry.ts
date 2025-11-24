// src/registry.ts

/**
 * A distributed registry for mapping actor names to node IDs.
 */
export interface Registry {
  /**
   * Registers an actor name to a node ID.
   * This will overwrite any existing registration for the same name.
   * @param name The name of the actor.
   * @param nodeId The ID of the node where the actor resides.
   */
  register(name: string, nodeId: string): Promise<void>;

  /**
   * Unregisters an actor name.
   * @param name The name of the actor to unregister.
   */
  unregister(name: string): Promise<void>;

  /**
   * Looks up the node ID for a given actor name.
   * @param name The name of the actor.
   * @returns The node ID, or null if the actor is not registered.
   */
  lookup(name: string): Promise<string | null>;

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
