// src/health.ts

/**
 * Health status of a component.
 */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/**
 * Health check result for a single component.
 */
export interface ComponentHealth {
  /** Name of the component */
  name: string;
  /** Health status */
  status: HealthStatus;
  /** Optional message providing details */
  message?: string;
  /** Optional metrics or details */
  details?: Record<string, unknown>;
}

/**
 * Overall system health report.
 */
export interface HealthReport {
  /** Overall health status (worst of all components) */
  status: HealthStatus;
  /** Timestamp of the health check */
  timestamp: Date;
  /** Node ID */
  nodeId: string;
  /** Individual component health checks */
  components: ComponentHealth[];
  /** System uptime in milliseconds */
  uptimeMs?: number;
}

/**
 * Interface for components that support health checks.
 */
export interface HealthCheckable {
  /**
   * Returns the health status of this component.
   */
  getHealth(): ComponentHealth | Promise<ComponentHealth>;
}

/**
 * Combines multiple health statuses, returning the worst one.
 * Priority: unhealthy > degraded > healthy
 */
export function combineHealthStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes("unhealthy")) return "unhealthy";
  if (statuses.includes("degraded")) return "degraded";
  return "healthy";
}

/**
 * Health check aggregator that collects health from multiple components.
 */
export class HealthAggregator {
  private readonly nodeId: string;
  private readonly startTime: number;
  private readonly components: Map<string, HealthCheckable> = new Map();

  constructor(nodeId: string) {
    this.nodeId = nodeId;
    this.startTime = Date.now();
  }

  /**
   * Registers a component for health checking.
   */
  register(name: string, component: HealthCheckable): void {
    this.components.set(name, component);
  }

  /**
   * Unregisters a component.
   */
  unregister(name: string): void {
    this.components.delete(name);
  }

  /**
   * Performs health checks on all registered components and returns a report.
   */
  async getHealth(): Promise<HealthReport> {
    const componentHealths: ComponentHealth[] = [];

    for (const [name, component] of this.components) {
      try {
        const health = await Promise.resolve(component.getHealth());
        componentHealths.push(health);
      } catch (err) {
        componentHealths.push({
          name,
          status: "unhealthy",
          message: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const overallStatus = combineHealthStatus(
      componentHealths.map((c) => c.status),
    );

    return {
      status: overallStatus,
      timestamp: new Date(),
      nodeId: this.nodeId,
      components: componentHealths,
      uptimeMs: Date.now() - this.startTime,
    };
  }

  /**
   * Quick liveness check - just returns if the system is alive.
   * Use for Kubernetes liveness probes.
   */
  isAlive(): boolean {
    return true;
  }

  /**
   * Quick readiness check - returns if the system is ready to serve requests.
   * Use for Kubernetes readiness probes.
   */
  async isReady(): Promise<boolean> {
    const report = await this.getHealth();
    return report.status !== "unhealthy";
  }
}
