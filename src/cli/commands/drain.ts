import { Command, Option } from "clipanion";

export class DrainCommand extends Command {
  static paths = [["drain"]];
  static usage = Command.Usage({
    description: "Drain a node — stop accepting new actors, migrate existing ones",
    examples: [["Drain node with migration", "libeam drain worker-1 --target=worker-2"]],
  });

  nodeId = Option.String({ required: true, name: "node-id" });
  target = Option.String("--target", { required: false, description: "Target node for actor migration" });
  timeout = Option.String("--timeout", "30000", { description: "Drain timeout in ms" });

  async execute() {
    this.context.stdout.write(`[libeam] Drain command for node "${this.nodeId}" — requires a running supervisor\n`);
    return 0;
  }
}
