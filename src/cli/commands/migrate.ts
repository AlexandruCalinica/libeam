import { Command, Option } from "clipanion";

export class MigrateCommand extends Command {
  static paths = [["migrate"]];
  static usage = Command.Usage({
    description: "Migrate actors between nodes",
    examples: [
      ["Migrate single actor", "libeam migrate my-actor target-node"],
      ["Migrate all from node", "libeam migrate --all --from=node-1 --to=node-2"],
    ],
  });

  actorName = Option.String({ required: false, name: "actor-name" });
  targetNode = Option.String({ required: false, name: "target-node" });
  all = Option.Boolean("--all", false, { description: "Migrate all migratable actors" });
  from = Option.String("--from", { required: false, description: "Source node" });
  to = Option.String("--to", { required: false, description: "Target node" });

  async execute() {
    this.context.stdout.write("[libeam] Migrate command — requires a running supervisor\n");
    return 0;
  }
}
