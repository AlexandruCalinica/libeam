import { Command, Option } from "clipanion";

export class StopCommand extends Command {
  static paths = [["stop"]];
  static usage = Command.Usage({ description: "Stop running cluster nodes" });

  force = Option.Boolean("--force", false, { description: "Force stop without draining" });
  timeout = Option.String("--timeout", "5000", { description: "Shutdown timeout in ms" });

  async execute() {
    this.context.stdout.write("[libeam] Stop command — requires a running supervisor (not yet implemented for detached mode)\n");
    this.context.stdout.write("[libeam] Use Ctrl-C on the running `libeam start` process, or send SIGTERM.\n");
    return 0;
  }
}
