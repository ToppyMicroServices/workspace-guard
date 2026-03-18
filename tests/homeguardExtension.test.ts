import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOME_WARNING_ACTIONS,
  activateHomeguardExtension,
  createHomeguardCommandHandlers,
  scanGithubMetadata,
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

async function writeRepoFile(rootPath: string, relativePath: string, content: string): Promise<void> {
  const targetPath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

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
    expect(openedFolders.map((entry) => path.normalize(entry))).toEqual([
      path.normalize(escapeDir)
    ]);
    expect(infos[0]).toContain("redirected");

    const readme = await readFile(path.join(escapeDir, "README.md"), "utf8");
    expect(readme).toContain("Escape Folder");
  });

  it("detects home folders added to a multi-root workspace", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "homeguard-ext-"));
    tempDirs.push(sandbox);
    const homeDir = path.join(sandbox, "home");
    const { host, emitChange, removedFolders } = await createHost({
      homeDir,
      env: { HOME: homeDir },
      workspaceFolders: [{ uri: { fsPath: path.join(homeDir, "work", "projectA") } }]
    });

    const activation = await activateHomeguardExtension(host, {
      mode: "block"
    });
    await emitChange({
      added: [{ uri: { fsPath: homeDir } }],
      removed: []
    });

    expect(removedFolders).toContain(homeDir);
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

  it("summarizes risky .github automation on startup when scanner support is available", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "homeguard-gh-review-"));
    tempDirs.push(repoDir);
    await writeRepoFile(repoDir, ".github/workflows/release.yml", `name: release
on:
  pull_request_target:
jobs:
  ship:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - run: curl https://example.invalid/install.sh | bash
`);
    const { host } = await createHost({
      workspaceFolders: [{ uri: { fsPath: repoDir } }],
      scanGithubMetadata
    });

    const activation = await activateHomeguardExtension(host, {
      githubReview: {
        checkOnStartup: true
      }
    });

    expect(activation.githubMetadataSummary).toEqual(expect.objectContaining({
      workspaceFoldersScanned: 1,
      workspaceFoldersWithGithub: 1,
      workspaceFoldersWithRisk: 1
    }));
    expect(activation.githubMetadataSummary?.highFindings).toBeGreaterThan(0);
    expect(activation.githubMetadataReports?.[0]?.scannedFiles).toContain(".github/workflows/release.yml");
  });

  it("does not surface startup .github review when findings are informational only", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "homeguard-gh-review-"));
    tempDirs.push(repoDir);
    await writeRepoFile(repoDir, ".github/CODEOWNERS", `* @security-team
`);
    const { host } = await createHost({
      workspaceFolders: [{ uri: { fsPath: repoDir } }],
      scanGithubMetadata
    });

    const activation = await activateHomeguardExtension(host, {
      githubReview: {
        checkOnStartup: true
      }
    });

    expect(activation.githubMetadataReports?.[0]?.scannedFiles).toContain(".github/CODEOWNERS");
    expect(activation.githubMetadataSummary).toBeUndefined();
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

    expect(path.normalize(target)).toBe(path.normalize(path.join(homeDir, "work", "_escape")));
    expect(openedFolders.map((entry) => path.normalize(entry))).toEqual([
      path.normalize(path.join(homeDir, "work", "_escape"))
    ]);
  });

  it("reviews .github automation for the current workspace on demand", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "homeguard-gh-review-"));
    tempDirs.push(repoDir);
    await writeRepoFile(repoDir, ".github/workflows/ci.yml", `name: ci
on:
  workflow_dispatch:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.inputs.name }}"
`);
    const { host } = await createHost({
      workspaceFolders: [{ uri: { fsPath: repoDir } }],
      scanGithubMetadata
    });
    const handlers = createHomeguardCommandHandlers(host);

    const reports = await handlers.reviewGithubMetadata();

    expect(reports).toHaveLength(1);
    expect(reports[0]?.findings.length).toBeGreaterThan(0);
    expect(reports[0]?.scannedFiles).toContain(".github/workflows/ci.yml");
  });
});
