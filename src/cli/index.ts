#!/usr/bin/env node

import { Builtins, Cli } from "clipanion";
import { ActorsCommand } from "./commands/actors.js";
import { DeployCommand } from "./commands/deploy.js";
import { DrainCommand } from "./commands/drain.js";
import { InitCommand } from "./commands/init.js";
import { LogsCommand } from "./commands/logs.js";
import { MigrateCommand } from "./commands/migrate.js";
import { NodesCommand } from "./commands/nodes.js";
import { StartCommand } from "./commands/start.js";
import { StatusCommand } from "./commands/status.js";
import { StopCommand } from "./commands/stop.js";

export type { DeployConfig, LibeamConfig, NodeDefinition } from "./config.js";
export type { NodeInfo, NodeStatus, SupervisorMessage, WorkerMessage } from "./ipc.js";

const cli = new Cli({
  binaryLabel: "libeam",
  binaryName: "libeam",
  binaryVersion: "0.1.2",
});

cli.register(StartCommand);
cli.register(StopCommand);
cli.register(StatusCommand);
cli.register(NodesCommand);
cli.register(DrainCommand);
cli.register(DeployCommand);
cli.register(ActorsCommand);
cli.register(MigrateCommand);
cli.register(LogsCommand);
cli.register(InitCommand);
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

const [, , ...args] = process.argv;
cli.runExit(args);
