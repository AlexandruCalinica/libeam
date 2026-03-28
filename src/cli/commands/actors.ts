import { Command, Option } from "clipanion";

export class ActorsCommand extends Command {
  static paths = [["actors"]];
  static usage = Command.Usage({ description: "List actors across the cluster" });

  nodeId = Option.String({ required: false, name: "node-id" });
  migratable = Option.Boolean("--migratable", false, { description: "Show only migratable actors" });

  async execute() {
    this.context.stdout.write("[libeam] Actors command — requires a running supervisor\n");
    return 0;
  }
}
