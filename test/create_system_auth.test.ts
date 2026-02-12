import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createSystem, DistributedConfig } from "../src";
import { CookieAuthenticator } from "../src/auth";
import type { Authenticator } from "../src/auth";
import { loggerConfig, LogEntry } from "../src/logger";

describe("createSystem auth wiring", () => {
  const originalEnv = process.env.LIBEAM_COOKIE;
  let logEntries: LogEntry[] = [];
  let originalHandler: typeof loggerConfig.handler;

  beforeEach(() => {
    delete process.env.LIBEAM_COOKIE;
    logEntries = [];
    originalHandler = loggerConfig.handler;
    loggerConfig.handler = (entry: LogEntry) => {
      logEntries.push(entry);
    };
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.LIBEAM_COOKIE = originalEnv;
    } else {
      delete process.env.LIBEAM_COOKIE;
    }
    loggerConfig.handler = originalHandler;
  });

  describe("validation", () => {
    it("should throw error when cookie is empty string", async () => {
      const config: DistributedConfig = {
        type: "distributed",
        port: 19000,
        seedNodes: [],
        cookie: "",
      };

      await expect(createSystem(config)).rejects.toThrow(
        /cookie.*must not be empty/i
      );
    });
  });

  describe("auth resolution", () => {
    it("should create system with CookieAuthenticator when cookie is provided", async () => {
      let system;
      try {
        system = await createSystem({
          type: "distributed",
          port: 19100,
          seedNodes: [],
          cookie: "test-secret-cookie",
        });

        expect(system).toBeDefined();
        expect(system.nodeId).toBeDefined();
      } finally {
        if (system) await system.shutdown();
      }
    });

    it("should use auth over cookie when both provided", async () => {
      const customAuth: Authenticator = new CookieAuthenticator("custom-wins");

      let system;
      try {
        system = await createSystem({
          type: "distributed",
          port: 19200,
          seedNodes: [],
          cookie: "should-be-ignored",
          auth: customAuth,
        });

        expect(system).toBeDefined();
      } finally {
        if (system) await system.shutdown();
      }
    });

    it("should use LIBEAM_COOKIE env var when no explicit config", async () => {
      process.env.LIBEAM_COOKIE = "env-cookie-secret";

      let system;
      try {
        system = await createSystem({
          type: "distributed",
          port: 19300,
          seedNodes: [],
        });

        expect(system).toBeDefined();
        const warnings = logEntries.filter(
          (e) =>
            e.level === "warn" &&
            e.message.includes("WITHOUT authentication")
        );
        expect(warnings).toHaveLength(0);
      } finally {
        if (system) await system.shutdown();
      }
    });

    it("should log WARNING when no auth configured", async () => {
      delete process.env.LIBEAM_COOKIE;

      let system;
      try {
        system = await createSystem({
          type: "distributed",
          port: 19400,
          seedNodes: [],
        });

        expect(system).toBeDefined();
        const warnings = logEntries.filter(
          (e) =>
            e.level === "warn" &&
            e.message.includes("WITHOUT authentication")
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain("LIBEAM_COOKIE");
      } finally {
        if (system) await system.shutdown();
      }
    });
  });
});
