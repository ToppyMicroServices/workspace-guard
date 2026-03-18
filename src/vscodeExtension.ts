import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";

import { type HomeguardMode, type HomeguardSettingsInput } from "./core/config";
import {
  formatGithubMetadataScanResult,
  scanGithubMetadata,
  type GithubMetadataFinding,
  type GithubMetadataScanResult
} from "./core/githubMetadataScanner";
import { DEFAULT_TELEMETRY_PROFILE } from "./core/telemetry";
import type { SettingsStore } from "./core/settingsBackup";
import {
  activateHomeguardExtension,
  createHomeguardCommandHandlers,
  summarizeGithubMetadataReports,
  type GithubMetadataReviewSummary,
  type HomeguardExtensionHost,
  type WorkspaceFolderLike
} from "./extension/homeguardExtension";
import {
  formatGithubFindingDescription,
  formatGithubFindingTooltip,
  formatGithubMetadataSummary,
  formatGithubMetadataWorkspaceLabel,
  formatGithubMetadataWorkspaceSummary
} from "./extension/githubReviewPresentation";
import { formatGithubFindingRemediationMarkdown } from "./extension/githubRemediation";

const LAST_BACKUP_PATH_KEY = "homeguard.lastTelemetryBackupPath";

type GithubReviewTreeNode =
  | { kind: "summary"; summary: GithubMetadataReviewSummary }
  | { kind: "workspace"; report: GithubMetadataScanResult }
  | { kind: "finding"; finding: GithubMetadataFinding; rootPath: string }
  | { kind: "empty"; label: string; description?: string };

class GithubReviewTreeProvider implements vscode.TreeDataProvider<GithubReviewTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<GithubReviewTreeNode | undefined>();

  private reports: GithubMetadataScanResult[] = [];

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setReports(reports: GithubMetadataScanResult[]): void {
    this.reports = reports;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: GithubReviewTreeNode): vscode.TreeItem {
    if (element.kind === "empty") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.description = element.description;
      item.contextValue = "workspaceGuardGithubReview.empty";
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }

    if (element.kind === "summary") {
      const item = new vscode.TreeItem(
        element.summary.totalFindings === 0 ? "No .github risks" : `${element.summary.totalFindings} .github findings`,
        vscode.TreeItemCollapsibleState.None
      );
      item.description = element.summary.totalFindings === 0
        ? `${element.summary.workspaceFoldersWithGithub} workspace folder${element.summary.workspaceFoldersWithGithub === 1 ? "" : "s"} with .github`
        : formatGithubMetadataSummary(element.summary);
      item.tooltip = formatGithubMetadataSummary(element.summary);
      item.contextValue = "workspaceGuardGithubReview.summary";
      item.iconPath = new vscode.ThemeIcon(element.summary.highFindings > 0 ? "warning" : "shield");
      return item;
    }

    if (element.kind === "workspace") {
      const collapsibleState = element.report.findings.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
      const item = new vscode.TreeItem(
        formatGithubMetadataWorkspaceLabel(element.report),
        collapsibleState
      );
      item.description = formatGithubMetadataWorkspaceSummary(element.report);
      item.tooltip = `${element.report.rootPath}\n${formatGithubMetadataWorkspaceSummary(element.report)}`;
      item.contextValue = "workspaceGuardGithubReview.workspace";
      item.iconPath = new vscode.ThemeIcon("repo");
      return item;
    }

    const item = new vscode.TreeItem(element.finding.message, vscode.TreeItemCollapsibleState.None);
    item.description = formatGithubFindingDescription(element.finding);
    item.tooltip = formatGithubFindingTooltip(element.finding);
    item.contextValue = `workspaceGuardGithubReview.finding.${element.finding.severity}`;
    item.iconPath = new vscode.ThemeIcon(
      element.finding.severity === "high" ? "error" : (element.finding.severity === "medium" ? "warning" : "info")
    );
    item.command = {
      command: "homeguard.suggestGithubRemediation",
      title: "Suggest .github Remediation",
      arguments: [element.finding, element.rootPath]
    };
    return item;
  }

  public getChildren(element?: GithubReviewTreeNode): GithubReviewTreeNode[] {
    if (!element) {
      const scannedReports = this.reports.filter((report) => report.scannedFiles.length > 0);
      if (scannedReports.length === 0) {
        return [{ kind: "empty", label: "No .github files in the current workspace." }];
      }

      return [
        { kind: "summary", summary: summarizeGithubMetadataReports(scannedReports) },
        ...scannedReports.map((report) => ({ kind: "workspace", report } as const))
      ];
    }

    if (element.kind === "workspace") {
      if (element.report.findings.length === 0) {
        return [{ kind: "empty", label: "No findings", description: "This workspace .github review is clean." }];
      }

      return element.report.findings.map((finding) => ({ kind: "finding", finding, rootPath: element.report.rootPath }));
    }

    return [];
  }
}

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
    githubReview: {
      checkOnStartup: configuration.get<boolean>("githubReview.checkOnStartup")
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
    },
    scanGithubMetadata: async (rootPath) => await scanGithubMetadata(rootPath)
  };
}

function formatTelemetrySummary(actionableChanges: number): string {
  if (actionableChanges === 0) {
    return "Workspace Guard found no telemetry settings that need hardening.";
  }

  return `Workspace Guard found ${actionableChanges} telemetry setting${actionableChanges === 1 ? "" : "s"} that can be hardened.`;
}

function formatWorkspaceSafetyMessage(assessment: Awaited<ReturnType<ReturnType<typeof createHomeguardCommandHandlers>["assessWorkspaceSafety"]>>): string {
  if (assessment.classification === "safe") {
    return "Workspace Guard considers the current workspace safe.";
  }

  const parts = [
    `Classification: ${assessment.classification}`,
    `Home folders: ${assessment.homeFolders.length}`,
    `High-risk folders: ${assessment.highRiskFolders.length}`
  ];
  return `Workspace Guard workspace safety assessment. ${parts.join(" | ")}`;
}

function writeGithubMetadataReports(
  outputChannel: vscode.OutputChannel,
  reports: GithubMetadataScanResult[]
): GithubMetadataReviewSummary {
  const summary = summarizeGithubMetadataReports(reports);
  outputChannel.appendLine(formatGithubMetadataSummary(summary));

  for (const report of reports) {
    if (report.scannedFiles.length === 0) {
      continue;
    }

    outputChannel.appendLine("");
    outputChannel.appendLine(`Workspace: ${report.rootPath}`);
    outputChannel.appendLine(formatGithubMetadataScanResult(report));
  }

  return summary;
}

function formatModeLabel(mode: HomeguardMode): string {
  switch (mode) {
    case "warn":
      return "Warn";
    case "redirect":
      return "Redirect";
    case "block":
      return "Block";
    case "audit-only":
      return "Audit Only";
  }
}

function formatProtectionState(enabled: boolean, mode: HomeguardMode): string {
  if (!enabled) {
    return "Off";
  }

  return formatModeLabel(mode);
}

function updateProtectionStatusBarItem(statusBarItem: vscode.StatusBarItem): void {
  const configuration = vscode.workspace.getConfiguration("homeguard");
  const enabled = configuration.get<boolean>("enable", true);
  const mode = configuration.get<HomeguardMode>("mode", "redirect");
  const stateLabel = formatProtectionState(enabled, mode);

  statusBarItem.text = `$(shield) WG: ${stateLabel}`;
  statusBarItem.tooltip = `Workspace Guard protection is ${stateLabel}. Click to change the protection mode.`;
  statusBarItem.show();
}

async function pickProtectionMode(
  currentEnabled: boolean,
  currentMode: HomeguardMode
): Promise<{ enable: boolean; mode: HomeguardMode } | undefined> {
  const selection = await vscode.window.showQuickPick(
    [
      {
        label: "Off",
        detail: "Disable Workspace Guard protections.",
        enable: false,
        mode: currentMode
      },
      {
        label: "Redirect",
        description: "Recommended",
        detail: "Remove the home directory from the workspace and open the Escape Folder instead.",
        enable: true,
        mode: "redirect" as HomeguardMode
      },
      {
        label: "Warn",
        detail: "Show a warning and let you decide whether to keep the folder open.",
        enable: true,
        mode: "warn" as HomeguardMode
      },
      {
        label: "Block",
        detail: "Remove the home directory from the workspace unless you explicitly open the Escape Folder.",
        enable: true,
        mode: "block" as HomeguardMode
      },
      {
        label: "Audit Only",
        detail: "Log detections without changing the workspace.",
        enable: true,
        mode: "audit-only" as HomeguardMode
      }
    ],
    {
      title: "Workspace Guard Protection Mode",
      placeHolder: `Current mode: ${formatProtectionState(currentEnabled, currentMode)}`
    }
  );

  return selection ? { enable: selection.enable, mode: selection.mode } : undefined;
}

async function applyProtectionSelection(
  selection: { enable: boolean; mode: HomeguardMode },
  statusBarItem: vscode.StatusBarItem
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("homeguard");
  await configuration.update("enable", selection.enable, vscode.ConfigurationTarget.Global);
  await configuration.update("mode", selection.mode, vscode.ConfigurationTarget.Global);
  updateProtectionStatusBarItem(statusBarItem);
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
    openLabel: "Select Workspace Guard backup"
  });

  return selected?.[0]?.fsPath;
}

async function openGithubFindingLocation(
  rootPath: string,
  finding: GithubMetadataFinding
): Promise<void> {
  const filePath = path.join(rootPath, finding.file);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  if (finding.line) {
    const lineIndex = Math.max(0, finding.line - 1);
    const position = new vscode.Position(lineIndex, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}

function resolveGithubFindingCommandArgs(
  findingOrNode: GithubMetadataFinding | GithubReviewTreeNode,
  rootPath?: string
): { finding: GithubMetadataFinding; rootPath?: string } | undefined {
  if ("kind" in findingOrNode) {
    if (findingOrNode.kind !== "finding") {
      return undefined;
    }

    return {
      finding: findingOrNode.finding,
      rootPath: findingOrNode.rootPath
    };
  }

  return {
    finding: findingOrNode,
    rootPath
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Workspace Guard");
  context.subscriptions.push(outputChannel);

  const host = createHost(outputChannel);
  let activation = await activateHomeguardExtension(host, getHomeguardSettings());
  context.subscriptions.push({
    dispose: () => activation.dispose()
  });
  const githubReviewTreeProvider = new GithubReviewTreeProvider();
  const githubReviewTreeView = vscode.window.createTreeView("workspaceGuardReview", {
    treeDataProvider: githubReviewTreeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(githubReviewTreeView);

  const refreshGithubReviewTree = async (reports?: GithubMetadataScanResult[]): Promise<GithubMetadataScanResult[]> => {
    const nextReports = reports ?? await createHomeguardCommandHandlers(host, getHomeguardSettings()).reviewGithubMetadata();
    githubReviewTreeProvider.setReports(nextReports);
    return nextReports;
  };

  const protectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  protectionStatusBarItem.command = "homeguard.setMode";
  updateProtectionStatusBarItem(protectionStatusBarItem);
  context.subscriptions.push(protectionStatusBarItem);

  if (activation.telemetryReport) {
    void vscode.window.showInformationMessage(formatTelemetrySummary(activation.telemetryReport.actionableChanges.length));
  }

  if (activation.githubMetadataSummary && activation.githubMetadataReports) {
    const selection = await vscode.window.showWarningMessage(
      `${formatGithubMetadataSummary(activation.githubMetadataSummary)} Review this repository before trusting its automation.`,
      "Open Review"
    );

    if (selection === "Open Review") {
      writeGithubMetadataReports(outputChannel, activation.githubMetadataReports);
      outputChannel.show(true);
    }
  }

  await refreshGithubReviewTree(activation.githubMetadataReports);

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.openEscapeFolder", async () => {
    const commands = createHomeguardCommandHandlers(host, getHomeguardSettings());
    const targetPath = await commands.openEscapeFolder();
    await vscode.window.showInformationMessage(`Workspace Guard opened the Escape Folder at ${targetPath}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.setMode", async () => {
    const configuration = vscode.workspace.getConfiguration("homeguard");
    const currentEnabled = configuration.get<boolean>("enable", true);
    const currentMode = configuration.get<HomeguardMode>("mode", "redirect");
    const selection = await pickProtectionMode(currentEnabled, currentMode);
    if (!selection) {
      return;
    }

    if (selection.enable === currentEnabled && selection.mode === currentMode) {
      return;
    }

    await applyProtectionSelection(selection, protectionStatusBarItem);
    await vscode.window.showInformationMessage(`Workspace Guard protection is now ${formatProtectionState(selection.enable, selection.mode)}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.removeHomeFoldersFromWorkspace", async () => {
    const commands = createHomeguardCommandHandlers(host, getHomeguardSettings());
    const removedCount = await commands.removeHomeFoldersFromWorkspace();
    await vscode.window.showInformationMessage(`Workspace Guard removed ${removedCount} home folder${removedCount === 1 ? "" : "s"} from the workspace.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.auditTelemetry", async () => {
    const commands = createHomeguardCommandHandlers(host, getHomeguardSettings());
    const report = commands.auditTelemetry();
    outputChannel.appendLine(formatTelemetrySummary(report.actionableChanges.length));
    for (const item of report.settings) {
      outputChannel.appendLine(`${item.key}: ${item.status} (current=${JSON.stringify(item.currentValue)}, desired=${JSON.stringify(item.desiredValue)})`);
    }
    outputChannel.show(true);
    await vscode.window.showInformationMessage(formatTelemetrySummary(report.actionableChanges.length));
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.applyPrivacyHardening", async () => {
    const commands = createHomeguardCommandHandlers(host, getHomeguardSettings());
    const result = await commands.applyPrivacyHardening(await ensureBackupDir(context));
    if (result.backupPath) {
      await context.globalState.update(LAST_BACKUP_PATH_KEY, result.backupPath);
    }

    await vscode.window.showInformationMessage(`Workspace Guard applied ${result.applied.length} privacy hardening change${result.applied.length === 1 ? "" : "s"}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.rollbackPrivacyHardening", async () => {
    const commands = createHomeguardCommandHandlers(host, getHomeguardSettings());
    const backupPath = await pickBackupPath(context);
    if (!backupPath) {
      await vscode.window.showWarningMessage("Workspace Guard could not find a backup to roll back.");
      return;
    }

    await commands.rollbackPrivacyHardening(backupPath);
    await context.globalState.update(LAST_BACKUP_PATH_KEY, undefined);
    await vscode.window.showInformationMessage("Workspace Guard rolled back the last privacy hardening backup.");
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.assessWorkspaceSafety", async () => {
    const commands = createHomeguardCommandHandlers(host, getHomeguardSettings());
    const assessment = await commands.assessWorkspaceSafety();
    outputChannel.appendLine(formatWorkspaceSafetyMessage(assessment));
    outputChannel.show(true);
    await vscode.window.showInformationMessage(formatWorkspaceSafetyMessage(assessment));
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.reviewGithubAutomation", async () => {
    const commands = createHomeguardCommandHandlers(host, getHomeguardSettings());
    const reports = await commands.reviewGithubMetadata();
    githubReviewTreeProvider.setReports(reports);
    const summary = writeGithubMetadataReports(outputChannel, reports);
    outputChannel.show(true);
    await vscode.window.showInformationMessage(formatGithubMetadataSummary(summary));
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.refreshGithubAutomationReview", async () => {
    const reports = await refreshGithubReviewTree();
    const summary = summarizeGithubMetadataReports(reports.filter((report) => report.scannedFiles.length > 0));
    await vscode.window.showInformationMessage(formatGithubMetadataSummary(summary));
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.showGithubFindingDetails", async (findingOrNode: GithubMetadataFinding | GithubReviewTreeNode) => {
    const resolved = resolveGithubFindingCommandArgs(findingOrNode);
    if (!resolved) {
      return;
    }

    const { finding } = resolved;
    outputChannel.appendLine(`[${finding.severity}] ${finding.id} ${finding.file}${finding.line ? `:${finding.line}` : ""} ${finding.message}`);
    outputChannel.appendLine(`Reason: ${finding.reason}`);
    outputChannel.appendLine(`Suggested action: ${finding.suggestedAction}`);
    outputChannel.appendLine("");
    outputChannel.show(true);
    await vscode.window.showWarningMessage(`${finding.message} Suggested action: ${finding.suggestedAction}`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.suggestGithubRemediation", async (findingOrNode: GithubMetadataFinding | GithubReviewTreeNode, rootPath?: string) => {
    const resolved = resolveGithubFindingCommandArgs(findingOrNode, rootPath);
    if (!resolved) {
      return;
    }

    const { finding, rootPath: resolvedRootPath } = resolved;
    const selection = await vscode.window.showQuickPick(
      [
        {
          label: "Show remediation guide",
          detail: finding.suggestedAction,
          action: "guide" as const
        },
        {
          label: "Open file at finding",
          detail: `${finding.file}${finding.line ? `:${finding.line}` : ""}`,
          action: "open" as const
        },
        {
          label: "Copy suggested action",
          detail: finding.suggestedAction,
          action: "copy" as const
        },
        {
          label: "Show finding details",
          detail: `${finding.id} · ${finding.reason}`,
          action: "details" as const
        }
      ],
      {
        title: `Remediation for ${finding.id}`,
        placeHolder: finding.message
      }
    );

    if (!selection) {
      return;
    }

    if (selection.action === "open") {
      if (!resolvedRootPath) {
        await vscode.window.showWarningMessage("Workspace Guard could not resolve the file path for this finding.");
        return;
      }

      await openGithubFindingLocation(resolvedRootPath, finding);
      return;
    }

    if (selection.action === "copy") {
      await vscode.env.clipboard.writeText(finding.suggestedAction);
      await vscode.window.showInformationMessage("Workspace Guard copied the suggested action.");
      return;
    }

    if (selection.action === "details") {
      await vscode.commands.executeCommand("homeguard.showGithubFindingDetails", finding);
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      content: formatGithubFindingRemediationMarkdown(finding),
      language: "markdown"
    });
    await vscode.window.showTextDocument(document, { preview: false });
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
    await refreshGithubReviewTree();
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (!event.affectsConfiguration("homeguard")) {
      return;
    }

    updateProtectionStatusBarItem(protectionStatusBarItem);
    activation.dispose();
    activation = await activateHomeguardExtension(host, getHomeguardSettings());
    await refreshGithubReviewTree(activation.githubMetadataReports);
  }));
}

export function deactivate(): void {
}
