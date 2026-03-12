import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOME_WARNING_ACTIONS,
  activateHomeguardExtension,
  createHomeguardCommandHandlers,
  type HomeguardExtensionHost,
  type WorkspaceFoldersChangeEventLike
} from "../src";

class MemorySettingsStore {
  public values: Record<string, unknown>;

  public constructor(initial: Record<string, unknown>) {
    this.values = { ...initial };
  }

  public getAll(): Record<string, unknown> {
    return { ...this.values };
  }

  public async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      delete this.values[key];
      return;
    }

    this.values[key] = value;
  }
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dirPath) => {
    await rm(dirPath, { recursive: true, force: true });
  }));
});

async function createHost(overrides: Partial<HomeguardExtensionHost> = {}): Promise<{
  host: HomeguardExtensionHost;
  emitChange: (event: WorkspaceFoldersChangeEventLike) => Promise<void>;
  warnings: string[];
  infos: string[];
  openedFolders: string[];
  removedFolders: string[];
}> {
  const warnings: string[] = [];
  const infos: string[] = [];
  const openedFolders: string[] = [];
  const removedFolders: string[] = [];
  let listener: ((event: WorkspaceFoldersChangeEventLike) => void | Promise<void>) | undefined;

  const host: HomeguardExtensionHost = {
    workspaceFolders: [],
    homeDir: "/Users/akira",
    env: {},
    platform: "darwin",
    settingsStore: new MemorySettingsStore({
      "telemetry.telemetryLevel": "all",
      "github.copilot.advanced.telemetryEnabled": true
    }),
    installedExtensions: [
      { id: "github.copilot", displayName: "GitHub Copilot", tags: ["ai"] },
      { id: "vendor.remote-helper", displayName: "Remote Helper", tags: ["remote"] }
    ],
    showWarningMessage: vi.fn(async (message: string, ...items: string[]) => {
      warnings.push(message);
      return items[0];
    }),
    showInformationMessage: vi.fn(async (message: string) => {
      infos.push(message);
      return undefined;
    }),
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
    now: () => new Date("2026-03-08T01:02:03.000Z"),
    ...overrides
  };

  return {
    host,
    emitChange: async (event) => {
      await listener?.(event);
    },
    warnings,
    infos,
    openedFolders,
    removedFolders
  };
}

describe("activateHomeguardExtension", () => {
  it("detects home at startup and redirects to the escape folder", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "homeguard-ext-"));
    tempDirs.push(sandbox);
    const homeDir = path.join(sandbox, "home");
    const escapeDir = path.join(homeDir, "work", "_escape");
    const { host, openedFolders, removedFolders, infos } = await createHost({
      homeDir,
      workspaceFolders: [{ uri: { fsPath: homeDir } }],
      env: { HOME: homeDir }
    });

    const activation = await activateHomeguardExtension(host, {
      mode: "redirect",
      escapeFolder: "~/work/_escape"
    });

    expect(activation.startupDetections).toEqual([
      { folderPath: homeDir, action: "redirected" }
    ]);
    expect(removedFolders).toEqual([homeDir]);
    expect(openedFolders).toEqual([escapeDir]);
    expect(infos[0]).toContain("redirected");

    const readme = await readFile(path.join(escapeDir, "README.md"), "utf8");
    expect(readme).toContain("Escape Folder");
  });

  it("detects symlinked home folders at startup", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "homeguard-ext-"));
    tempDirs.push(sandbox);
    const homeDir = path.join(sandbox, "home");
    const linkedHome = path.join(sandbox, "linked-home");
    await mkdir(homeDir, { recursive: true });
    await symlink(homeDir, linkedHome);
    const { host, openedFolders, removedFolders } = await createHost({
      homeDir,
      workspaceFolders: [{ uri: { fsPath: linkedHome } }],
      env: { HOME: homeDir }
    });

    const activation = await activateHomeguardExtension(host, {
      mode: "redirect",
      escapeFolder: "~/work/_escape"
    });

    expect(activation.startupDetections).toEqual([
      { folderPath: linkedHome, action: "redirected" }
    ]);
    expect(removedFolders).toEqual([linkedHome]);
    expect(openedFolders).toEqual([path.join(homeDir, "work", "_escape")]);
  });

  it("detects home folders added to a multi-root workspace", async () => {
    const { host, emitChange, removedFolders } = await createHost({
      workspaceFolders: [{ uri: { fsPath: "/Users/akira/work/projectA" } }]
    });

    const activation = await activateHomeguardExtension(host, {
      mode: "block"
    });
    await emitChange({
      added: [{ uri: { fsPath: "/Users/akira" } }],
      removed: []
    });

    expect(removedFolders).toContain("/Users/akira");
    activation.dispose();
  });

  it("audits telemetry on startup when configured", async () => {
    const { host } = await createHost();

    const activation = await activateHomeguardExtension(host, {
      privacy: {
        auditOnStartup: true
      }
    });

    expect(activation.telemetryReport?.settings.some((entry) => entry.status === "Actionable")).toBe(true);
    expect(activation.telemetryReport?.extensions.some((entry) => entry.status === "Risky")).toBe(true);
  });
});

describe("createHomeguardCommandHandlers", () => {
  it("applies privacy hardening with backup and can roll it back", async () => {
    const backupDir = await mkdtemp(path.join(tmpdir(), "homeguard-backup-"));
    tempDirs.push(backupDir);
    const store = new MemorySettingsStore({
      "telemetry.telemetryLevel": "all",
      "github.copilot.advanced.telemetryEnabled": true
    });
    const { host } = await createHost({ settingsStore: store });
    const handlers = createHomeguardCommandHandlers(host, {
      privacy: {
        backupBeforeApply: true
      }
    });

    const result = await handlers.applyPrivacyHardening(backupDir);

    expect(result.backupPath).toBeDefined();
    expect(store.values["telemetry.telemetryLevel"]).toBe("off");
    expect(store.values["github.copilot.advanced.telemetryEnabled"]).toBe(false);

    await handlers.rollbackPrivacyHardening(result.backupPath as string);

    expect(store.values["telemetry.telemetryLevel"]).toBe("all");
    expect(store.values["github.copilot.advanced.telemetryEnabled"]).toBe(true);
  });

  it("removes settings that were added by hardening when rolled back", async () => {
    const backupDir = await mkdtemp(path.join(tmpdir(), "homeguard-backup-"));
    tempDirs.push(backupDir);
    const store = new MemorySettingsStore({
      "telemetry.telemetryLevel": "all"
    });
    const { host } = await createHost({ settingsStore: store });
    const handlers = createHomeguardCommandHandlers(host, {
      privacy: {
        backupBeforeApply: true
      }
    });

    const result = await handlers.applyPrivacyHardening(backupDir);

    expect(store.values["github.copilot.advanced.telemetryEnabled"]).toBe(false);

    await handlers.rollbackPrivacyHardening(result.backupPath as string);

    expect("github.copilot.advanced.telemetryEnabled" in store.values).toBe(false);
  });

  it("opens the escape folder via command handler", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "homeguard-command-"));
    tempDirs.push(sandbox);
    const homeDir = path.join(sandbox, "home");
    const { host, openedFolders } = await createHost({
      homeDir,
      env: { HOME: homeDir }
    });
    const handlers = createHomeguardCommandHandlers(host, {
      escapeFolder: "~/work/_escape"
    });

    const target = await handlers.openEscapeFolder();

    expect(target).toBe(path.join(homeDir, "work", "_escape"));
    expect(openedFolders).toEqual([path.join(homeDir, "work", "_escape")]);
  });
});
