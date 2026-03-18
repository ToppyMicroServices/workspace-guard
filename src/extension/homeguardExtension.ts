import { homedir } from "node:os";

import {
  type HomeguardMode,
  resolveHomeguardSettings,
  type HomeguardSettings,
  type HomeguardSettingsInput
} from "../core/config";
import { ensureEscapeFolder } from "../core/escapeFolder";
import { HomeguardLogger, type OutputChannelLike } from "../core/outputChannel";
import {
  applyTelemetryHardening,
  auditTelemetrySettings,
  rollbackTelemetryHardening,
  type InstalledExtensionInfo,
  type TelemetryAuditReport
} from "../core/telemetry";
import type { GithubMetadataScanResult } from "../core/githubMetadataScanner";
import type {
  WorkspaceSafetyActionRequest,
  WorkspaceSafetyAssessment,
  WorkspaceSafetyEvaluation
} from "../core/workspaceSafety";
import type { AppliedSettingsResult, SettingsStore } from "../core/settingsBackup";
import { evaluatePathRisk, type SupportedPlatform } from "../core/pathPolicy";
import { createWorkspaceSafetyGuard, type GuardedActionResult } from "./workspaceSafetyGuard";

export interface WorkspaceFolderLike {
  uri: {
    fsPath: string;
  };
  name?: string;
}

export interface WorkspaceFoldersChangeEventLike {
  added: WorkspaceFolderLike[];
  removed?: WorkspaceFolderLike[];
}

export interface HomeguardDisposable {
  dispose: () => void;
}

export interface HomeguardExtensionHost {
  workspaceFolders: WorkspaceFolderLike[];
  homeDir?: string;
  env?: Record<string, string | undefined>;
  platform?: SupportedPlatform;
  outputChannel?: OutputChannelLike;
  settingsStore?: SettingsStore;
  installedExtensions?: InstalledExtensionInfo[];
  showWarningMessage: (message: string, ...items: string[]) => Promise<string | undefined>;
  showInformationMessage?: (message: string, ...items: string[]) => Promise<string | undefined>;
  openFolder?: (targetPath: string) => Promise<void> | void;
  removeWorkspaceFolder?: (targetPath: string) => Promise<void> | void;
  scanGithubMetadata?: (rootPath: string) => Promise<GithubMetadataScanResult>;
  onDidChangeWorkspaceFolders: (
    listener: (event: WorkspaceFoldersChangeEventLike) => void | Promise<void>
  ) => HomeguardDisposable;
  now?: () => Date;
}

export interface WorkspaceRiskDetection {
  folderPath: string;
  normalizedPath: string;
  isHomePath: boolean;
  isHighRiskPath: boolean;
}

export interface HandledWorkspaceDetection {
  folderPath: string;
  action: "warned" | "removed" | "redirected" | "logged" | "ignored";
}

export interface ActivationResult {
  startupDetections: HandledWorkspaceDetection[];
  telemetryReport?: TelemetryAuditReport;
  githubMetadataReports?: GithubMetadataScanResult[];
  githubMetadataSummary?: GithubMetadataReviewSummary;
  dispose: () => void;
}

export interface GithubMetadataReviewSummary {
  workspaceFoldersScanned: number;
  workspaceFoldersWithGithub: number;
  workspaceFoldersWithRisk: number;
  totalFindings: number;
  highFindings: number;
  mediumFindings: number;
  infoFindings: number;
}

export const HOME_WARNING_ACTIONS = {
  openEscapeFolder: "Open Escape Folder",
  removeFromWorkspace: "Remove from Workspace",
  keepOpenOnce: "Keep Open Once",
  dismiss: "Dismiss"
} as const;

export function summarizeGithubMetadataReports(
  reports: GithubMetadataScanResult[]
): GithubMetadataReviewSummary {
  const summary: GithubMetadataReviewSummary = {
    workspaceFoldersScanned: reports.length,
    workspaceFoldersWithGithub: 0,
    workspaceFoldersWithRisk: 0,
    totalFindings: 0,
    highFindings: 0,
    mediumFindings: 0,
    infoFindings: 0
  };

  for (const report of reports) {
    if (report.scannedFiles.length > 0) {
      summary.workspaceFoldersWithGithub += 1;
    }

    if (report.findings.length > 0) {
      summary.workspaceFoldersWithRisk += 1;
    }

    summary.totalFindings += report.findings.length;
    for (const finding of report.findings) {
      if (finding.severity === "high") {
        summary.highFindings += 1;
      } else if (finding.severity === "medium") {
        summary.mediumFindings += 1;
      } else {
        summary.infoFindings += 1;
      }
    }
  }

  return summary;
}

function createLogger(host: HomeguardExtensionHost, settings: HomeguardSettings): HomeguardLogger | undefined {
  if (!host.outputChannel) {
    return undefined;
  }

  return new HomeguardLogger(host.outputChannel, {
    homeDir: host.homeDir ?? homedir(),
    verbose: settings.verbose
  });
}

async function inspectWorkspaceFolder(
  folder: WorkspaceFolderLike,
  host: HomeguardExtensionHost,
  settings: HomeguardSettings
): Promise<WorkspaceRiskDetection> {
  const homeDir = host.homeDir ?? homedir();
  const risk = await evaluatePathRisk(folder.uri.fsPath, {
    cwd: homeDir,
    env: host.env,
    homeDir,
    platform: host.platform,
    allowList: settings.allowList,
    highRiskFolders: settings.highRiskFolders,
    realpath: async (candidate) => candidate
  });

  return {
    folderPath: folder.uri.fsPath,
    normalizedPath: risk.normalized.realPath,
    isHomePath: risk.isHomePath,
    isHighRiskPath: risk.isHighRiskPath
  };
}

export async function scanWorkspaceFolders(
  folders: WorkspaceFolderLike[],
  host: HomeguardExtensionHost,
  settingsInput: HomeguardSettingsInput = {}
): Promise<WorkspaceRiskDetection[]> {
  const settings = resolveHomeguardSettings(settingsInput);
  const detections = await Promise.all(
    folders.map((folder) => inspectWorkspaceFolder(folder, host, settings))
  );

  return detections.filter((detection) => detection.isHomePath || detection.isHighRiskPath);
}

async function openEscapeFolder(
  host: HomeguardExtensionHost,
  settings: HomeguardSettings
): Promise<string> {
  const escapeFolder = await ensureEscapeFolder({
    escapeFolder: settings.escapeFolder,
    enableEphemeralEscape: settings.enableEphemeralEscape,
    env: host.env,
    homeDir: host.homeDir ?? homedir(),
    platform: host.platform,
    timestamp: host.now?.().toISOString()
  });
  await host.openFolder?.(escapeFolder.path);
  return escapeFolder.path;
}

async function handleHomeDetection(
  detection: WorkspaceRiskDetection,
  host: HomeguardExtensionHost,
  settings: HomeguardSettings,
  mode: HomeguardMode,
  logger?: HomeguardLogger
): Promise<HandledWorkspaceDetection> {
  const message = "You opened your home directory. This may expose secrets and increase accidental edits. Open a subdirectory or use the Escape Folder instead.";

  logger?.log("home-detected", {
    mode,
    folderPath: detection.folderPath
  });

  if (mode === "audit-only") {
    return {
      folderPath: detection.folderPath,
      action: "logged"
    };
  }

  if (mode === "redirect") {
    await host.removeWorkspaceFolder?.(detection.folderPath);
    await openEscapeFolder(host, settings);
    await host.showInformationMessage?.("HomeGuard redirected this workspace to your Escape Folder.");
    return {
      folderPath: detection.folderPath,
      action: "redirected"
    };
  }

  if (mode === "block") {
    await host.removeWorkspaceFolder?.(detection.folderPath);
    const selection = await host.showWarningMessage(
      message,
      HOME_WARNING_ACTIONS.openEscapeFolder,
      HOME_WARNING_ACTIONS.dismiss
    );

    if (selection === HOME_WARNING_ACTIONS.openEscapeFolder) {
      await openEscapeFolder(host, settings);
      return {
        folderPath: detection.folderPath,
        action: "redirected"
      };
    }

    return {
      folderPath: detection.folderPath,
      action: "removed"
    };
  }

  const selection = await host.showWarningMessage(
    message,
    HOME_WARNING_ACTIONS.openEscapeFolder,
    HOME_WARNING_ACTIONS.removeFromWorkspace,
    HOME_WARNING_ACTIONS.keepOpenOnce,
    HOME_WARNING_ACTIONS.dismiss
  );

  if (selection === HOME_WARNING_ACTIONS.openEscapeFolder) {
    await openEscapeFolder(host, settings);
    return {
      folderPath: detection.folderPath,
      action: "redirected"
    };
  }

  if (selection === HOME_WARNING_ACTIONS.removeFromWorkspace) {
    await host.removeWorkspaceFolder?.(detection.folderPath);
    return {
      folderPath: detection.folderPath,
      action: "removed"
    };
  }

  return {
    folderPath: detection.folderPath,
    action: "warned"
  };
}

async function handleHighRiskDetection(
  detection: WorkspaceRiskDetection,
  host: HomeguardExtensionHost,
  logger?: HomeguardLogger
): Promise<HandledWorkspaceDetection> {
  logger?.log("high-risk-folder-detected", {
    folderPath: detection.folderPath
  });

  await host.showWarningMessage(
    `You opened a high-risk folder: ${detection.normalizedPath}. Review whether it should be opened in VS Code.`,
    HOME_WARNING_ACTIONS.dismiss
  );

  return {
    folderPath: detection.folderPath,
    action: "warned"
  };
}

export async function handleWorkspaceDetections(
  detections: WorkspaceRiskDetection[],
  host: HomeguardExtensionHost,
  settingsInput: HomeguardSettingsInput = {}
): Promise<HandledWorkspaceDetection[]> {
  const settings = resolveHomeguardSettings(settingsInput);
  const logger = createLogger(host, settings);
  const handled: HandledWorkspaceDetection[] = [];

  for (const detection of detections) {
    if (detection.isHomePath) {
      handled.push(await handleHomeDetection(detection, host, settings, settings.mode, logger));
      continue;
    }

    if (detection.isHighRiskPath) {
      handled.push(await handleHighRiskDetection(detection, host, logger));
    }
  }

  return handled;
}

export async function activateHomeguardExtension(
  host: HomeguardExtensionHost,
  settingsInput: HomeguardSettingsInput = {}
): Promise<ActivationResult> {
  const settings = resolveHomeguardSettings(settingsInput);
  const startupDetections = settings.enable && settings.checkOnStartup
    ? await handleWorkspaceDetections(
      await scanWorkspaceFolders(host.workspaceFolders, host, settings),
      host,
      settings
    )
    : [];

  const telemetryReport = settings.enable && settings.privacy.auditOnStartup && host.settingsStore
    ? auditTelemetrySettings(host.settingsStore.getAll(), host.installedExtensions)
    : undefined;

  const githubMetadataReports = settings.enable && settings.githubReview.checkOnStartup && host.scanGithubMetadata
    ? await Promise.all(host.workspaceFolders.map(async (folder) => await host.scanGithubMetadata?.(folder.uri.fsPath)))
    : [];
  const githubMetadataSummary = githubMetadataReports.length > 0
    ? summarizeGithubMetadataReports(githubMetadataReports.filter((report): report is GithubMetadataScanResult => Boolean(report)))
    : undefined;

  const subscription = host.onDidChangeWorkspaceFolders(async (event) => {
    if (!settings.enable || !settings.checkOnWorkspaceFolderAdd) {
      return;
    }

    const detections = await scanWorkspaceFolders(event.added, host, settings);
    await handleWorkspaceDetections(detections, host, settings);
  });

  return {
    startupDetections,
    telemetryReport,
    githubMetadataReports: githubMetadataSummary && githubMetadataSummary.workspaceFoldersWithGithub > 0
      ? githubMetadataReports.filter((report): report is GithubMetadataScanResult => Boolean(report))
      : undefined,
    githubMetadataSummary: githubMetadataSummary && (githubMetadataSummary.highFindings > 0 || githubMetadataSummary.mediumFindings > 0)
      ? githubMetadataSummary
      : undefined,
    dispose: () => subscription.dispose()
  };
}

export function createHomeguardCommandHandlers(
  host: HomeguardExtensionHost,
  settingsInput: HomeguardSettingsInput = {}
): {
  openEscapeFolder: () => Promise<string>;
  removeHomeFoldersFromWorkspace: () => Promise<number>;
  auditTelemetry: () => TelemetryAuditReport;
  applyPrivacyHardening: (backupDir: string) => Promise<TelemetryAuditReport & AppliedSettingsResult>;
  rollbackPrivacyHardening: (backupPath: string) => Promise<void>;
  assessWorkspaceSafety: () => Promise<WorkspaceSafetyAssessment>;
  reviewGithubMetadata: () => Promise<GithubMetadataScanResult[]>;
  reviewWorkspaceSafetyAction: (request: WorkspaceSafetyActionRequest) => Promise<WorkspaceSafetyEvaluation>;
  runGuardedWorkspaceAction: <T>(request: WorkspaceSafetyActionRequest, execute: () => Promise<T> | T) => Promise<GuardedActionResult<T>>;
} {
  const settings = resolveHomeguardSettings(settingsInput);
  const safetyGuard = createWorkspaceSafetyGuard(host, settings);

  return {
    openEscapeFolder: async () => openEscapeFolder(host, settings),
    removeHomeFoldersFromWorkspace: async () => {
      const detections = await scanWorkspaceFolders(host.workspaceFolders, host, settings);
      const homeDetections = detections.filter((entry) => entry.isHomePath);
      await Promise.all(homeDetections.map((entry) => host.removeWorkspaceFolder?.(entry.folderPath)));
      return homeDetections.length;
    },
    auditTelemetry: () => auditTelemetrySettings(
      host.settingsStore?.getAll() ?? {},
      host.installedExtensions
    ),
    applyPrivacyHardening: async (backupDir) => {
      if (!host.settingsStore) {
        throw new Error("settingsStore is required to apply privacy hardening.");
      }

      return await applyTelemetryHardening(host.settingsStore, {
        backupDir,
        backupBeforeApply: settings.privacy.backupBeforeApply,
        installedExtensions: host.installedExtensions,
        timestamp: host.now?.().toISOString()
      });
    },
    rollbackPrivacyHardening: async (backupPath) => {
      if (!host.settingsStore) {
        throw new Error("settingsStore is required to roll back privacy hardening.");
      }

      await rollbackTelemetryHardening(backupPath, host.settingsStore);
    },
    assessWorkspaceSafety: async () => await safetyGuard.assessWorkspace(),
    reviewGithubMetadata: async () => {
      if (!host.scanGithubMetadata) {
        return [];
      }

      return (await Promise.all(
        host.workspaceFolders.map(async (folder) => await host.scanGithubMetadata?.(folder.uri.fsPath))
      )).filter((report): report is GithubMetadataScanResult => Boolean(report));
    },
    reviewWorkspaceSafetyAction: async (request) => await safetyGuard.evaluateAction(request),
    runGuardedWorkspaceAction: async <T>(request: WorkspaceSafetyActionRequest, execute: () => Promise<T> | T) => {
      return await safetyGuard.runGuardedAction(request, execute);
    }
  };
}
