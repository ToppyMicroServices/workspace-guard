import path from "node:path";

import {
  formatRepositorySafetyScanResult,
  getRepositorySafetyExitCode,
  scanRepositorySafety,
  type RepositorySafetyFailOn,
  type RepositorySafetyScanResult
} from "../core/repositorySafetyScanner";
import { formatRepositorySafetySarif } from "../core/repositorySafetySarif";
import { getEffectiveRepositoryPolicyFailOn, getEffectiveRepositoryPolicyProfile, loadRepositoryPolicy } from "../core/repositoryPolicy";
import type { WorkspaceConfigScanProfile } from "../core/workspaceConfigScanner";

export interface RepositoryScanCliOptions {
  targetPath: string;
  format: "text" | "json" | "sarif";
  profile: WorkspaceConfigScanProfile;
  failOn: RepositorySafetyFailOn;
  resolveExternalWorkflows: boolean;
  policyPath?: string;
  explicitProfile: boolean;
  explicitFailOn: boolean;
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
  let policyPath: string | undefined;
  let explicitProfile = false;
  let explicitFailOn = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--resolve-external-workflows") {
      resolveExternalWorkflows = true;
      continue;
    }

    if (token === "--format") {
      const value = parseOptionValue(argv, index, token);
      if (value !== "text" && value !== "json" && value !== "sarif") {
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
      explicitProfile = true;
      index += 1;
      continue;
    }

    if (token === "--fail-on") {
      const value = parseOptionValue(argv, index, token);
      if (value !== "none" && value !== "high" && value !== "medium" && value !== "info") {
        throw new Error(`Unsupported --fail-on value: ${value}`);
      }

      failOn = value;
      explicitFailOn = true;
      index += 1;
      continue;
    }

    if (token === "--policy") {
      policyPath = path.resolve(parseOptionValue(argv, index, token));
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
    resolveExternalWorkflows,
    policyPath,
    explicitProfile,
    explicitFailOn
  };
}

export function formatRepositoryScanCliOutput(
  result: RepositorySafetyScanResult,
  format: RepositoryScanCliOptions["format"]
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  if (format === "sarif") {
    return formatRepositorySafetySarif(result);
  }

  return formatRepositorySafetyScanResult(result);
}

export async function runRepositoryScanCli(
  argv: string[],
  io: {
    stdout?: Pick<NodeJS.WriteStream, "write">;
  } = {}
): Promise<number> {
  const options = parseRepositoryScanCliArgs(argv);
  const loadedPolicy = await loadRepositoryPolicy(options.targetPath, {
    explicitPath: options.policyPath
  });
  const effectiveProfile = options.explicitProfile
    ? options.profile
    : getEffectiveRepositoryPolicyProfile(loadedPolicy.policy, options.profile);
  const effectiveFailOn = options.explicitFailOn
    ? options.failOn
    : getEffectiveRepositoryPolicyFailOn(loadedPolicy.policy, options.failOn);
  const result = await scanRepositorySafety(options.targetPath, {
    profile: effectiveProfile,
    resolveExternalWorkflows: options.resolveExternalWorkflows,
    policy: loadedPolicy.policy,
    policyPath: options.policyPath
  });
  (io.stdout ?? process.stdout).write(`${formatRepositoryScanCliOutput(result, options.format)}\n`);
  return getRepositorySafetyExitCode(result, effectiveFailOn);
}