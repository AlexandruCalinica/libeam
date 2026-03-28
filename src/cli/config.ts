import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface NodeDefinition {
  /** Path to entry module (e.g., "./src/worker.ts") */
  entry: string;
  /** Roles for this node type */
  roles?: string[];
  /** Number of instances to start. Default: 1 */
  count?: number;
  /** Port number or "auto" for auto-assignment. Default: "auto" */
  port?: number | "auto";
}

export interface DeployConfig {
  /** Deployment strategy */
  strategy: "rolling";
  /** Max time in ms to wait for drain. Default: 30000 */
  drainTimeout?: number;
  /** Health check configuration */
  healthCheck?: {
    /** Interval between checks in ms. Default: 1000 */
    interval?: number;
    /** Number of retries before failure. Default: 10 */
    retries?: number;
  };
}

export interface LibeamConfig {
  cluster: {
    /** Cookie for cluster authentication */
    cookie?: string;
    /** Seed nodes for cluster formation */
    seedNodes?: string[];
  };
  /** Node type definitions */
  nodes: Record<string, NodeDefinition>;
  /** Deployment configuration */
  deploy?: DeployConfig;
}

const CONFIG_FILENAMES = ["libeam.config.ts", "libeam.config.js", "libeam.config.mjs"];

/**
 * Loads the libeam config from the current working directory.
 * Tries libeam.config.ts, .js, .mjs in order.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<LibeamConfig> {
  for (const filename of CONFIG_FILENAMES) {
    const configPath = resolve(cwd, filename);
    if (existsSync(configPath)) {
      const moduleUrl = pathToFileURL(configPath).href;
      const mod = await import(moduleUrl);
      const config = mod.default ?? mod;
      validateConfig(config, configPath);
      // Resolve entry paths relative to config directory
      const configDir = dirname(configPath);
      for (const [, node] of Object.entries(config.nodes)) {
        const def = node as NodeDefinition;
        if (def.entry && !def.entry.startsWith("/")) {
          def.entry = resolve(configDir, def.entry);
        }
      }
      return config;
    }
  }
  throw new Error(
    `No libeam config found. Searched for: ${CONFIG_FILENAMES.join(", ")}\n` +
      "Run `libeam init` to create a config file.",
  );
}

function validateConfig(config: any, path: string): asserts config is LibeamConfig {
  if (!config || typeof config !== "object") {
    throw new Error(`Invalid config in ${path}: must export a default object`);
  }
  if (!config.nodes || typeof config.nodes !== "object" || Object.keys(config.nodes).length === 0) {
    throw new Error(`Invalid config in ${path}: must define at least one node in "nodes"`);
  }
  for (const [name, node] of Object.entries(config.nodes)) {
    const def = node as any;
    if (!def.entry || typeof def.entry !== "string") {
      throw new Error(`Invalid config in ${path}: node "${name}" must have an "entry" string`);
    }
  }
}

/**
 * Loads config or returns null if not found (for commands that don't require config).
 */
export async function loadConfigOrNull(cwd?: string): Promise<LibeamConfig | null> {
  try {
    return await loadConfig(cwd);
  } catch {
    return null;
  }
}
