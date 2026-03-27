import path from "node:path";

import { isEphemeralEscapeFolderPath } from "../core/escapeFolder";

export const DEFAULT_RECENT_WORKSPACE_LIMIT = 8;
export const DEFAULT_RECENT_WORKSPACE_SUGGESTION_LIMIT = 5;

function normalizeWorkspacePath(targetPath: string): string {
  return path.normalize(targetPath);
}

export function updateRecentWorkspaceHistory(
  previousHistory: readonly string[],
  currentWorkspacePaths: readonly string[],
  limit = DEFAULT_RECENT_WORKSPACE_LIMIT
): string[] {
  const nextHistory: string[] = [];
  const seen = new Set<string>();

  for (const targetPath of currentWorkspacePaths) {
    const normalized = normalizeWorkspacePath(targetPath);
    if (isEphemeralEscapeFolderPath(normalized) || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    nextHistory.push(normalized);
  }

  for (const targetPath of previousHistory) {
    const normalized = normalizeWorkspacePath(targetPath);
    if (isEphemeralEscapeFolderPath(normalized) || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    nextHistory.push(normalized);
  }

  return nextHistory.slice(0, limit);
}

export function getRecentWorkspaceSuggestions(
  history: readonly string[],
  currentWorkspacePaths: readonly string[],
  limit = DEFAULT_RECENT_WORKSPACE_SUGGESTION_LIMIT
): string[] {
  const current = new Set(currentWorkspacePaths.map((targetPath) => normalizeWorkspacePath(targetPath)));

  return history
    .map((targetPath) => normalizeWorkspacePath(targetPath))
    .filter((targetPath) => !current.has(targetPath))
    .slice(0, limit);
}

export function collectEphemeralWorkspaceCleanupTargets(
  removedWorkspacePaths: readonly string[],
  currentWorkspacePaths: readonly string[]
): string[] {
  const hasNonEphemeralWorkspace = currentWorkspacePaths.some((targetPath) => !isEphemeralEscapeFolderPath(targetPath));
  if (!hasNonEphemeralWorkspace) {
    return [];
  }

  const cleanupTargets: string[] = [];
  const seen = new Set<string>();

  for (const targetPath of removedWorkspacePaths) {
    const normalized = normalizeWorkspacePath(targetPath);
    if (!isEphemeralEscapeFolderPath(normalized) || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    cleanupTargets.push(normalized);
  }

  return cleanupTargets;
}
