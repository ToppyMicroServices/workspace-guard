import { promises as fs } from "node:fs";
import path from "node:path";

export type SupportedPlatform = NodeJS.Platform | "win32";

export interface PathNormalizationOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  homeDir: string;
  platform?: SupportedPlatform;
  realpath?: (candidate: string) => Promise<string>;
}

export interface NormalizedPathInfo {
  input: string;
  expanded: string;
  resolved: string;
  realPath: string;
  comparablePath: string;
  usedRealpath: boolean;
}

export interface PathRiskEvaluation {
  normalized: NormalizedPathInfo;
  isHomePath: boolean;
  isAllowedPath: boolean;
  isHighRiskPath: boolean;
}

const ENV_VAR_PATTERN = /\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([^}]+)\}|%([^%]+)%/g;

function getPathModule(platform: SupportedPlatform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function getDefaultCwd(platform: SupportedPlatform): string {
  return platform === "win32" ? "C:\\" : "/";
}

function expandEnvironmentVariables(
  input: string,
  env: Record<string, string | undefined>
): string {
  return input.replace(ENV_VAR_PATTERN, (_, dollarName, bracedName, windowsName) => {
    const variableName = dollarName ?? bracedName ?? windowsName;
    return env[variableName] ?? "";
  });
}

export function expandPathInput(
  input: string,
  options: Pick<PathNormalizationOptions, "env" | "homeDir" | "platform">
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir;

  let expanded = expandEnvironmentVariables(input, env);
  if (expanded === "~") {
    return homeDir;
  }

  if (/^~(?=[\\/])/.test(expanded)) {
    expanded = homeDir + expanded.slice(1);
  }

  if (platform === "win32") {
    return expanded.replace(/\//g, "\\");
  }

  return expanded;
}

export function toComparablePath(targetPath: string, platform: SupportedPlatform): string {
  const pathModule = getPathModule(platform);
  const normalized = pathModule.normalize(targetPath);
  const root = pathModule.parse(normalized).root;
  let comparable = normalized;

  while (comparable.length > root.length && /[\\/]$/.test(comparable)) {
    comparable = comparable.slice(0, -1);
  }

  if (platform === "win32") {
    comparable = comparable.toLowerCase();
  }

  return comparable;
}

export async function normalizePathInput(
  input: string,
  options: PathNormalizationOptions
): Promise<NormalizedPathInfo> {
  const platform = options.platform ?? process.platform;
  const pathModule = getPathModule(platform);
  const cwd = options.cwd ?? process.cwd?.() ?? getDefaultCwd(platform);
  const expanded = expandPathInput(input, options);
  const resolved = pathModule.resolve(cwd, expanded);
  const realpath = options.realpath ?? fs.realpath;

  let realPath = resolved;
  let usedRealpath = true;

  try {
    realPath = await realpath(resolved);
  } catch {
    usedRealpath = false;
  }

  return {
    input,
    expanded,
    resolved,
    realPath,
    comparablePath: toComparablePath(realPath, platform),
    usedRealpath
  };
}

export function isSameOrDescendantPath(
  targetComparablePath: string,
  baseComparablePath: string,
  platform: SupportedPlatform
): boolean {
  if (targetComparablePath === baseComparablePath) {
    return true;
  }

  const separator = platform === "win32" ? "\\" : "/";
  const prefix = baseComparablePath.endsWith(separator)
    ? baseComparablePath
    : `${baseComparablePath}${separator}`;

  return targetComparablePath.startsWith(prefix);
}

async function normalizeComparisonBase(
  candidate: string,
  options: PathNormalizationOptions
): Promise<string> {
  const normalized = await normalizePathInput(candidate, {
    ...options,
    cwd: options.cwd ?? getDefaultCwd(options.platform ?? process.platform)
  });
  return normalized.comparablePath;
}

export async function evaluatePathRisk(
  input: string,
  options: PathNormalizationOptions & {
    allowList?: string[];
    highRiskFolders?: string[];
  }
): Promise<PathRiskEvaluation> {
  const platform = options.platform ?? process.platform;
  const normalized = await normalizePathInput(input, options);
  const homeComparablePath = await normalizeComparisonBase(options.homeDir, options);

  const allowList = options.allowList ?? [];
  const highRiskFolders = options.highRiskFolders ?? [];

  const allowComparablePaths = await Promise.all(
    allowList.map((entry) => normalizeComparisonBase(entry, options))
  );
  const highRiskComparablePaths = await Promise.all(
    highRiskFolders.map((entry) => normalizeComparisonBase(entry, options))
  );

  return {
    normalized,
    isHomePath: normalized.comparablePath === homeComparablePath,
    isAllowedPath: allowComparablePaths.some((entry) =>
      isSameOrDescendantPath(normalized.comparablePath, entry, platform)
    ),
    isHighRiskPath: highRiskComparablePaths.some((entry) =>
      isSameOrDescendantPath(normalized.comparablePath, entry, platform)
    )
  };
}
