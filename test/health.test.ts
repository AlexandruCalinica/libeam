// test/health.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import {
  HealthAggregator,
  HealthCheckable,
  ComponentHealth,
  combineHealthStatus,
  ActorSystem,
  InMemoryTransport,
  LocalRegistry,
  Cluster,
  Actor,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

class TestActor extends Actor {
  handleCall(message: any) {
    return "ok";
  }
  handleCast(message: any) {}
}

describe("Health Check", () => {
  describe("combineHealthStatus", () => {
    it("should return healthy when all are healthy", () => {
      expect(combineHealthStatus(["healthy", "healthy", "healthy"])).toBe(
        "healthy",
      );
    });

    it("should return degraded when any is degraded", () => {
      expect(combineHealthStatus(["healthy", "degraded", "healthy"])).toBe(
        "degraded",
      );
    });

    it("should return unhealthy when any is unhealthy", () => {
      expect(combineHealthStatus(["healthy", "degraded", "unhealthy"])).toBe(
        "unhealthy",
      );
    });

    it("should return healthy for empty array", () => {
      expect(combineHealthStatus([])).toBe("healthy");
    });
  });

  describe("HealthAggregator", () => {
    let aggregator: HealthAggregator;

    beforeEach(() => {
      aggregator = new HealthAggregator("test-node");
    });

    it("should return healthy when no components registered", async () => {
      const report = await aggregator.getHealth();
      expect(report.status).toBe("healthy");
      expect(report.nodeId).toBe("test-node");
      expect(report.components).toHaveLength(0);
    });

    it("should aggregate health from multiple components", async () => {
      const healthyComponent: HealthCheckable = {
        getHealth: () => ({
          name: "Component1",
          status: "healthy",
          message: "All good",
        }),
      };

      const degradedComponent: HealthCheckable = {
        getHealth: () => ({
          name: "Component2",
          status: "degraded",
          message: "Slow",
        }),
      };

      aggregator.register("comp1", healthyComponent);
      aggregator.register("comp2", degradedComponent);

      const report = await aggregator.getHealth();
      expect(report.status).toBe("degraded");
      expect(report.components).toHaveLength(2);
    });

    it("should handle async health checks", async () => {
      const asyncComponent: HealthCheckable = {
        getHealth: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { name: "AsyncComponent", status: "healthy" };
        },
      };

      aggregator.register("async", asyncComponent);

      const report = await aggregator.getHealth();
      expect(report.status).toBe("healthy");
      expect(report.components[0].name).toBe("AsyncComponent");
    });

    it("should handle failing health checks", async () => {
      const failingComponent: HealthCheckable = {
        getHealth: () => {
          throw new Error("Check failed");
        },
      };

      aggregator.register("failing", failingComponent);

      const report = await aggregator.getHealth();
      expect(report.status).toBe("unhealthy");
      expect(report.components[0].message).toContain("Check failed");
    });

    it("should track uptime", async () => {
      await new Promise((r) => setTimeout(r, 50));
      const report = await aggregator.getHealth();
      expect(report.uptimeMs).toBeGreaterThanOrEqual(50);
    });

    it("should report liveness", () => {
      expect(aggregator.isAlive()).toBe(true);
    });

    it("should report readiness based on health", async () => {
      expect(await aggregator.isReady()).toBe(true);

      const unhealthyComponent: HealthCheckable = {
        getHealth: () => ({ name: "Bad", status: "unhealthy" }),
      };
      aggregator.register("bad", unhealthyComponent);

      expect(await aggregator.isReady()).toBe(false);
    });
  });

  describe("ActorSystem health", () => {
    let system: ActorSystem;
    let transport: InMemoryTransport;
    let registry: LocalRegistry;
    let cluster: MockCluster;

    beforeEach(async () => {
      transport = new InMemoryTransport("test-system");
      registry = new LocalRegistry();
      cluster = new MockCluster("test-system");
      system = new ActorSystem(cluster, transport, registry);
    });

    it("should report unhealthy when not started", () => {
      const health = system.getHealth();
      expect(health.status).toBe("unhealthy");
      expect(health.message).toContain("not running");
    });

    it("should report healthy when running", async () => {
      await system.start();

      const health = system.getHealth();
      expect(health.status).toBe("healthy");
      expect(health.name).toBe("ActorSystem");
      expect(health.details?.actorCount).toBe(0);
    });

    it("should include actor count in details", async () => {
      await system.start();
      system.registerActorClass(TestActor);

      system.spawn(TestActor);
      system.spawn(TestActor);
      system.spawn(TestActor);

      const health = system.getHealth();
      expect(health.details?.actorCount).toBe(3);
    });

    it("should report degraded when shutting down", async () => {
      await system.start();
      system.registerActorClass(TestActor);

      // Start shutdown but don't await
      const shutdownPromise = system.shutdown();

      const health = system.getHealth();
      expect(health.status).toBe("degraded");
      expect(health.message).toContain("shutting down");

      await shutdownPromise;
    });
  });

  describe("HealthAggregator with ActorSystem", () => {
    it("should aggregate ActorSystem health", async () => {
      const transport = new InMemoryTransport("test-system");
      const registry = new LocalRegistry();
      const cluster = new MockCluster("test-system");
      const system = new ActorSystem(cluster, transport, registry);

      await system.start();

      const aggregator = new HealthAggregator("test-system");
      aggregator.register("actorSystem", system);

      const report = await aggregator.getHealth();
      expect(report.status).toBe("healthy");
      expect(report.components).toHaveLength(1);
      expect(report.components[0].name).toBe("ActorSystem");
    });
  });
});
