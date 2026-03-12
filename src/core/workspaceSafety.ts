import { homedir } from "node:os";

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

export interface WorkspaceFolderDescriptor {
  path: string;
}

export interface WorkspaceSafetyContext {
  workspaceFolders: WorkspaceFolderDescriptor[];
  homeDir?: string;
  env?: Record<string, string | undefined>;
  platform?: SupportedPlatform;
  realpath?: (candidate: string) => Promise<string>;
}

export interface WorkspaceSafetyAssessment {
  classification: WorkspaceSafetyClassification;
  riskScore: number;
  hasHomeFolder: boolean;
  homeFolders: string[];
  highRiskFolders: string[];
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

export async function assessWorkspaceSafety(
  context: WorkspaceSafetyContext,
  settingsInput: HomeguardSettingsInput = {}
): Promise<WorkspaceSafetyAssessment> {
  const settings = resolveHomeguardSettings(settingsInput);
  const homeDir = context.homeDir ?? homedir();
  const results = await Promise.all(
    context.workspaceFolders.map(async (folder) => {
      const risk = await evaluatePathRisk(folder.path, {
        cwd: homeDir,
        env: context.env,
        homeDir,
        platform: context.platform,
        allowList: settings.allowList,
        highRiskFolders: settings.highRiskFolders,
        realpath: context.realpath
      });

      return {
        path: folder.path,
        isHomePath: risk.isHomePath,
        isHighRiskPath: risk.isHighRiskPath
      };
    })
  );

  const homeFolders = results.filter((entry) => entry.isHomePath).map((entry) => entry.path);
  const highRiskFolders = results.filter((entry) => entry.isHighRiskPath).map((entry) => entry.path);
  const riskScore = Math.min(100, (homeFolders.length * 80) + (highRiskFolders.length * 25));

  return {
    classification: mapClassification(riskScore),
    riskScore,
    hasHomeFolder: homeFolders.length > 0,
    homeFolders,
    highRiskFolders,
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