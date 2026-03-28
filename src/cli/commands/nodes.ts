import { Command, Option } from "clipanion";

export class NodesCommand extends Command {
  static paths = [["nodes"]];
  static usage = Command.Usage({ description: "List cluster nodes" });

  role = Option.String("--role", { required: false, description: "Filter by role" });

  async execute() {
    this.context.stdout.write("[libeam] Nodes command — requires a running supervisor (not yet implemented for detached mode)\n");
    return 0;
  }
}
