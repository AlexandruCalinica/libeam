import { Command } from "clipanion";

export class StatusCommand extends Command {
  static paths = [["status"]];
  static usage = Command.Usage({ description: "Show cluster status" });

  async execute() {
    this.context.stdout.write("[libeam] Status command — requires a running supervisor (not yet implemented for detached mode)\n");
    return 0;
  }
}
