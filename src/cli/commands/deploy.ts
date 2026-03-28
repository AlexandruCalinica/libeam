import { Command, Option } from "clipanion";
import { loadConfig } from "../config.js";
import { NodeSupervisor } from "../supervisor.js";

export class DeployCommand extends Command {
  static paths = [["deploy"]];
  static usage = Command.Usage({
    description: "Rolling deploy — start new nodes, drain and stop old ones",
    examples: [
      ["Deploy workers", "libeam deploy --role=worker"],
      ["Deploy all", "libeam deploy --all"],
      ["Dry run", "libeam deploy --role=worker --dry-run"],
    ],
  });

  role = Option.String("--role", { required: false, description: "Deploy nodes with this role" });
  all = Option.Boolean("--all", false, { description: "Deploy all node types" });
  dryRun = Option.Boolean("--dry-run", false, { description: "Show what would happen without executing" });
  timeout = Option.String("--timeout", "30000", { description: "Drain timeout per node in ms" });

  async execute() {
    if (!this.role && !this.all) {
      this.context.stderr.write("[libeam] Error: specify --role=<role> or --all\n");
      return 1;
    }

    const config = await loadConfig();
    const requestedTimeout = Number.parseInt(this.timeout, 10);
    const drainTimeout = Number.isFinite(requestedTimeout)
      ? requestedTimeout
      : (config.deploy?.drainTimeout ?? 30000);

    if (!Number.isFinite(drainTimeout) || drainTimeout <= 0) {
      this.context.stderr.write(`[libeam] Error: invalid --timeout value "${this.timeout}"\n`);
      return 1;
    }

    const nodesToDeploy = Object.entries(config.nodes).filter(([, definition]) => {
      if (this.all) return true;
      return definition.roles?.includes(this.role!);
    });

    if (nodesToDeploy.length === 0) {
      this.context.stderr.write(`[libeam] No nodes match ${this.role ? `role "${this.role}"` : "any role"}\n`);
      return 1;
    }

    const nodeInstances = nodesToDeploy.flatMap(([name, definition]) => {
      const count = definition.count ?? 1;
      return Array.from({ length: count }, (_, index) => {
        const instanceName = count > 1 ? `${name}-${index + 1}` : name;
        return { instanceName, definition };
      });
    });

    if (this.dryRun) {
      this.context.stdout.write("[libeam] Dry run — no changes will be made\n\n");
      this.context.stdout.write(`Would deploy ${nodeInstances.length} node(s):\n`);
      for (const { instanceName, definition } of nodeInstances) {
        this.context.stdout.write(`  ${instanceName}: entry=${definition.entry} roles=[${(definition.roles ?? []).join(",")}]\n`);
      }
      this.context.stdout.write("\nFor each node:\n");
      this.context.stdout.write("  1. Start new instance (new code)\n");
      this.context.stdout.write("  2. Wait for healthy\n");
      this.context.stdout.write("  3. Drain old instance → migrate actors to new\n");
      this.context.stdout.write("  4. Stop old instance\n");
      return 0;
    }

    const supervisor = new NodeSupervisor(config);

    let aborted = false;
    const cleanup = async () => {
      aborted = true;
      this.context.stdout.write("\n[libeam] Deploy aborted — cleaning up...\n");
      await supervisor.stopAll();
      process.exit(1);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    this.context.stdout.write(`[libeam] Rolling deploy — ${nodeInstances.length} node(s)\n\n`);

    try {
      for (const { instanceName, definition } of nodeInstances) {
        await supervisor.startNode(instanceName, definition);
      }
    } catch (error: unknown) {
      this.context.stderr.write(`[libeam] Failed to bootstrap current nodes: ${error instanceof Error ? error.message : String(error)}\n`);
      await supervisor.stopAll();
      return 1;
    }

    let deployed = 0;
    let failed = 0;

    const healthCheckConfig = config.deploy?.healthCheck ?? {};
    const interval = healthCheckConfig.interval ?? 1000;
    const retries = healthCheckConfig.retries ?? 10;

    for (const [index, { instanceName, definition }] of nodeInstances.entries()) {
      if (aborted) break;

      const replacementName = `${instanceName}-new`;
      this.context.stdout.write(`[${index + 1}/${nodeInstances.length}] Deploying ${instanceName}...\n`);

      try {
        this.context.stdout.write(`  ▸ Starting ${replacementName}...\n`);
        await supervisor.startNode(replacementName, definition);
        this.context.stdout.write(`  ✓ ${replacementName} ready\n`);

        let healthy = false;
        for (let attempt = 1; attempt <= retries; attempt++) {
          if (aborted) break;
          try {
            const response = await supervisor.sendAndWait(replacementName, { type: "health" }, "health", 5000);
            if (response.status === "healthy") {
              healthy = true;
              break;
            }
          } catch {}

          if (attempt < retries) {
            await new Promise((resolve) => setTimeout(resolve, interval));
          }
        }

        if (!healthy) {
          this.context.stderr.write(`  ✗ ${replacementName} failed health check\n`);
          await supervisor.stopNode(replacementName);
          failed++;
          this.context.stdout.write("\n");
          continue;
        }

        this.context.stdout.write(`  ✓ ${replacementName} healthy\n`);
        this.context.stdout.write(`  ▸ Draining ${instanceName} -> ${replacementName}...\n`);
        const drain = await supervisor.drainNode(instanceName, replacementName, drainTimeout);

        if (drain.failed.length > 0) {
          this.context.stderr.write(`  ✗ Drain failed for actors: ${drain.failed.join(", ")}\n`);
          await supervisor.stopNode(replacementName);
          failed++;
          this.context.stdout.write("\n");
          continue;
        }

        this.context.stdout.write(`  ✓ Drained: migrated=${drain.migrated} drained=${drain.drained}\n`);
        this.context.stdout.write(`  ▸ Stopping ${instanceName}...\n`);
        await supervisor.stopNode(instanceName);
        this.context.stdout.write(`  ✓ ${instanceName} -> ${replacementName} deployed\n`);
        deployed++;
      } catch (error: unknown) {
        this.context.stderr.write(`  ✗ Failed to deploy ${instanceName}: ${error instanceof Error ? error.message : String(error)}\n`);
        try {
          await supervisor.stopNode(replacementName);
        } catch {}
        failed++;
      }

      this.context.stdout.write("\n");
    }

    this.context.stdout.write(`[libeam] Deploy complete: ${deployed} succeeded, ${failed} failed\n`);

    if (failed > 0 || aborted) {
      return 1;
    }

    if (supervisor.isRunning()) {
      this.context.stdout.write("[libeam] New nodes running. Press Ctrl-C to stop.\n");
      await new Promise(() => {});
    }

    return 0;
  }
}
