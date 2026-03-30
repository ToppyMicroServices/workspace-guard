import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";

import { resolveHomeguardSettings, type HomeguardMode, type HomeguardSettingsInput } from "./core/config";
import {
  formatGithubMetadataScanResult,
  scanGithubMetadata,
  type GithubMetadataFinding,
  type GithubMetadataScanResult
} from "./core/githubMetadataScanner";
import { DEFAULT_TELEMETRY_PROFILE } from "./core/telemetry";
import { reviewInstalledExtensions } from "./core/extensionPolicy";
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
  filterGithubMetadataReport,
  formatGithubMetadataSummary,
  formatGithubMetadataReportsMarkdown,
  formatGithubTrustLabel,
  formatGithubMetadataWorkspaceLabel,
  formatGithubMetadataWorkspaceSummary,
  type GithubReviewSeverityFilter
} from "./extension/githubReviewPresentation";
import {
  formatGithubFindingRemediationMarkdown,
  getGithubFindingRemediationSnippet
} from "./extension/githubRemediation";
import {
  collectEphemeralWorkspaceCleanupTargets,
  getRecentWorkspaceSuggestions,
  updateRecentWorkspaceHistory
} from "./extension/workspaceSession";

const LAST_BACKUP_PATH_KEY = "homeguard.lastTelemetryBackupPath";
const GITHUB_REVIEW_FILTER_KEY = "homeguard.githubReviewSeverityFilter";
const RECENT_WORKSPACES_KEY = "homeguard.recentWorkspaces";
const RECENT_WORKSPACES_LAST_SHOWN_AT_KEY = "homeguard.recentWorkspacesLastShownAt";
const RECENT_WORKSPACES_PROMPT_COOLDOWN_MS = 60_000;

type GithubReviewTreeNode =
  | { kind: "summary"; summary: GithubMetadataReviewSummary; filteredSummary: GithubMetadataReviewSummary; filter: GithubReviewSeverityFilter }
  | { kind: "workspace"; report: GithubMetadataScanResult; fullReport: GithubMetadataScanResult; filter: GithubReviewSeverityFilter }
  | { kind: "finding"; finding: GithubMetadataFinding; rootPath: string }
  | { kind: "empty"; label: string; description?: string };

interface GithubReviewTreeSnapshotNode {
  kind: GithubReviewTreeNode["kind"];
  label: string;
  description?: string | boolean;
  contextValue?: string;
  children?: GithubReviewTreeSnapshotNode[];
}

interface GithubReviewTreeSnapshot {
  filter: GithubReviewSeverityFilter;
  summary: GithubMetadataReviewSummary;
  nodes: GithubReviewTreeSnapshotNode[];
}

class GithubReviewTreeProvider implements vscode.TreeDataProvider<GithubReviewTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<GithubReviewTreeNode | undefined>();

  private reports: GithubMetadataScanResult[] = [];
  private filter: GithubReviewSeverityFilter = "all";

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setReports(reports: GithubMetadataScanResult[]): void {
    this.reports = reports;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getReports(): GithubMetadataScanResult[] {
    return this.reports;
  }

  public setFilter(filter: GithubReviewSeverityFilter): void {
    this.filter = filter;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getFilter(): GithubReviewSeverityFilter {
    return this.filter;
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
      const trustLabel = formatGithubTrustLabel(element.summary);
      const filteredCount = element.filteredSummary.totalFindings;
      const heading = element.filter === "all"
        ? `${trustLabel}: ${element.summary.totalFindings} review findings`
        : `${trustLabel}: ${filteredCount} ${element.filter} finding${filteredCount === 1 ? "" : "s"}`;
      const item = new vscode.TreeItem(
        element.summary.totalFindings === 0 ? "Safe: No repository review risks" : heading,
        vscode.TreeItemCollapsibleState.None
      );
      item.description = element.filter === "all"
        ? formatGithubMetadataSummary(element.summary)
        : `${formatGithubMetadataSummary(element.summary)} Showing ${element.filter} findings only.`;
      item.tooltip = `${formatGithubMetadataSummary(element.summary)}\nFilter: ${element.filter}`;
      item.contextValue = "workspaceGuardGithubReview.summary";
      item.iconPath = new vscode.ThemeIcon(
        element.summary.highFindings > 0 ? "warning" : (element.summary.mediumFindings > 0 ? "shield" : "pass")
      );
      return item;
    }

    if (element.kind === "workspace") {
      const collapsibleState = element.report.findings.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
      const item = new vscode.TreeItem(
        formatGithubMetadataWorkspaceLabel(element.fullReport),
        collapsibleState
      );
      const workspaceSummary = summarizeGithubMetadataReports([element.fullReport]);
      const trustLabel = formatGithubTrustLabel(workspaceSummary);
      item.description = `${trustLabel} · ${formatGithubMetadataWorkspaceSummary(element.report, element.filter)}`;
      item.tooltip = `${element.fullReport.rootPath}\n${trustLabel}\n${formatGithubMetadataWorkspaceSummary(element.report, element.filter)}`;
      item.contextValue = "workspaceGuardGithubReview.workspace";
      item.iconPath = new vscode.ThemeIcon(
        workspaceSummary.highFindings > 0 ? "warning" : (workspaceSummary.mediumFindings > 0 ? "repo" : "pass")
      );
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
      title: "Suggest Repository Remediation",
      arguments: [element.finding, element.rootPath]
    };
    return item;
  }

  public getChildren(element?: GithubReviewTreeNode): GithubReviewTreeNode[] {
    if (!element) {
      const scannedReports = this.reports.filter((report) => report.scannedFiles.length > 0);
      if (scannedReports.length === 0) {
        return [{ kind: "empty", label: "No reviewable repository files in the current workspace." }];
      }

      const filteredEntries = scannedReports.map((report) => ({
        fullReport: report,
        filteredReport: filterGithubMetadataReport(report, this.filter)
      }));
      const filteredVisibleEntries = filteredEntries.filter(({ fullReport, filteredReport }) => {
        if (this.filter === "all") {
          return true;
        }

        return filteredReport.findings.length > 0 || fullReport.findings.length === 0;
      });
      const filteredSummary = summarizeGithubMetadataReports(filteredEntries.map((entry) => entry.filteredReport));
      return [
        {
          kind: "summary",
          summary: summarizeGithubMetadataReports(scannedReports),
          filteredSummary,
          filter: this.filter
        },
        ...filteredVisibleEntries.map(({ filteredReport, fullReport }) => ({
          kind: "workspace",
          report: filteredReport,
          fullReport,
          filter: this.filter
        } as const))
      ];
    }

    if (element.kind === "workspace") {
      if (element.report.findings.length === 0) {
        return [{
          kind: "empty",
          label: element.filter === "all" ? "No findings" : `No ${element.filter} findings`,
          description: element.filter === "all"
            ? "This workspace repository review is clean."
            : `This workspace has no ${element.filter} findings under the current filter.`
        }];
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

function getCurrentWorkspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

async function updateStoredRecentWorkspaces(context: vscode.ExtensionContext): Promise<string[]> {
  const previousHistory = context.globalState.get<string[]>(RECENT_WORKSPACES_KEY, []);
  const nextHistory = updateRecentWorkspaceHistory(previousHistory, getCurrentWorkspacePaths());
  if (JSON.stringify(previousHistory) !== JSON.stringify(nextHistory)) {
    await context.globalState.update(RECENT_WORKSPACES_KEY, nextHistory);
  }

  return nextHistory;
}

async function maybeShowRecentWorkspaces(context: vscode.ExtensionContext): Promise<void> {
  const currentWorkspacePaths = getCurrentWorkspacePaths();
  if (currentWorkspacePaths.length === 0) {
    return;
  }

  const lastShownAt = context.globalState.get<number>(RECENT_WORKSPACES_LAST_SHOWN_AT_KEY);
  const now = Date.now();
  if (lastShownAt && now - lastShownAt < RECENT_WORKSPACES_PROMPT_COOLDOWN_MS) {
    return;
  }

  const history = await updateStoredRecentWorkspaces(context);
  const recentSuggestions = getRecentWorkspaceSuggestions(history, currentWorkspacePaths);
  if (recentSuggestions.length === 0) {
    return;
  }

  await context.globalState.update(RECENT_WORKSPACES_LAST_SHOWN_AT_KEY, now);
  const selection = await vscode.window.showQuickPick(
    recentSuggestions.map((targetPath) => ({
      label: path.basename(targetPath) || targetPath,
      description: targetPath,
      targetPath
    })),
    {
      title: "Recent Workspaces",
      placeHolder: "Open a workspace you used recently"
    }
  );

  if (!selection) {
    return;
  }

  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(selection.targetPath), false);
}

async function cleanupEphemeralWorkspaceFolders(removedWorkspacePaths: readonly string[]): Promise<void> {
  const cleanupTargets = collectEphemeralWorkspaceCleanupTargets(removedWorkspacePaths, getCurrentWorkspacePaths());
  await Promise.all(cleanupTargets.map(async (targetPath) => {
    await rm(targetPath, { recursive: true, force: true });
  }));
}

function createHost(
  outputChannel: vscode.OutputChannel,
  getSettings: () => ReturnType<typeof getHomeguardSettings>
): HomeguardExtensionHost {
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
    scanGithubMetadata: async (rootPath) => {
      const settings = resolveHomeguardSettings(getSettings());
      return await scanGithubMetadata(rootPath, {
        allowedExtensionIds: settings.githubReview.allowedExtensionIds,
        recommendedLatexExtensionIds: settings.githubReview.recommendedLatexExtensionIds
      });
    }
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

function getDefaultGithubExportUri(
  context: vscode.ExtensionContext,
  extension: string
): vscode.Uri | undefined {
  const baseUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!baseUri) {
    return undefined;
  }

  return vscode.Uri.joinPath(baseUri, `workspace-guard-github-review.${extension}`);
}

async function exportGithubReviewContent(
  context: vscode.ExtensionContext,
  content: string,
  extension: string
): Promise<vscode.Uri | undefined> {
  const targetUri = await vscode.window.showSaveDialog({
    saveLabel: "Export Workspace Guard review",
    defaultUri: getDefaultGithubExportUri(context, extension),
    filters: extension === "json"
      ? { JSON: ["json"] }
      : { Markdown: ["md"] }
  });
  if (!targetUri) {
    return undefined;
  }

  await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(content));
  return targetUri;
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

function getTreeItemLabel(item: vscode.TreeItem): string {
  if (typeof item.label === "string") {
    return item.label;
  }

  return item.label?.label ?? "";
}

function captureGithubReviewTreeNode(
  provider: GithubReviewTreeProvider,
  node: GithubReviewTreeNode
): GithubReviewTreeSnapshotNode {
  const item = provider.getTreeItem(node);
  const children = provider.getChildren(node);

  return {
    kind: node.kind,
    label: getTreeItemLabel(item),
    description: item.description,
    contextValue: item.contextValue,
    children: children.length > 0
      ? children.map((child) => captureGithubReviewTreeNode(provider, child))
      : undefined
  };
}

function captureGithubReviewTreeSnapshot(
  provider: GithubReviewTreeProvider
): GithubReviewTreeSnapshot {
  const reports = provider.getReports();
  return {
    filter: provider.getFilter(),
    summary: summarizeGithubMetadataReports(reports),
    nodes: provider.getChildren().map((node) => captureGithubReviewTreeNode(provider, node))
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Workspace Guard");
  context.subscriptions.push(outputChannel);

  const host = createHost(outputChannel, getHomeguardSettings);
  let activation = await activateHomeguardExtension(host, getHomeguardSettings());
  context.subscriptions.push({
    dispose: () => activation.dispose()
  });
  const githubReviewTreeProvider = new GithubReviewTreeProvider();
  githubReviewTreeProvider.setFilter(
    context.workspaceState.get<GithubReviewSeverityFilter>(GITHUB_REVIEW_FILTER_KEY, "all")
  );
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
      `${formatGithubMetadataSummary(activation.githubMetadataSummary)} Review this repository before granting trust or enabling extra extensions.`,
      "Open Review"
    );

    if (selection === "Open Review") {
      writeGithubMetadataReports(outputChannel, activation.githubMetadataReports);
      outputChannel.show(true);
    }
  }

  const resolvedSettings = resolveHomeguardSettings(getHomeguardSettings());
  const extensionPolicyFindings = reviewInstalledExtensions(
    host.installedExtensions,
    resolvedSettings.githubReview.allowedExtensionIds
  );
  if (extensionPolicyFindings.length > 0) {
    const firstFinding = extensionPolicyFindings[0];
    await vscode.window.showWarningMessage(
      `${firstFinding.message} Keep untrusted LaTeX workspaces in Restricted Mode until approved extensions are in place.`
    );
  }

  if (
    resolvedSettings.githubReview.warnOnTrustedWorkspace
    && vscode.workspace.isTrusted
    && (activation.githubMetadataSummary?.totalFindings ?? 0) > 0
  ) {
    await vscode.window.showWarningMessage(
      "This workspace is already trusted. For unknown repositories, keep VS Code in Restricted Mode until the repository review is clean."
    );
  }

  await updateStoredRecentWorkspaces(context);
  await maybeShowRecentWorkspaces(context);
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
    const summary = summarizeGithubMetadataReports(
      reports.filter((report) => report.scannedFiles.length > 0).map((report) => filterGithubMetadataReport(report, githubReviewTreeProvider.getFilter()))
    );
    await vscode.window.showInformationMessage(formatGithubMetadataSummary(summary));
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.setGithubReviewSeverityFilter", async () => {
    const currentFilter = githubReviewTreeProvider.getFilter();
    const selection = await vscode.window.showQuickPick(
      [
        { label: "All", detail: "Show every finding.", filter: "all" as GithubReviewSeverityFilter },
        { label: "High", detail: "Show only high-severity findings.", filter: "high" as GithubReviewSeverityFilter },
        { label: "Medium", detail: "Show only medium-severity findings.", filter: "medium" as GithubReviewSeverityFilter },
        { label: "Info", detail: "Show only informational findings.", filter: "info" as GithubReviewSeverityFilter }
      ],
      {
        title: "Workspace Guard Review Filter",
        placeHolder: `Current filter: ${currentFilter}`
      }
    );
    if (!selection) {
      return;
    }

    githubReviewTreeProvider.setFilter(selection.filter);
    await context.workspaceState.update(GITHUB_REVIEW_FILTER_KEY, selection.filter);
    await vscode.window.showInformationMessage(`Workspace Guard review filter is now ${selection.label}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.exportGithubReviewJson", async () => {
    const reports = githubReviewTreeProvider.getReports();
    const filter = githubReviewTreeProvider.getFilter();
    const content = JSON.stringify({
      filter,
      trust: formatGithubTrustLabel(summarizeGithubMetadataReports(reports)),
      reports: reports.map((report) => filterGithubMetadataReport(report, filter))
    }, null, 2);
    const targetUri = await exportGithubReviewContent(context, content, "json");
    if (targetUri) {
      await vscode.window.showInformationMessage(`Workspace Guard exported JSON review to ${targetUri.fsPath}.`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.exportGithubReviewMarkdown", async () => {
    const reports = githubReviewTreeProvider.getReports();
    const filter = githubReviewTreeProvider.getFilter();
    const filteredReports = reports.map((report) => filterGithubMetadataReport(report, filter));
    const summary = summarizeGithubMetadataReports(filteredReports);
    const content = formatGithubMetadataReportsMarkdown(filteredReports, summary, filter);
    const targetUri = await exportGithubReviewContent(context, content, "md");
    if (targetUri) {
      await vscode.window.showInformationMessage(`Workspace Guard exported Markdown review to ${targetUri.fsPath}.`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("homeguard.__captureGithubReviewTree", async () => {
    return captureGithubReviewTreeSnapshot(githubReviewTreeProvider);
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
          label: "Copy patch snippet",
          detail: "Copy the remediation example snippet when available.",
          action: "copy-snippet" as const
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

    if (selection.action === "copy-snippet") {
      const snippet = getGithubFindingRemediationSnippet(finding);
      if (!snippet) {
        await vscode.window.showWarningMessage("Workspace Guard does not have a patch snippet for this finding yet.");
        return;
      }

      await vscode.env.clipboard.writeText(snippet);
      await vscode.window.showInformationMessage("Workspace Guard copied the remediation snippet.");
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

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
    await cleanupEphemeralWorkspaceFolders(event.removed.map((folder) => folder.uri.fsPath));
    await updateStoredRecentWorkspaces(context);
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
