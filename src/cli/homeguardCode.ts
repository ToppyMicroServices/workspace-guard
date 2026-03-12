import { homedir } from "node:os";
import { spawn } from "node:child_process";

import { DEFAULT_ESCAPE_FOLDER, type HomeguardMode } from "../core/config";
import { ensureEscapeFolder, resolveEscapeFolderPath } from "../core/escapeFolder";
import { evaluatePathRisk, expandPathInput, type SupportedPlatform } from "../core/pathPolicy";

export interface HomeguardCliOptions {
  mode: HomeguardMode;
  escapeFolder?: string;
  enableEphemeralEscape?: boolean;
  allowList?: string[];
  highRiskFolders?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  platform?: SupportedPlatform;
  codeCommand?: string;
  now?: () => Date;
  realpath?: (candidate: string) => Promise<string>;
  ensureEscapeFolder?: typeof ensureEscapeFolder;
}

export interface CliTargetAnalysis {
  argIndex: number;
  rawValue: string;
  displayValue: string;
  normalizedTarget: string;
  isHomePath: boolean;
  isHighRiskPath: boolean;
}

export interface CliExecutionPlan {
  mode: HomeguardMode;
  shouldWarn: boolean;
  shouldBlock: boolean;
  shouldRedirect: boolean;
  redirectTimestamp?: string;
  command: string;
  args: string[];
  exitCode: number;
  analyses: CliTargetAnalysis[];
  warnings: string[];
}

function getDefaultOptions(options: HomeguardCliOptions): Required<
  Omit<HomeguardCliOptions, "realpath" | "escapeFolder" | "allowList" | "highRiskFolders" | "ensureEscapeFolder">
> & Pick<HomeguardCliOptions, "realpath" | "escapeFolder" | "allowList" | "highRiskFolders" | "ensureEscapeFolder"> {
  return {
    mode: options.mode,
    allowList: options.allowList ?? [],
    highRiskFolders: options.highRiskFolders ?? [],
    enableEphemeralEscape: options.enableEphemeralEscape ?? false,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? homedir(),
    platform: options.platform ?? process.platform,
    codeCommand: options.codeCommand ?? "code",
    now: options.now ?? (() => new Date()),
    escapeFolder: options.escapeFolder ?? DEFAULT_ESCAPE_FOLDER,
    realpath: options.realpath,
    ensureEscapeFolder: options.ensureEscapeFolder
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

  for (const analysis of analyses.filter((entry) => entry.isHighRiskPath && !entry.isHomePath)) {
    warnings.push(`Warning: opening a high-risk folder may expose secrets: ${analysis.normalizedTarget}`);
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
      if (!risk.isHighRiskPath) {
        continue;
      }
    }

    analyses.push({
      argIndex,
      rawValue,
      displayValue: rawValue,
      normalizedTarget: risk.normalized.realPath,
      isHomePath: risk.isHomePath,
      isHighRiskPath: risk.isHighRiskPath
    });
  }

  if (analyses.length === 0) {
    return {
      mode: resolvedOptions.mode,
      shouldWarn: false,
      shouldBlock: false,
      shouldRedirect: false,
      redirectTimestamp: undefined,
      command: resolvedOptions.codeCommand,
      args: [...argv],
      exitCode: 0,
      analyses,
      warnings: []
    };
  }

  const redirectTimestamp = resolvedOptions.enableEphemeralEscape
    ? resolvedOptions.now().toISOString()
    : undefined;
  const redirectTarget = resolveEscapeFolderPath({
    escapeFolder: resolvedOptions.escapeFolder,
    enableEphemeralEscape: resolvedOptions.enableEphemeralEscape,
    env: resolvedOptions.env,
    homeDir: resolvedOptions.homeDir,
    platform: resolvedOptions.platform,
    timestamp: redirectTimestamp
  });
  const args = [...argv];
  const shouldRedirect = resolvedOptions.mode === "redirect"
    && analyses.some((analysis) => analysis.isHomePath)
    && Boolean(redirectTarget);

  if (shouldRedirect && redirectTarget) {
    for (const analysis of analyses) {
      if (analysis.isHomePath) {
        args[analysis.argIndex] = redirectTarget;
      }
    }
  }

  const shouldBlock = resolvedOptions.mode === "block";
  return {
    mode: resolvedOptions.mode,
    shouldWarn: true,
    shouldBlock,
    shouldRedirect,
    redirectTimestamp,
    command: resolvedOptions.codeCommand,
    args,
    exitCode: shouldBlock ? 2 : 0,
    analyses,
    warnings: buildWarningMessages(
      analyses,
      resolvedOptions.mode,
      shouldRedirect ? redirectTarget : undefined
    )
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
  const resolvedOptions = getDefaultOptions(options);

  if (plan.warnings.length > 0) {
    const stderr = io.stderr ?? process.stderr;
    stderr.write(`${plan.warnings.join("\n")}\n`);
  }

  if (plan.shouldBlock) {
    return plan.exitCode;
  }

  if (plan.shouldRedirect) {
    await (resolvedOptions.ensureEscapeFolder ?? ensureEscapeFolder)({
      escapeFolder: resolvedOptions.escapeFolder,
      enableEphemeralEscape: resolvedOptions.enableEphemeralEscape,
      env: resolvedOptions.env,
      homeDir: resolvedOptions.homeDir,
      platform: resolvedOptions.platform,
      timestamp: plan.redirectTimestamp
    });
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
