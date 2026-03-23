import path from "node:path";

import {
  formatRepositorySafetyScanResult,
  getRepositorySafetyExitCode,
  scanRepositorySafety,
  type RepositorySafetyFailOn,
  type RepositorySafetyScanResult
} from "../core/repositorySafetyScanner";
import type { WorkspaceConfigScanProfile } from "../core/workspaceConfigScanner";

export interface RepositoryScanCliOptions {
  targetPath: string;
  format: "text" | "json";
  profile: WorkspaceConfigScanProfile;
  failOn: RepositorySafetyFailOn;
  resolveExternalWorkflows: boolean;
}

function parseOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }

  return value;
}

export function parseRepositoryScanCliArgs(argv: string[]): RepositoryScanCliOptions {
  let format: RepositoryScanCliOptions["format"] = "text";
  let profile: WorkspaceConfigScanProfile = "default";
  let failOn: RepositorySafetyFailOn = "medium";
  let resolveExternalWorkflows = false;
  let targetPath = ".";

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--resolve-external-workflows") {
      resolveExternalWorkflows = true;
      continue;
    }

    if (token === "--format") {
      const value = parseOptionValue(argv, index, token);
      if (value !== "text" && value !== "json") {
        throw new Error(`Unsupported --format value: ${value}`);
      }

      format = value;
      index += 1;
      continue;
    }

    if (token === "--profile") {
      const value = parseOptionValue(argv, index, token);
      if (value !== "default" && value !== "restricted") {
        throw new Error(`Unsupported --profile value: ${value}`);
      }

      profile = value;
      index += 1;
      continue;
    }

    if (token === "--fail-on") {
      const value = parseOptionValue(argv, index, token);
      if (value !== "none" && value !== "high" && value !== "medium" && value !== "info") {
        throw new Error(`Unsupported --fail-on value: ${value}`);
      }

      failOn = value;
      index += 1;
      continue;
    }

    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }

    targetPath = token;
  }

  return {
    targetPath: path.resolve(targetPath),
    format,
    profile,
    failOn,
    resolveExternalWorkflows
  };
}

export function formatRepositoryScanCliOutput(
  result: RepositorySafetyScanResult,
  format: RepositoryScanCliOptions["format"]
): string {
  return format === "json"
    ? JSON.stringify(result, null, 2)
    : formatRepositorySafetyScanResult(result);
}

export async function runRepositoryScanCli(
  argv: string[],
  io: {
    stdout?: Pick<NodeJS.WriteStream, "write">;
  } = {}
): Promise<number> {
  const options = parseRepositoryScanCliArgs(argv);
  const result = await scanRepositorySafety(options.targetPath, {
    profile: options.profile,
    resolveExternalWorkflows: options.resolveExternalWorkflows
  });
  (io.stdout ?? process.stdout).write(`${formatRepositoryScanCliOutput(result, options.format)}\n`);
  return getRepositorySafetyExitCode(result, options.failOn);
}