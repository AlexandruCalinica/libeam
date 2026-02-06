import { Registry, ActorLocation, NameReservation } from "./registry";
import { RegistrySync } from "./registry_sync";
import { v4 as uuidv4 } from "uuid";

const DEFAULT_RESERVATION_TTL_MS = 30000;

export class DistributedRegistry implements Registry {
  private readonly reservations = new Map<string, NameReservation>();

  constructor(
    private readonly nodeId: string,
    private readonly gossip: RegistrySync,
  ) {}

  async register(name: string, nodeId: string, actorId: string): Promise<void> {
    return this.gossip.register(name, nodeId, actorId);
  }

  async unregister(name: string): Promise<void> {
    return this.gossip.unregister(name);
  }

  async lookup(name: string): Promise<ActorLocation | null> {
    return this.gossip.lookup(name);
  }

  async getNodeActors(nodeId: string): Promise<string[]> {
    return this.gossip.getNodeActors(nodeId);
  }

  async connect(): Promise<void> {
    return this.gossip.connect();
  }

  async disconnect(): Promise<void> {
    this.reservations.clear();
    return this.gossip.disconnect();
  }

  async reserveName(
    name: string,
    nodeId: string,
    ttlMs: number = DEFAULT_RESERVATION_TTL_MS,
  ): Promise<{ reservationId: string } | null> {
    this.cleanupExpiredReservations();

    const existing = await this.gossip.lookup(name);
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

    await this.gossip.register(reservation.name, reservation.nodeId, actorId);

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
