import { homedir } from "node:os";
import { spawn } from "node:child_process";

import { evaluatePathRisk, expandPathInput, type SupportedPlatform } from "../core/pathPolicy";

export type HomeguardMode = "warn" | "redirect" | "block" | "audit-only";

export interface HomeguardCliOptions {
  mode: HomeguardMode;
  escapeFolder?: string;
  allowList?: string[];
  highRiskFolders?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  platform?: SupportedPlatform;
  codeCommand?: string;
  realpath?: (candidate: string) => Promise<string>;
}

export interface CliTargetAnalysis {
  argIndex: number;
  rawValue: string;
  displayValue: string;
  normalizedTarget: string;
  isHomePath: boolean;
}

export interface CliExecutionPlan {
  mode: HomeguardMode;
  shouldWarn: boolean;
  shouldBlock: boolean;
  shouldRedirect: boolean;
  command: string;
  args: string[];
  exitCode: number;
  analyses: CliTargetAnalysis[];
  warnings: string[];
}

function getDefaultOptions(options: HomeguardCliOptions): Required<
  Omit<HomeguardCliOptions, "realpath" | "escapeFolder" | "allowList" | "highRiskFolders">
> & Pick<HomeguardCliOptions, "realpath" | "escapeFolder" | "allowList" | "highRiskFolders"> {
  return {
    mode: options.mode,
    allowList: options.allowList ?? [],
    highRiskFolders: options.highRiskFolders ?? [],
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? homedir(),
    platform: options.platform ?? process.platform,
    codeCommand: options.codeCommand ?? "code",
    escapeFolder: options.escapeFolder,
    realpath: options.realpath
  };
}

function isOptionLike(argument: string): boolean {
  return argument.startsWith("-") && argument !== "-";
}

function getPathLikeArgumentIndexes(argv: string[]): number[] {
  const indexes: number[] = [];
  let afterDoubleDash = false;

  argv.forEach((argument, index) => {
    if (argument === "--") {
      afterDoubleDash = true;
      return;
    }

    if (!afterDoubleDash && isOptionLike(argument)) {
      return;
    }

    indexes.push(index);
  });

  return indexes;
}

function buildWarningMessages(
  analyses: CliTargetAnalysis[],
  mode: HomeguardMode,
  redirectTarget?: string
): string[] {
  const warnings: string[] = [];

  for (const analysis of analyses) {
    if (analysis.displayValue === ".") {
      warnings.push(
        'Current directory is your home directory. Opening "." here is equivalent to opening your entire home.'
      );
      continue;
    }

    warnings.push("Warning: opening the entire home directory is risky.");
    warnings.push(`Current target resolves to: ${analysis.normalizedTarget}`);
  }

  if (mode === "redirect" && redirectTarget) {
    warnings.push("Consider opening a project subdirectory instead.");
    warnings.push(`Redirecting to: ${redirectTarget}`);
  }

  if (mode === "block") {
    warnings.push("Opening your home directory has been blocked by HomeGuard policy.");
  }

  return warnings;
}

export async function buildCliExecutionPlan(
  argv: string[],
  options: HomeguardCliOptions
): Promise<CliExecutionPlan> {
  const resolvedOptions = getDefaultOptions(options);
  const pathArgumentIndexes = getPathLikeArgumentIndexes(argv);
  const analyses: CliTargetAnalysis[] = [];

  for (const argIndex of pathArgumentIndexes) {
    const rawValue = argv[argIndex];
    const risk = await evaluatePathRisk(rawValue, {
      cwd: resolvedOptions.cwd,
      env: resolvedOptions.env,
      homeDir: resolvedOptions.homeDir,
      platform: resolvedOptions.platform,
      allowList: resolvedOptions.allowList,
      highRiskFolders: resolvedOptions.highRiskFolders,
      realpath: resolvedOptions.realpath
    });

    if (!risk.isHomePath) {
      continue;
    }

    analyses.push({
      argIndex,
      rawValue,
      displayValue: rawValue,
      normalizedTarget: risk.normalized.realPath,
      isHomePath: true
    });
  }

  if (analyses.length === 0) {
    return {
      mode: resolvedOptions.mode,
      shouldWarn: false,
      shouldBlock: false,
      shouldRedirect: false,
      command: resolvedOptions.codeCommand,
      args: [...argv],
      exitCode: 0,
      analyses,
      warnings: []
    };
  }

  const redirectTarget = resolvedOptions.escapeFolder
    ? expandPathInput(resolvedOptions.escapeFolder, resolvedOptions)
    : undefined;
  const args = [...argv];
  const shouldRedirect = resolvedOptions.mode === "redirect" && Boolean(redirectTarget);

  if (shouldRedirect && redirectTarget) {
    for (const analysis of analyses) {
      args[analysis.argIndex] = redirectTarget;
    }
  }

  const shouldBlock = resolvedOptions.mode === "block";
  return {
    mode: resolvedOptions.mode,
    shouldWarn: true,
    shouldBlock,
    shouldRedirect,
    command: resolvedOptions.codeCommand,
    args,
    exitCode: shouldBlock ? 2 : 0,
    analyses,
    warnings: buildWarningMessages(analyses, resolvedOptions.mode, redirectTarget)
  };
}

export async function runHomeguardCode(
  argv: string[],
  options: HomeguardCliOptions,
  io: {
    stderr?: Pick<NodeJS.WriteStream, "write">;
    spawnCommand?: typeof spawn;
  } = {}
): Promise<number> {
  const plan = await buildCliExecutionPlan(argv, options);

  if (plan.warnings.length > 0) {
    const stderr = io.stderr ?? process.stderr;
    stderr.write(`${plan.warnings.join("\n")}\n`);
  }

  if (plan.shouldBlock) {
    return plan.exitCode;
  }

  const spawnCommand = io.spawnCommand ?? spawn;
  return await new Promise<number>((resolve, reject) => {
    const child = spawnCommand(plan.command, plan.args, {
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }

      resolve(code ?? 0);
    });
  });
}
