import { homedir } from "node:os";

import type { HomeguardSettingsInput } from "../core/config";
import { resolveHomeguardSettings } from "../core/config";
import { ensureEscapeFolder } from "../core/escapeFolder";
import { HomeguardLogger } from "../core/outputChannel";
import {
  assessWorkspaceSafety,
  evaluateWorkspaceAction,
  type WorkspaceSafetyActionRequest,
  type WorkspaceSafetyAssessment,
  type WorkspaceSafetyEnforcement,
  type WorkspaceSafetyEvaluation
} from "../core/workspaceSafety";
import type { HomeguardExtensionHost } from "./homeguardExtension";

export const WORKSPACE_SAFETY_ACTIONS = {
  proceedOnce: "Proceed Once",
  cancel: "Cancel",
  openEscapeFolder: "Open Escape Folder",
  removeHomeFolders: "Remove Home Folder"
} as const;

export interface GuardedActionResult<T = void> {
  allowed: boolean;
  disposition: "allowed" | "warned" | "confirmed" | "blocked" | "cancelled";
  evaluation: WorkspaceSafetyEvaluation;
  result?: T;
}

function createLogger(host: HomeguardExtensionHost, settingsInput: HomeguardSettingsInput): HomeguardLogger | undefined {
  if (!host.outputChannel) {
    return undefined;
  }

  const settings = resolveHomeguardSettings(settingsInput);
  return new HomeguardLogger(host.outputChannel, {
    homeDir: host.homeDir ?? homedir(),
    verbose: settings.verbose
  });
}

async function getAssessment(
  host: HomeguardExtensionHost,
  settingsInput: HomeguardSettingsInput
): Promise<WorkspaceSafetyAssessment> {
  return await assessWorkspaceSafety({
    workspaceFolders: host.workspaceFolders.map((folder) => ({ path: folder.uri.fsPath })),
    homeDir: host.homeDir,
    env: host.env,
    platform: host.platform,
    realpath: async (candidate) => candidate
  }, settingsInput);
}

function getPromptItems(enforcement: WorkspaceSafetyEnforcement, assessment: WorkspaceSafetyAssessment): string[] {
  if (enforcement === "warn") {
    return [WORKSPACE_SAFETY_ACTIONS.proceedOnce, WORKSPACE_SAFETY_ACTIONS.cancel];
  }

  if (enforcement === "confirm") {
    if (assessment.hasHomeFolder) {
      return [
        WORKSPACE_SAFETY_ACTIONS.proceedOnce,
        WORKSPACE_SAFETY_ACTIONS.openEscapeFolder,
        WORKSPACE_SAFETY_ACTIONS.removeHomeFolders,
        WORKSPACE_SAFETY_ACTIONS.cancel
      ];
    }

    return [WORKSPACE_SAFETY_ACTIONS.proceedOnce, WORKSPACE_SAFETY_ACTIONS.cancel];
  }

  if (assessment.hasHomeFolder) {
    return [
      WORKSPACE_SAFETY_ACTIONS.openEscapeFolder,
      WORKSPACE_SAFETY_ACTIONS.removeHomeFolders,
      WORKSPACE_SAFETY_ACTIONS.cancel
    ];
  }

  return [WORKSPACE_SAFETY_ACTIONS.cancel];
}

async function remediateHomeWorkspace(host: HomeguardExtensionHost, settingsInput: HomeguardSettingsInput): Promise<void> {
  const settings = resolveHomeguardSettings(settingsInput);
  const homeDir = host.homeDir ?? homedir();

  for (const folder of host.workspaceFolders) {
    if (folder.uri.fsPath === homeDir) {
      await host.removeWorkspaceFolder?.(folder.uri.fsPath);
    }
  }

  const escapeFolder = await ensureEscapeFolder({
    escapeFolder: settings.escapeFolder,
    enableEphemeralEscape: settings.enableEphemeralEscape,
    env: host.env,
    homeDir,
    platform: host.platform,
    timestamp: host.now?.().toISOString()
  });

  await host.openFolder?.(escapeFolder.path);
}

export function createWorkspaceSafetyGuard(
  host: HomeguardExtensionHost,
  settingsInput: HomeguardSettingsInput = {}
): {
  assessWorkspace: () => Promise<WorkspaceSafetyAssessment>;
  evaluateAction: (request: WorkspaceSafetyActionRequest) => Promise<WorkspaceSafetyEvaluation>;
  runGuardedAction: <T>(request: WorkspaceSafetyActionRequest, execute: () => Promise<T> | T) => Promise<GuardedActionResult<T>>;
} {
  const logger = createLogger(host, settingsInput);

  return {
    assessWorkspace: async () => await getAssessment(host, settingsInput),
    evaluateAction: async (request) => {
      const evaluation = evaluateWorkspaceAction(request, await getAssessment(host, settingsInput), settingsInput);
      logger?.log("workspace-safety-evaluate", {
        actionType: request.actionType,
        enforcement: evaluation.enforcement,
        severity: evaluation.severity,
        reason: evaluation.reason
      });
      return evaluation;
    },
    runGuardedAction: async <T>(request: WorkspaceSafetyActionRequest, execute: () => Promise<T> | T) => {
      const assessment = await getAssessment(host, settingsInput);
      const evaluation = evaluateWorkspaceAction(request, assessment, settingsInput);

      logger?.log("workspace-safety-guard", {
        actionType: request.actionType,
        enforcement: evaluation.enforcement,
        severity: evaluation.severity,
        workspaceClassification: assessment.classification
      });

      if (evaluation.enforcement === "allow") {
        return {
          allowed: true,
          disposition: "allowed",
          evaluation,
          result: await execute()
        };
      }

      const items = getPromptItems(evaluation.enforcement, assessment);
      const selection = await host.showWarningMessage(evaluation.message, ...items);

      if (selection === WORKSPACE_SAFETY_ACTIONS.openEscapeFolder) {
        await remediateHomeWorkspace(host, settingsInput);
        return {
          allowed: false,
          disposition: evaluation.enforcement === "block" ? "blocked" : "cancelled",
          evaluation
        };
      }

      if (selection === WORKSPACE_SAFETY_ACTIONS.removeHomeFolders) {
        const homeDir = host.homeDir ?? homedir();
        for (const folder of host.workspaceFolders) {
          if (folder.uri.fsPath === homeDir) {
            await host.removeWorkspaceFolder?.(folder.uri.fsPath);
          }
        }

        return {
          allowed: false,
          disposition: evaluation.enforcement === "block" ? "blocked" : "cancelled",
          evaluation
        };
      }

      if (evaluation.enforcement === "block") {
        return {
          allowed: false,
          disposition: "blocked",
          evaluation
        };
      }

      if (selection !== WORKSPACE_SAFETY_ACTIONS.proceedOnce) {
        return {
          allowed: false,
          disposition: "cancelled",
          evaluation
        };
      }

      return {
        allowed: true,
        disposition: evaluation.enforcement === "confirm" ? "confirmed" : "warned",
        evaluation,
        result: await execute()
      };
    }
  };
}