import { Command, Option } from "clipanion";
import { loadConfig } from "../config.js";
import { NodeSupervisor } from "../supervisor.js";

export class StartCommand extends Command {
  static paths = [["start"]];
  static usage = Command.Usage({
    description: "Start cluster nodes",
    examples: [
      ["Start all nodes", "libeam start"],
      ["Start only workers", "libeam start --role=worker"],
      ["Start in background", "libeam start --daemon"],
    ],
  });

  role = Option.String("--role", { required: false, description: "Only start nodes with this role" });
  daemon = Option.Boolean("--daemon", false, { description: "Run in background" });

  async execute() {
    const config = await loadConfig();
    const supervisor = new NodeSupervisor(config);

    const cleanup = async () => {
      this.context.stdout.write("\n[libeam] Shutting down...\n");
      await supervisor.stopAll();
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    this.context.stdout.write("[libeam] Starting cluster...\n");

    try {
      await supervisor.startAll(this.role ?? undefined);
      const nodes = supervisor.getRunningNodes();
      this.context.stdout.write(`[libeam] Cluster ready — ${nodes.length} node(s) running\n`);
      for (const name of nodes) {
        const node = supervisor.getNode(name);
        if (node?.status) {
          this.context.stdout.write(`  ${name}: port=${node.status.port} roles=[${node.status.roles.join(",")}]\n`);
        }
      }

      if (!this.daemon) {
        await new Promise(() => {});
      }
      return 0;
    } catch (err: unknown) {
      this.context.stderr.write(`[libeam] Error: ${err instanceof Error ? err.message : String(err)}\n`);
      await supervisor.stopAll();
      return 1;
    }
  }
}
