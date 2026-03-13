import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import { buildCliExecutionPlan, runHomeguardCode } from "../src";

describe("buildCliExecutionPlan", () => {
  it("passes through safe targets", async () => {
    const plan = await buildCliExecutionPlan(["~/work/projectA"], {
      mode: "warn",
      cwd: "/tmp",
      env: {},
      homeDir: "/Users/akira",
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    expect(plan.shouldWarn).toBe(false);
    expect(plan.args).toEqual(["~/work/projectA"]);
  });

  it("warns when dot resolves to home", async () => {
    const plan = await buildCliExecutionPlan(["."], {
      mode: "warn",
      cwd: "/Users/akira",
      env: { HOME: "/Users/akira" },
      homeDir: "/Users/akira",
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    expect(plan.shouldWarn).toBe(true);
    expect(plan.shouldBlock).toBe(false);
    expect(plan.args).toEqual(["."]);
    expect(plan.warnings[0]).toContain("Current directory is your home directory");
  });

  it("redirects only risky targets", async () => {
    const plan = await buildCliExecutionPlan(["~/work/projectA", "~"], {
      mode: "redirect",
      escapeFolder: "~/work/_escape",
      cwd: "/tmp",
      env: {},
      homeDir: "/Users/akira",
      platform: "darwin",
      allowList: ["~/work"],
      realpath: async (candidate) => candidate
    });

    expect(plan.shouldRedirect).toBe(true);
    expect(plan.args).toEqual(["~/work/projectA", "/Users/akira/work/_escape"]);
  });

  it("warns for high-risk folders without redirecting them", async () => {
    const plan = await buildCliExecutionPlan(["~/.ssh/config"], {
      mode: "redirect",
      cwd: "/tmp",
      env: {},
      homeDir: "/Users/akira",
      platform: "darwin",
      highRiskFolders: ["~/.ssh"],
      realpath: async (candidate) => candidate
    });

    expect(plan.shouldWarn).toBe(true);
    expect(plan.shouldRedirect).toBe(false);
    expect(plan.args).toEqual(["~/.ssh/config"]);
    expect(plan.warnings.at(-1)).toContain("high-risk folder");
  });

  it("blocks dangerous targets", async () => {
    const plan = await buildCliExecutionPlan(["$HOME"], {
      mode: "block",
      cwd: "/tmp",
      env: { HOME: "/Users/akira" },
      homeDir: "/Users/akira",
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    expect(plan.shouldBlock).toBe(true);
    expect(plan.exitCode).toBe(2);
    expect(plan.warnings.at(-1)).toContain("blocked");
  });

  it("supports double-dash path arguments", async () => {
    const plan = await buildCliExecutionPlan(["--new-window", "--", "$HOME"], {
      mode: "warn",
      cwd: "/tmp",
      env: { HOME: "/Users/akira" },
      homeDir: "/Users/akira",
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    expect(plan.shouldWarn).toBe(true);
    expect(plan.analyses).toHaveLength(1);
    expect(plan.analyses[0]?.argIndex).toBe(2);
  });
});

describe("runHomeguardCode", () => {
  it("writes warnings and returns block exit code without spawning", async () => {
    const writes: string[] = [];
    const spawnCommand = vi.fn();

    const exitCode = await runHomeguardCode(["$HOME"], {
      mode: "block",
      cwd: "/tmp",
      env: { HOME: "/Users/akira" },
      homeDir: "/Users/akira",
      platform: "darwin",
      realpath: async (candidate) => candidate
    }, {
      stderr: { write: (message: string) => {
        writes.push(message);
        return true;
      } },
      spawnCommand: spawnCommand as never
    });

    expect(exitCode).toBe(2);
    expect(spawnCommand).not.toHaveBeenCalled();
    expect(writes.join("\n")).toContain("blocked");
  });

  it("spawns the wrapped code command for allowed execution", async () => {
    const spawnCommand = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        on: (event: string, listener: (...args: unknown[]) => void) => EventEmitter;
      };
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });

    const exitCode = await runHomeguardCode(["~/work/projectA"], {
      mode: "warn",
      cwd: "/tmp",
      env: {},
      homeDir: "/Users/akira",
      platform: "darwin",
      codeCommand: "code",
      realpath: async (candidate) => candidate
    }, {
      spawnCommand: spawnCommand as never,
      stderr: { write: () => true }
    });

    expect(exitCode).toBe(0);
    expect(spawnCommand).toHaveBeenCalledWith("code", ["~/work/projectA"], {
      stdio: "inherit"
    });
  });

  it("creates the escape folder before redirecting", async () => {
    const spawnCommand = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        on: (event: string, listener: (...args: unknown[]) => void) => EventEmitter;
      };
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    const ensureEscapeFolder = vi.fn(async () => ({
      path: "/Users/akira/work/_escape",
      ephemeral: false,
      createdFiles: []
    }));

    const exitCode = await runHomeguardCode(["~"], {
      mode: "redirect",
      cwd: "/tmp",
      env: {},
      homeDir: "/Users/akira",
      platform: "darwin",
      realpath: async (candidate) => candidate,
      ensureEscapeFolder
    }, {
      spawnCommand: spawnCommand as never,
      stderr: { write: () => true }
    });

    expect(exitCode).toBe(0);
    expect(ensureEscapeFolder).toHaveBeenCalledOnce();
    expect(spawnCommand).toHaveBeenCalledWith("code", ["/Users/akira/work/_escape"], {
      stdio: "inherit"
    });
  });
});