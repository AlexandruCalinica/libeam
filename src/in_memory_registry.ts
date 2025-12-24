import { Registry, ActorLocation, NameReservation } from "./registry";
import { v4 as uuidv4 } from "uuid";

const DEFAULT_RESERVATION_TTL_MS = 30000;

export class InMemoryRegistry implements Registry {
  private readonly registry = new Map<string, ActorLocation>();
  private readonly reservations = new Map<string, NameReservation>();

  async connect(): Promise<void> {
    return Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.registry.clear();
    this.reservations.clear();
    return Promise.resolve();
  }

  async register(name: string, nodeId: string, actorId: string): Promise<void> {
    this.registry.set(name, { nodeId, actorId });
  }

  async unregister(name: string): Promise<void> {
    this.registry.delete(name);
  }

  async lookup(name: string): Promise<ActorLocation | null> {
    return this.registry.get(name) || null;
  }

  async getNodeActors(nodeId: string): Promise<string[]> {
    const actors: string[] = [];
    for (const [name, location] of this.registry.entries()) {
      if (location.nodeId === nodeId) {
        actors.push(name);
      }
    }
    return actors;
  }

  async reserveName(
    name: string,
    nodeId: string,
    ttlMs: number = DEFAULT_RESERVATION_TTL_MS,
  ): Promise<{ reservationId: string } | null> {
    this.cleanupExpiredReservations();

    const existing = this.registry.get(name);
    if (existing && existing.nodeId !== nodeId) {
      return null;
    }

    for (const reservation of this.reservations.values()) {
      if (reservation.name === name && reservation.nodeId !== nodeId) {
        return null;
      }
    }

    const reservationId = uuidv4();
    this.reservations.set(reservationId, {
      reservationId,
      name,
      nodeId,
      expiresAt: Date.now() + ttlMs,
    });

    return { reservationId };
  }

  async confirmReservation(
    reservationId: string,
    actorId: string,
  ): Promise<boolean> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      return false;
    }

    if (Date.now() > reservation.expiresAt) {
      this.reservations.delete(reservationId);
      return false;
    }

    this.registry.set(reservation.name, {
      nodeId: reservation.nodeId,
      actorId,
    });

    this.reservations.delete(reservationId);
    return true;
  }

  async releaseReservation(reservationId: string): Promise<void> {
    this.reservations.delete(reservationId);
  }

  private cleanupExpiredReservations(): void {
    const now = Date.now();
    for (const [id, reservation] of this.reservations.entries()) {
      if (now > reservation.expiresAt) {
        this.reservations.delete(id);
      }
    }
  }
}
