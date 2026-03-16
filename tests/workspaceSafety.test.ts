import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_SAFETY_ACTIONS,
  assessWorkspaceSafety,
  createWorkspaceSafetyGuard,
  evaluateWorkspaceAction,
  type HomeguardExtensionHost,
  type WorkspaceFoldersChangeEventLike
} from "../src";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dirPath) => {
    await rm(dirPath, { recursive: true, force: true });
  }));
});

async function createHost(overrides: Partial<HomeguardExtensionHost> = {}): Promise<{
  host: HomeguardExtensionHost;
  warnings: string[];
  openedFolders: string[];
  removedFolders: string[];
}> {
  const warnings: string[] = [];
  const openedFolders: string[] = [];
  const removedFolders: string[] = [];
  let listener: ((event: WorkspaceFoldersChangeEventLike) => void | Promise<void>) | undefined;

  const host: HomeguardExtensionHost = {
    workspaceFolders: [],
    homeDir: "/Users/akira",
    env: {},
    platform: "darwin",
    showWarningMessage: vi.fn(async (message: string, ...items: string[]) => {
      warnings.push(message);
      return items[0];
    }),
    showInformationMessage: vi.fn(async () => undefined),
    openFolder: vi.fn(async (targetPath: string) => {
      openedFolders.push(targetPath);
    }),
    removeWorkspaceFolder: vi.fn(async (targetPath: string) => {
      removedFolders.push(targetPath);
    }),
    onDidChangeWorkspaceFolders: (registeredListener) => {
      listener = registeredListener;
      return {
        dispose: () => {
          listener = undefined;
        }
      };
    },
    now: () => new Date("2026-03-09T10:11:12.000Z"),
    ...overrides
  };

  void listener;

  return {
    host,
    warnings,
    openedFolders,
    removedFolders
  };
}

describe("assessWorkspaceSafety", () => {
  it("classifies a home workspace as dangerous", async () => {
    const assessment = await assessWorkspaceSafety({
      workspaceFolders: [{ path: "/Users/akira" }],
      homeDir: "/Users/akira",
      env: { HOME: "/Users/akira" },
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    expect(assessment.classification).toBe("dangerous");
    expect(assessment.hasHomeFolder).toBe(true);
    expect(assessment.riskScore).toBeGreaterThanOrEqual(80);
  });

  it("classifies high-risk folders as elevated", async () => {
    const assessment = await assessWorkspaceSafety({
      workspaceFolders: [{ path: "/Users/akira/.ssh" }],
      homeDir: "/Users/akira",
      env: { HOME: "/Users/akira" },
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    expect(assessment.classification).toBe("elevated");
    expect(assessment.highRiskFolders).toEqual(["/Users/akira/.ssh"]);
  });
});

describe("evaluateWorkspaceAction", () => {
  it("blocks publish in dangerous workspaces", async () => {
    const assessment = await assessWorkspaceSafety({
      workspaceFolders: [{ path: "/Users/akira" }],
      homeDir: "/Users/akira",
      env: { HOME: "/Users/akira" },
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    const evaluation = evaluateWorkspaceAction({
      actionType: "publish",
      command: "npm publish",
      label: "Publish package"
    }, assessment);

    expect(evaluation.enforcement).toBe("block");
    expect(evaluation.reason).toContain("Publishing is blocked");
  });

  it("confirms destructive terminal commands in a home workspace", async () => {
    const assessment = await assessWorkspaceSafety({
      workspaceFolders: [{ path: "/Users/akira" }],
      homeDir: "/Users/akira",
      env: { HOME: "/Users/akira" },
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    const evaluation = evaluateWorkspaceAction({
      actionType: "terminal",
      command: "rm -rf tmp/cache",
      label: "Terminal command"
    }, assessment);

    expect(evaluation.enforcement).toBe("confirm");
    expect(evaluation.reason).toContain("looks destructive");
  });

  it("confirms delete actions in high-risk workspaces", async () => {
    const assessment = await assessWorkspaceSafety({
      workspaceFolders: [{ path: "/Users/akira/.ssh" }],
      homeDir: "/Users/akira",
      env: { HOME: "/Users/akira" },
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    const evaluation = evaluateWorkspaceAction({
      actionType: "delete",
      targets: ["/Users/akira/.ssh/config"]
    }, assessment);

    expect(evaluation.enforcement).toBe("confirm");
  });

  it("allows safe save actions in safe workspaces", async () => {
    const assessment = await assessWorkspaceSafety({
      workspaceFolders: [{ path: "/Users/akira/work/projectA" }],
      homeDir: "/Users/akira",
      env: { HOME: "/Users/akira" },
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    const evaluation = evaluateWorkspaceAction({
      actionType: "save",
      label: "Save file"
    }, assessment);

    expect(evaluation.enforcement).toBe("allow");
  });

  it("confirms wide git operations in home workspaces", async () => {
    const assessment = await assessWorkspaceSafety({
      workspaceFolders: [{ path: "/Users/akira" }],
      homeDir: "/Users/akira",
      env: { HOME: "/Users/akira" },
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    const evaluation = evaluateWorkspaceAction({
      actionType: "git",
      gitOperation: "add-all",
      command: "git add -A",
      label: "Stage all"
    }, assessment);

    expect(evaluation.enforcement).toBe("confirm");
  });

  it("warns task execution in elevated workspaces", async () => {
    const assessment = await assessWorkspaceSafety({
      workspaceFolders: [{ path: "/Users/akira/.ssh" }],
      homeDir: "/Users/akira",
      env: { HOME: "/Users/akira" },
      platform: "darwin",
      realpath: async (candidate) => candidate
    });

    const evaluation = evaluateWorkspaceAction({
      actionType: "task",
      taskDefinition: {
        name: "List files",
        command: "ls -la"
      }
    }, assessment, {
      safety: {
        requireConfirmationForDestructiveActions: false
      }
    });

    expect(evaluation.enforcement).toBe("warn");
  });
});

describe("createWorkspaceSafetyGuard", () => {
  it("allows safe actions without prompting", async () => {
    const { host, warnings } = await createHost({
      workspaceFolders: [{ uri: { fsPath: "/Users/akira/work/projectA" } }]
    });
    const guard = createWorkspaceSafetyGuard(host);

    const result = await guard.runGuardedAction({
      actionType: "save",
      label: "Save file"
    }, async () => "saved");

    expect(result.allowed).toBe(true);
    expect(result.disposition).toBe("allowed");
    expect(result.result).toBe("saved");
    expect(warnings).toHaveLength(0);
  });

  it("requires confirmation for destructive terminal commands", async () => {
    const { host, warnings } = await createHost({
      workspaceFolders: [{ uri: { fsPath: "/Users/akira" } }]
    });
    const guard = createWorkspaceSafetyGuard(host);

    const result = await guard.runGuardedAction({
      actionType: "terminal",
      command: "rm -rf tmp/cache",
      label: "Terminal command"
    }, async () => "executed");

    expect(result.allowed).toBe(true);
    expect(result.disposition).toBe("confirmed");
    expect(result.result).toBe("executed");
    expect(warnings[0]).toContain("dangerous workspace");
  });

  it("blocks publish and remediates to the escape folder when selected", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "homeguard-safety-"));
    tempDirs.push(sandbox);
    const homeDir = path.join(sandbox, "home");
    const { host, openedFolders, removedFolders } = await createHost({
      homeDir,
      env: { HOME: homeDir },
      workspaceFolders: [{ uri: { fsPath: homeDir } }],
      showWarningMessage: vi.fn(async (_message: string, ...items: string[]) => {
        return items.find((item) => item === WORKSPACE_SAFETY_ACTIONS.openEscapeFolder);
      })
    });
    const guard = createWorkspaceSafetyGuard(host, {
      escapeFolder: "~/work/_escape"
    });

    const result = await guard.runGuardedAction({
      actionType: "publish",
      command: "npm publish",
      label: "Publish package"
    }, async () => "published");

    expect(result.allowed).toBe(false);
    expect(result.disposition).toBe("blocked");
    expect(result.result).toBeUndefined();
    expect(removedFolders).toEqual([homeDir]);
    expect(openedFolders.map((entry) => path.normalize(entry))).toEqual([
      path.normalize(path.join(homeDir, "work", "_escape"))
    ]);
  });

  it("cancels git operations when the user declines confirmation", async () => {
    const { host } = await createHost({
      workspaceFolders: [{ uri: { fsPath: "/Users/akira" } }],
      showWarningMessage: vi.fn(async () => WORKSPACE_SAFETY_ACTIONS.cancel)
    });
    const guard = createWorkspaceSafetyGuard(host);

    const result = await guard.runGuardedAction({
      actionType: "git",
      gitOperation: "add-all",
      command: "git add -A",
      label: "Stage all"
    }, async () => "staged");

    expect(result.allowed).toBe(false);
    expect(result.disposition).toBe("cancelled");
  });
});
