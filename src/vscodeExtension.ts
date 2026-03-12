import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";

import { type HomeguardSettingsInput } from "./core/config";
import { DEFAULT_TELEMETRY_PROFILE } from "./core/telemetry";
import type { SettingsStore } from "./core/settingsBackup";
import {
  activateHomeguardExtension,
  createHomeguardCommandHandlers,
  type HomeguardExtensionHost,
  type WorkspaceFolderLike
} from "./extension/homeguardExtension";

const LAST_BACKUP_PATH_KEY = "homeguard.lastTelemetryBackupPath";

class VSCodeSettingsStore implements SettingsStore {
  private readonly keys: readonly string[];

  public constructor(keys: readonly string[]) {
    this.keys = keys;
  }

  public getAll(): Record<string, unknown> {
    const configuration = vscode.workspace.getConfiguration();
    const snapshot: Record<string, unknown> = {};

    for (const key of this.keys) {
      const inspected = configuration.inspect(key);
      if (!inspected || inspected.globalValue === undefined) {
        continue;
      }

      snapshot[key] = inspected.globalValue;
    }

    return snapshot;
  }

  public async update(key: string, value: unknown): Promise<void> {
    await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
  }
}

function getHomeguardSettings(): HomeguardSettingsInput {
  const configuration = vscode.workspace.getConfiguration("homeguard");

  return {
    enable: configuration.get<boolean>("enable"),
    mode: configuration.get<HomeguardSettingsInput["mode"]>("mode"),
    escapeFolder: configuration.get<string>("escapeFolder"),
    enableEphemeralEscape: configuration.get<boolean>("enableEphemeralEscape"),
    checkOnStartup: configuration.get<boolean>("checkOnStartup"),
    checkOnWorkspaceFolderAdd: configuration.get<boolean>("checkOnWorkspaceFolderAdd"),
    allowList: configuration.get<string[]>("allowList"),
    highRiskFolders: configuration.get<string[]>("highRiskFolders"),
    verbose: configuration.get<boolean>("verbose"),
    privacy: {
      auditOnStartup: configuration.get<boolean>("privacy.auditOnStartup"),
      offerHardening: configuration.get<boolean>("privacy.offerHardening"),
      backupBeforeApply: configuration.get<boolean>("privacy.backupBeforeApply")
    },
    safety: {
      enableSaveGuard: configuration.get<boolean>("safety.enableSaveGuard"),
      enableGitGuard: configuration.get<boolean>("safety.enableGitGuard"),
      enableTerminalGuard: configuration.get<boolean>("safety.enableTerminalGuard"),
      enableTaskGuard: configuration.get<boolean>("safety.enableTaskGuard"),
      enableDeleteGuard: configuration.get<boolean>("safety.enableDeleteGuard"),
      enablePublishGuard: configuration.get<boolean>("safety.enablePublishGuard"),
      requireConfirmationForDestructiveActions: configuration.get<boolean>("safety.requireConfirmationForDestructiveActions"),
      blockHighRiskPublish: configuration.get<boolean>("safety.blockHighRiskPublish")
    }
  };
}

function getWorkspaceFolders(): WorkspaceFolderLike[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    uri: {
      fsPath: folder.uri.fsPath
    },
    name: folder.name
  }));
}

function createHost(outputChannel: vscode.OutputChannel): HomeguardExtensionHost {
  const telemetryKeys = DEFAULT_TELEMETRY_PROFILE.map((entry) => entry.key);

  return {
    get workspaceFolders() {
      return getWorkspaceFolders();
    },
    homeDir: homedir(),
    env: process.env,
    platform: process.platform as HomeguardExtensionHost["platform"],
    outputChannel,
    settingsStore: new VSCodeSettingsStore(telemetryKeys),
    installedExtensions: vscode.extensions.all.map((extension) => ({
      id: extension.id,
      displayName: extension.packageJSON.displayName as string | undefined,
      tags: extension.packageJSON.keywords as string[] | undefined
    })),
    showWarningMessage: async (message, ...items) => await vscode.window.showWarningMessage(message, ...items),
    showInformationMessage: async (message, ...items) => await vscode.window.showInformationMessage(message, ...items),
    openFolder: async (targetPath) => {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(targetPath), false);
    },
    removeWorkspaceFolder: async (targetPath) => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const index = folders.findIndex((folder) => folder.uri.fsPath === targetPath);
      if (index !== -1) {
        vscode.workspace.updateWorkspaceFolders(index, 1);
      }
    },
    onDidChangeWorkspaceFolders: (listener) => {
      const disposable = vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
        await listener({
          added: event.added.map((folder) => ({
            uri: { fsPath: folder.uri.fsPath },
            name: folder.name
          })),
          removed: event.removed.map((folder) => ({
            uri: { fsPath: folder.uri.fsPath },
            name: folder.name
          }))
        });
      });

      return {
        dispose: () => disposable.dispose()
      };
    }
  };
}

function formatTelemetrySummary(actionableChanges: number): string {
  if (actionableChanges === 0) {
    return "HomeGuard found no telemetry settings that need hardening.";
  }

  return `HomeGuard found ${actionableChanges} telemetry setting${actionableChanges === 1 ? "" : "s"} that can be hardened.`;
}

function formatWorkspaceSafetyMessage(assessment: Awaited<ReturnType<ReturnType<typeof createHomeguardCommandHandlers>["assessWorkspaceSafety"]>>): string {
  if (assessment.classification === "safe") {
    return "HomeGuard considers the current workspace safe.";
  }

  const parts = [
    `Classification: ${assessment.classification}`,
    `Home folders: ${assessment.homeFolders.length}`,
    `High-risk folders: ${assessment.highRiskFolders.length}`
  ];
  return `HomeGuard workspace safety assessment. ${parts.join(" | ")}`;
}

async function ensureBackupDir(context: vscode.ExtensionContext): Promise<string> {
  const backupDir = path.join(context.globalStorageUri.fsPath, "telemetry-backups");
  await mkdir(backupDir, { recursive: true });
  return backupDir;
}

async function pickBackupPath(context: vscode.ExtensionContext): Promise<string | undefined> {
  const lastBackupPath = context.globalState.get<string>(LAST_BACKUP_PATH_KEY);
  if (lastBackupPath) {
    return lastBackupPath;
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(path.join(context.globalStorageUri.fsPath, "telemetry-backups")),
    filters: {
      JSON: ["json"]
    },
    openLabel: "Select HomeGuard backup"
  });

  return selected?.[0]?.fsPath;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("HomeGuard");
  context.subscriptions.push(outputChannel);

  const host = createHost(outputChannel);
  const activation = await activateHomeguardExtension(host, getHomeguardSettings());
  context.subscriptions.push({ dispose: () => activation.dispose() });

  if (activation.telemetryReport) {
    void vscode.window.showInformationMessage(formatTelemetrySummary(activation.telemetryReport.actionableChanges.length));
  }

  const commands = createHomeguardCommandHandlers(host, getHomeguardSettings());

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.openEscapeFolder", async () => {
    const targetPath = await commands.openEscapeFolder();
    await vscode.window.showInformationMessage(`HomeGuard opened the Escape Folder at ${targetPath}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.removeHomeFoldersFromWorkspace", async () => {
    const removedCount = await commands.removeHomeFoldersFromWorkspace();
    await vscode.window.showInformationMessage(`HomeGuard removed ${removedCount} home folder${removedCount === 1 ? "" : "s"} from the workspace.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.auditTelemetry", async () => {
    const report = commands.auditTelemetry();
    outputChannel.appendLine(formatTelemetrySummary(report.actionableChanges.length));
    for (const item of report.settings) {
      outputChannel.appendLine(`${item.key}: ${item.status} (current=${JSON.stringify(item.currentValue)}, desired=${JSON.stringify(item.desiredValue)})`);
    }
    outputChannel.show(true);
    await vscode.window.showInformationMessage(formatTelemetrySummary(report.actionableChanges.length));
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.applyPrivacyHardening", async () => {
    const result = await commands.applyPrivacyHardening(await ensureBackupDir(context));
    if (result.backupPath) {
      await context.globalState.update(LAST_BACKUP_PATH_KEY, result.backupPath);
    }

    await vscode.window.showInformationMessage(`HomeGuard applied ${result.applied.length} privacy hardening change${result.applied.length === 1 ? "" : "s"}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.rollbackPrivacyHardening", async () => {
    const backupPath = await pickBackupPath(context);
    if (!backupPath) {
      await vscode.window.showWarningMessage("HomeGuard could not find a backup to roll back.");
      return;
    }

    await commands.rollbackPrivacyHardening(backupPath);
    await context.globalState.update(LAST_BACKUP_PATH_KEY, undefined);
    await vscode.window.showInformationMessage("HomeGuard rolled back the last privacy hardening backup.");
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.assessWorkspaceSafety", async () => {
    const assessment = await commands.assessWorkspaceSafety();
    outputChannel.appendLine(formatWorkspaceSafetyMessage(assessment));
    outputChannel.show(true);
    await vscode.window.showInformationMessage(formatWorkspaceSafetyMessage(assessment));
  }));
}

export function deactivate(): void {
}
