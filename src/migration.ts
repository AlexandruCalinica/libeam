import { StashedMessage } from "./actor";
import { LibeamError } from "./errors";

export class ActorNotMigratableError extends LibeamError {
  constructor(actorId: string) {
    super(
      "ACTOR_NOT_MIGRATABLE",
      `Actor ${actorId} does not implement Migratable interface`,
      { actorId },
    );
  }
}

export class ActorHasChildrenError extends LibeamError {
  constructor(actorId: string, childCount: number) {
    super(
      "ACTOR_HAS_CHILDREN",
      `Actor ${actorId} has ${childCount} children and cannot be migrated`,
      { actorId, childCount },
    );
  }
}

export class MigrationFailedError extends LibeamError {
  constructor(actorName: string, reason: string) {
    super("MIGRATION_FAILED", `Migration of ${actorName} failed: ${reason}`, {
      actorName,
      reason,
    });
  }
}

export class NameReservationError extends LibeamError {
  constructor(actorName: string, reason: string) {
    super(
      "NAME_RESERVATION_FAILED",
      `Failed to reserve name ${actorName}: ${reason}`,
      { actorName, reason },
    );
  }
}

export interface MigratePrepareRequest {
  type: "migrate:prepare";
  actorName: string;
  actorClassName: string;
  sourceNodeId: string;
}

export interface MigratePrepareResponse {
  ready: boolean;
  error?: string;
  reservationId?: string;
}

export interface MigrateExecuteRequest {
  type: "migrate:execute";
  reservationId: string;
  actorName: string;
  actorClassName: string;
  sourceNodeId: string;
  state: unknown;
  initArgs: unknown[];
  pendingMessages: StashedMessage[];
}

export interface MigrateExecuteResponse {
  success: boolean;
  newActorId?: string;
  error?: string;
}

export interface MigrateRollbackRequest {
  type: "migrate:rollback";
  reservationId: string;
  actorName: string;
}

export interface MigrateRollbackResponse {
  success: boolean;
}

export interface MigrationResult {
  success: boolean;
  newActorId?: string;
  newNodeId?: string;
  error?: string;
}
