import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "clipanion";

const TEMPLATE = `import type { LibeamConfig } from "libeam/cli";

export default {
  cluster: {
    cookie: process.env.LIBEAM_COOKIE ?? "change-me-in-production",
    seedNodes: [],
  },
  nodes: {
    app: {
      entry: "./src/app.ts",
      roles: ["app"],
      count: 1,
      port: 5000,
    },
  },
  deploy: {
    strategy: "rolling",
    drainTimeout: 30000,
    healthCheck: {
      interval: 1000,
      retries: 10,
    },
  },
} satisfies LibeamConfig;
`;

export class InitCommand extends Command {
  static paths = [["init"]];
  static usage = Command.Usage({ description: "Create a libeam.config.ts file" });

  async execute() {
    const configPath = resolve(process.cwd(), "libeam.config.ts");
    if (existsSync(configPath)) {
      this.context.stderr.write("[libeam] libeam.config.ts already exists\n");
      return 1;
    }
    writeFileSync(configPath, TEMPLATE, "utf-8");
    this.context.stdout.write("[libeam] Created libeam.config.ts\n");
    return 0;
  }
}
