import { describe, expect, it } from "vitest";

import {
  evaluatePathRisk,
  expandPathInput,
  normalizePathInput,
  toComparablePath
} from "../src";

describe("expandPathInput", () => {
  it("expands home and environment variables", () => {
    const expanded = expandPathInput("$HOME/projects/~ignored", {
      env: { HOME: "/Users/akira" },
      homeDir: "/Users/akira",
      platform: "darwin"
    });

    expect(expanded).toBe("/Users/akira/projects/~ignored");
  });

  it("expands tilde prefixes", () => {
    const expanded = expandPathInput("~/work/homeguard", {
      env: {},
      homeDir: "/Users/akira",
      platform: "darwin"
    });

    expect(expanded).toBe("/Users/akira/work/homeguard");
  });
});

describe("normalizePathInput", () => {
  it("resolves dot paths from cwd and falls back when realpath fails", async () => {
    const normalized = await normalizePathInput(".", {
      cwd: "/Users/akira",
      env: {},
      homeDir: "/Users/akira",
      platform: "darwin",
      realpath: async () => {
        throw new Error("missing");
      }
    });

    expect(normalized.resolved).toBe("/Users/akira");
    expect(normalized.realPath).toBe("/Users/akira");
    expect(normalized.usedRealpath).toBe(false);
  });

  it("normalizes trailing separators for comparison", async () => {
    const normalized = await normalizePathInput("~/", {
      cwd: "/tmp",
      env: {},
      homeDir: "/Users/akira",
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    expect(normalized.comparablePath).toBe("/Users/akira");
  });
});

describe("toComparablePath", () => {
  it("compares Windows paths case-insensitively", () => {
    expect(toComparablePath("C:\\Users\\Akira\\", "win32")).toBe(
      "c:\\users\\akira"
    );
  });
});

describe("evaluatePathRisk", () => {
  it("detects opening the home directory from dot", async () => {
    const evaluation = await evaluatePathRisk(".", {
      cwd: "/Users/akira",
      env: { HOME: "/Users/akira" },
      homeDir: "/Users/akira",
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    expect(evaluation.isHomePath).toBe(true);
    expect(evaluation.isAllowedPath).toBe(false);
  });

  it("treats allowList entries as descendants", async () => {
    const evaluation = await evaluatePathRisk("~/work/projectA", {
      cwd: "/tmp",
      env: {},
      homeDir: "/Users/akira",
      platform: "darwin",
      allowList: ["~/work"],
      realpath: async (candidate) => candidate
    });

    expect(evaluation.isHomePath).toBe(false);
    expect(evaluation.isAllowedPath).toBe(true);
  });

  it("marks high-risk folder descendants", async () => {
    const evaluation = await evaluatePathRisk("~/.ssh/config", {
      cwd: "/tmp",
      env: {},
      homeDir: "/Users/akira",
      platform: "darwin",
      highRiskFolders: ["~/.ssh"],
      realpath: async (candidate) => candidate
    });

    expect(evaluation.isHighRiskPath).toBe(true);
  });

  it("handles Windows home paths case-insensitively", async () => {
    const evaluation = await evaluatePathRisk("%USERPROFILE%", {
      cwd: "C:\\Users\\Akira\\projects",
      env: { USERPROFILE: "C:\\Users\\Akira" },
      homeDir: "C:\\Users\\Akira",
      platform: "win32",
      realpath: async (candidate) => candidate
    });

    expect(evaluation.isHomePath).toBe(true);
  });
});