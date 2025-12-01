// src/errors.ts

/**
 * Base error class for all libeam errors.
 */
export class LibeamError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LibeamError";
  }
}

/**
 * Error thrown when an actor cannot be found.
 */
export class ActorNotFoundError extends LibeamError {
  constructor(actorId: string, nodeId?: string) {
    super(
      `Actor not found: ${actorId}${nodeId ? ` on node ${nodeId}` : ""}`,
      "ACTOR_NOT_FOUND",
      { actorId, nodeId },
    );
    this.name = "ActorNotFoundError";
  }
}

/**
 * Error thrown when a registry lookup fails.
 */
export class RegistryLookupError extends LibeamError {
  constructor(name: string) {
    super(
      `Could not find node for actor name: ${name}`,
      "REGISTRY_LOOKUP_FAILED",
      { name },
    );
    this.name = "RegistryLookupError";
  }
}

/**
 * Error thrown when an actor class is not registered.
 */
export class ActorClassNotRegisteredError extends LibeamError {
  constructor(className: string) {
    super(
      `Actor class "${className}" not registered. Call system.registerActorClass() first.`,
      "ACTOR_CLASS_NOT_REGISTERED",
      { className },
    );
    this.name = "ActorClassNotRegisteredError";
  }
}

/**
 * Error thrown when an operation times out.
 */
export class TimeoutError extends LibeamError {
  constructor(operation: string, timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms: ${operation}`, "TIMEOUT", {
      operation,
      timeoutMs,
    });
    this.name = "TimeoutError";
  }
}

/**
 * Error thrown when the system is shutting down.
 */
export class SystemShuttingDownError extends LibeamError {
  constructor(operation: string) {
    super(
      `Cannot ${operation}: system is shutting down`,
      "SYSTEM_SHUTTING_DOWN",
      { operation },
    );
    this.name = "SystemShuttingDownError";
  }
}

/**
 * Error thrown when a transport operation fails.
 */
export class TransportError extends LibeamError {
  readonly originalCause?: Error;

  constructor(message: string, nodeId?: string, cause?: Error) {
    super(message, "TRANSPORT_ERROR", { nodeId, cause: cause?.message });
    this.name = "TransportError";
    this.originalCause = cause;
  }
}

/**
 * Error thrown when a peer is not found.
 */
export class PeerNotFoundError extends LibeamError {
  constructor(nodeId: string) {
    super(
      `No address found for node ${nodeId}. Call updatePeers() first.`,
      "PEER_NOT_FOUND",
      { nodeId },
    );
    this.name = "PeerNotFoundError";
  }
}
