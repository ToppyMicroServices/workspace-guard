import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { HomeguardSettings, HomeguardSettingsInput } from "./config";
import { resolveHomeguardSettings } from "./config";
import { evaluatePathRisk, type SupportedPlatform } from "./pathPolicy";

export type WorkspaceSafetyActionType =
  | "open"
  | "save"
  | "delete"
  | "git"
  | "terminal"
  | "task"
  | "publish"
  | "debug";

export type WorkspaceSafetyEnforcement = "allow" | "warn" | "confirm" | "block";
export type WorkspaceSafetySeverity = "low" | "medium" | "high" | "critical";
export type WorkspaceSafetyClassification = "safe" | "elevated" | "dangerous";
export type WorkspaceSafetyScanTruncationReason = "max-depth" | "max-directories" | "max-files";

export interface WorkspaceFolderDescriptor {
  path: string;
}

export interface WorkspaceSafetyDirentLike {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink?: () => boolean;
}

export interface WorkspaceSafetyFs {
  readdir: (
    targetPath: string,
    options: { withFileTypes: true }
  ) => Promise<WorkspaceSafetyDirentLike[]>;
}

export interface WorkspaceSafetyContext {
  workspaceFolders: WorkspaceFolderDescriptor[];
  homeDir?: string;
  env?: Record<string, string | undefined>;
  platform?: SupportedPlatform;
  fs?: WorkspaceSafetyFs;
  realpath?: (candidate: string) => Promise<string>;
}

export interface WorkspaceSafetyEnvFileScan {
  directoriesVisited: number;
  truncated: boolean;
  truncationReasons: WorkspaceSafetyScanTruncationReason[];
}

export interface WorkspaceSafetyAssessment {
  classification: WorkspaceSafetyClassification;
  riskScore: number;
  hasHomeFolder: boolean;
  homeFolders: string[];
  highRiskFolders: string[];
  secretBearingFiles: string[];
  envTemplateFiles: string[];
  envFileScan: WorkspaceSafetyEnvFileScan;
  workspaceFolders: string[];
}

export interface WorkspaceSafetyActionRequest {
  actionType: WorkspaceSafetyActionType;
  label?: string;
  targets?: string[];
  command?: string;
  gitOperation?: "add" | "add-all" | "commit" | "push" | "publish" | "init";
  taskDefinition?: {
    name?: string;
    command?: string;
  };
  publishTarget?: string;
}

export interface WorkspaceSafetyEvaluation {
  actionType: WorkspaceSafetyActionType;
  enforcement: WorkspaceSafetyEnforcement;
  severity: WorkspaceSafetySeverity;
  reason: string;
  message: string;
  assessment: WorkspaceSafetyAssessment;
}

const DESTRUCTIVE_COMMAND_PATTERN = /(^|\s)(rm\s+-rf|rm\s+-fr|git\s+clean\s+-fd|git\s+reset\s+--hard|find\s+.+-delete|chmod\s+-R|chown\s+-R|mkfs|dd\s+if=|terraform\s+destroy|aws\s+s3\s+rm|gcloud\s+storage\s+rm|kubectl\s+delete)(\s|$)/i;
const PUBLISH_COMMAND_PATTERN = /(^|\s)(npm\s+publish|vsce\s+publish|ovsx\s+publish|twine\s+upload|cargo\s+publish|gh\s+release\s+create)(\s|$)/i;
const BROAD_GIT_OPERATION_PATTERN = /(^|\s)(git\s+add\s+-A|git\s+add\s+--all|git\s+commit\b|git\s+push\b)(\s|$)/i;
const ENV_STYLE_FILE_PATTERN = /^\.env(?:\..+)?$/i;
const ENV_TEMPLATE_MARKERS = new Set(["default", "defaults", "dist", "example", "sample", "template"]);
const SECRET_BEARING_SCAN_MAX_DEPTH = 4;
const SECRET_BEARING_SCAN_MAX_DIRECTORIES = 200;
const SECRET_BEARING_SCAN_MAX_FILES = 50;
const SECRET_BEARING_SCAN_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".beads",
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  ".nuxt",
  ".venv",
  "vendor"
]);

const defaultFs: WorkspaceSafetyFs = {
  readdir: fs.readdir
};

interface EnvFileScanResult {
  secretBearingFiles: string[];
  envTemplateFiles: string[];
  envFileScan: WorkspaceSafetyEnvFileScan;
}

function mapSeverity(riskScore: number): WorkspaceSafetySeverity {
  if (riskScore >= 90) {
    return "critical";
  }

  if (riskScore >= 60) {
    return "high";
  }

  if (riskScore >= 30) {
    return "medium";
  }

  return "low";
}

function mapClassification(riskScore: number): WorkspaceSafetyClassification {
  if (riskScore >= 60) {
    return "dangerous";
  }

  if (riskScore >= 20) {
    return "elevated";
  }

  return "safe";
}

function isGuardEnabled(actionType: WorkspaceSafetyActionType, settings: HomeguardSettings): boolean {
  switch (actionType) {
    case "save":
      return settings.safety.enableSaveGuard;
    case "delete":
      return settings.safety.enableDeleteGuard;
    case "git":
      return settings.safety.enableGitGuard;
    case "terminal":
    case "debug":
      return settings.safety.enableTerminalGuard;
    case "task":
      return settings.safety.enableTaskGuard;
    case "publish":
      return settings.safety.enablePublishGuard;
    case "open":
      return true;
  }
}

function createEvaluation(
  request: WorkspaceSafetyActionRequest,
  assessment: WorkspaceSafetyAssessment,
  enforcement: WorkspaceSafetyEnforcement,
  reason: string
): WorkspaceSafetyEvaluation {
  return {
    actionType: request.actionType,
    enforcement,
    severity: mapSeverity(assessment.riskScore),
    reason,
    message: `${request.label ?? request.actionType} is being attempted in a ${assessment.classification} workspace. ${reason}`,
    assessment
  };
}

export function isSecretBearingEnvFileName(fileName: string): boolean {
  return isEnvStyleFileName(fileName) && !isEnvTemplateFileName(fileName);
}

export function isEnvStyleFileName(fileName: string): boolean {
  return ENV_STYLE_FILE_PATTERN.test(fileName);
}

export function isEnvTemplateFileName(fileName: string): boolean {
  if (!isEnvStyleFileName(fileName)) {
    return false;
  }

  return fileName
    .toLowerCase()
    .split(".")
    .filter(Boolean)
    .slice(1)
    .some((segment) => ENV_TEMPLATE_MARKERS.has(segment));
}

async function scanEnvFiles(
  rootPath: string,
  fsImpl: WorkspaceSafetyFs
): Promise<EnvFileScanResult> {
  const secretBearingFiles: string[] = [];
  const envTemplateFiles: string[] = [];
  const truncationReasons = new Set<WorkspaceSafetyScanTruncationReason>();
  let visitedDirectories = 0;

  function hasReachedFileLimit(): boolean {
    return secretBearingFiles.length + envTemplateFiles.length >= SECRET_BEARING_SCAN_MAX_FILES;
  }

  function shouldStopScanning(): boolean {
    return truncationReasons.has("max-directories") || truncationReasons.has("max-files");
  }

  async function visit(directoryPath: string, depth: number): Promise<void> {
    if (hasReachedFileLimit()) {
      truncationReasons.add("max-files");
      return;
    }

    if (visitedDirectories >= SECRET_BEARING_SCAN_MAX_DIRECTORIES) {
      truncationReasons.add("max-directories");
      return;
    }

    if (depth > SECRET_BEARING_SCAN_MAX_DEPTH) {
      truncationReasons.add("max-depth");
      return;
    }

    visitedDirectories += 1;

    let entries: WorkspaceSafetyDirentLike[];
    try {
      entries = await fsImpl.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (shouldStopScanning()) {
        return;
      }

      if (entry.isFile() && isEnvStyleFileName(entry.name)) {
        const filePath = path.join(directoryPath, entry.name);
        if (isEnvTemplateFileName(entry.name)) {
          envTemplateFiles.push(filePath);
        } else {
          secretBearingFiles.push(filePath);
        }

        if (hasReachedFileLimit()) {
          truncationReasons.add("max-files");
        }
        continue;
      }

      if (
        entry.isDirectory()
        && !entry.isSymbolicLink?.()
        && !SECRET_BEARING_SCAN_IGNORED_DIRS.has(entry.name)
      ) {
        await visit(path.join(directoryPath, entry.name), depth + 1);
      }
    }
  }

  await visit(rootPath, 0);
  return {
    secretBearingFiles,
    envTemplateFiles,
    envFileScan: {
      directoriesVisited: visitedDirectories,
      truncated: truncationReasons.size > 0,
      truncationReasons: [...truncationReasons]
    }
  };
}

export async function assessWorkspaceSafety(
  context: WorkspaceSafetyContext,
  settingsInput: HomeguardSettingsInput = {}
): Promise<WorkspaceSafetyAssessment> {
  const settings = resolveHomeguardSettings(settingsInput);
  const homeDir = context.homeDir ?? homedir();
  const fsImpl = context.fs ?? defaultFs;
  const results = await Promise.all(
    context.workspaceFolders.map(async (folder) => {
      const [risk, envFiles] = await Promise.all([
        evaluatePathRisk(folder.path, {
          cwd: homeDir,
          env: context.env,
          homeDir,
          platform: context.platform,
          allowList: settings.allowList,
          highRiskFolders: settings.highRiskFolders,
          realpath: context.realpath
        }),
        scanEnvFiles(folder.path, fsImpl)
      ]);

      return {
        path: folder.path,
        isHomePath: risk.isHomePath,
        isHighRiskPath: risk.isHighRiskPath,
        envFiles
      };
    })
  );

  const homeFolders = results.filter((entry) => entry.isHomePath).map((entry) => entry.path);
  const highRiskFolders = results.filter((entry) => entry.isHighRiskPath).map((entry) => entry.path);
  const secretBearingFiles = results.flatMap((entry) => entry.envFiles.secretBearingFiles);
  const envTemplateFiles = results.flatMap((entry) => entry.envFiles.envTemplateFiles);
  const truncationReasons = new Set(results.flatMap((entry) => entry.envFiles.envFileScan.truncationReasons));
  const envFileScan = {
    directoriesVisited: results.reduce((total, entry) => total + entry.envFiles.envFileScan.directoriesVisited, 0),
    truncated: truncationReasons.size > 0,
    truncationReasons: [...truncationReasons]
  };
  const secretBearingFileRisk = secretBearingFiles.length > 0 ? 35 : 0;
  const truncatedScanRisk = envFileScan.truncated ? 20 : 0;
  const riskScore = Math.min(100, (homeFolders.length * 80) + (highRiskFolders.length * 25) + secretBearingFileRisk + truncatedScanRisk);

  return {
    classification: mapClassification(riskScore),
    riskScore,
    hasHomeFolder: homeFolders.length > 0,
    homeFolders,
    highRiskFolders,
    secretBearingFiles,
    envTemplateFiles,
    envFileScan,
    workspaceFolders: results.map((entry) => entry.path)
  };
}

function requestLooksDestructive(request: WorkspaceSafetyActionRequest): boolean {
  const command = request.command ?? request.taskDefinition?.command ?? "";
  if (DESTRUCTIVE_COMMAND_PATTERN.test(command)) {
    return true;
  }

  if (request.actionType === "delete") {
    return true;
  }

  return request.gitOperation === "add-all"
    || request.gitOperation === "push"
    || request.gitOperation === "publish"
    || BROAD_GIT_OPERATION_PATTERN.test(command)
    || PUBLISH_COMMAND_PATTERN.test(command);
}

export function evaluateWorkspaceAction(
  request: WorkspaceSafetyActionRequest,
  assessment: WorkspaceSafetyAssessment,
  settingsInput: HomeguardSettingsInput = {}
): WorkspaceSafetyEvaluation {
  const settings = resolveHomeguardSettings(settingsInput);

  if (!isGuardEnabled(request.actionType, settings)) {
    return createEvaluation(request, assessment, "allow", "Guard is disabled for this action type.");
  }

  if (assessment.classification === "safe") {
    return createEvaluation(request, assessment, "allow", "Workspace is classified as safe.");
  }

  const destructive = requestLooksDestructive(request);
  const requiresConfirmation = settings.safety.requireConfirmationForDestructiveActions && destructive;
  const hasSecretBearingFiles = assessment.secretBearingFiles.length > 0;

  if (assessment.envFileScan.truncated) {
    if (request.actionType === "publish" && settings.safety.blockHighRiskPublish) {
      return createEvaluation(request, assessment, "block", "Publishing is blocked because the .env-style file scan was truncated.");
    }

    if (request.actionType === "git") {
      return createEvaluation(
        request,
        assessment,
        requiresConfirmation ? "confirm" : "warn",
        "Review this Git action carefully because the .env-style file scan was truncated."
      );
    }
  }

  if (hasSecretBearingFiles) {
    if (request.actionType === "publish" && settings.safety.blockHighRiskPublish) {
      return createEvaluation(request, assessment, "block", "Publishing is blocked because .env-style secret-bearing files are present.");
    }

    if (request.actionType === "git") {
      return createEvaluation(
        request,
        assessment,
        requiresConfirmation ? "confirm" : "warn",
        destructive
          ? "Git operations may stage .env-style secret-bearing files."
          : "Review this Git action carefully because .env-style secret-bearing files are present."
      );
    }
  }

  if (request.actionType === "publish" && settings.safety.blockHighRiskPublish) {
    return createEvaluation(request, assessment, "block", "Publishing is blocked in elevated or dangerous workspaces.");
  }

  if (assessment.hasHomeFolder) {
    switch (request.actionType) {
      case "delete":
      case "publish":
        return createEvaluation(request, assessment, "block", "This action targets a workspace that includes your home directory.");
      case "git":
        return createEvaluation(
          request,
          assessment,
          requiresConfirmation ? "confirm" : "warn",
          destructive
            ? "Git operations in a home workspace can accidentally stage or publish unrelated files."
            : "Review this Git action carefully because the workspace includes your home directory."
        );
      case "terminal":
      case "task":
      case "debug":
        return createEvaluation(
          request,
          assessment,
          requiresConfirmation ? "confirm" : "warn",
          destructive
            ? "This command looks destructive and the workspace includes your home directory."
            : "Commands executed from a home workspace deserve confirmation."
        );
      case "save":
        return createEvaluation(
          request,
          assessment,
          settings.safety.requireConfirmationForDestructiveActions ? "confirm" : "warn",
          "Save-time actions can touch many files when the workspace includes your home directory."
        );
      case "open":
        return createEvaluation(request, assessment, "confirm", "Opening this workspace already triggered elevated risk detection.");
    }
  }

  if (assessment.highRiskFolders.length > 0) {
    switch (request.actionType) {
      case "delete":
        return createEvaluation(request, assessment, "confirm", "Deletion affects a workspace that contains high-risk folders.");
      case "publish":
        return createEvaluation(request, assessment, "block", "Publishing is blocked because the workspace contains high-risk folders.");
      case "git":
      case "terminal":
      case "task":
      case "debug":
        return createEvaluation(
          request,
          assessment,
          requiresConfirmation ? "confirm" : "warn",
          destructive
            ? "This action looks destructive and the workspace contains high-risk folders."
            : "High-risk folders are present in this workspace."
        );
      case "save":
        return createEvaluation(request, assessment, "warn", "Save-time automation may affect high-risk folders.");
      case "open":
        return createEvaluation(request, assessment, "warn", "This workspace contains high-risk folders.");
    }
  }

  return createEvaluation(request, assessment, requiresConfirmation ? "confirm" : "warn", "Workspace risk is elevated.");
}

export const WORKSPACE_SAFETY_COMMANDS = [
  "Workspace Safety: Review Save Action",
  "Workspace Safety: Review Delete Action",
  "Workspace Safety: Review Git Operation",
  "Workspace Safety: Review Terminal Command",
  "Workspace Safety: Review Task Execution",
  "Workspace Safety: Review Publish Operation",
  "Workspace Safety: Review Debug Launch"
] as const;
