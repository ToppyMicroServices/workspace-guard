import { promises as fs } from "node:fs";
import path from "node:path";

export type WorkspaceConfigFindingSeverity = "high" | "medium" | "info";
export type WorkspaceConfigFindingConfidence = "high" | "medium" | "low";
export type WorkspaceConfigScanProfile = "default" | "restricted";

export interface WorkspaceConfigDirentLike {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

export interface WorkspaceConfigScannerFs {
  readdir: (
    targetPath: string,
    options: { withFileTypes: true }
  ) => Promise<WorkspaceConfigDirentLike[]>;
  readFile: (targetPath: string, encoding: BufferEncoding) => Promise<string>;
}

export interface WorkspaceConfigFinding {
  id: string;
  severity: WorkspaceConfigFindingSeverity;
  category: string;
  file: string;
  line?: number;
  reason: string;
  evidence: string;
  message: string;
  suggestedAction: string;
  confidence: WorkspaceConfigFindingConfidence;
}

export interface WorkspaceConfigScanResult {
  rootPath: string;
  scannedFiles: string[];
  findings: WorkspaceConfigFinding[];
}

export interface WorkspaceConfigScanOptions {
  fs?: WorkspaceConfigScannerFs;
  profile?: WorkspaceConfigScanProfile;
}

type JsonObject = Record<string, unknown>;

const defaultFs: WorkspaceConfigScannerFs = {
  readdir: fs.readdir,
  readFile: async (targetPath, encoding) => await fs.readFile(targetPath, encoding)
};

const TASKS_FILE_PATTERN = /^\.vscode\/tasks\.json$/i;
const LAUNCH_FILE_PATTERN = /^\.vscode\/launch\.json$/i;
const MCP_FILE_PATTERN = /^\.vscode\/mcp\.json$/i;
const SETTINGS_FILE_PATTERN = /^\.vscode\/settings\.json$/i;
const WORKSPACE_FILE_PATTERN = /^[^/]+\.code-workspace$/i;
const HIGH_RISK_COMMAND_PATTERN = /(curl\b.+\|\s*(bash|sh)\b|wget\b.+\|\s*(bash|sh)\b|Invoke-WebRequest\b.+\|\s*(iex|pwsh|powershell)\b|\b(rm\s+-rf|git\s+clean\s+-fd|git\s+reset\s+--hard|terraform\s+destroy|kubectl\s+delete)\b|\b(?:bash|sh|zsh|pwsh|powershell|cmd(?:\.exe)?)\b\s+[-/][ce])/i;
const REMOTE_TOOLCHAIN_PATTERN = /^\s*(npx|pnpm|yarn|npm|uvx|docker|podman|ssh)\b/i;
const RECOMMENDED_EXTENSION_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;

export function isWorkspaceConfigFile(relativePath: string): boolean {
  return TASKS_FILE_PATTERN.test(relativePath)
    || LAUNCH_FILE_PATTERN.test(relativePath)
    || MCP_FILE_PATTERN.test(relativePath)
    || SETTINGS_FILE_PATTERN.test(relativePath)
    || WORKSPACE_FILE_PATTERN.test(relativePath);
}

function toRelativePath(rootPath: string, filePath: string): string {
  return path.relative(rootPath, filePath).split(path.sep).join("/");
}

function toLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function createFinding(
  file: string,
  line: number | undefined,
  finding: Omit<WorkspaceConfigFinding, "file" | "line">
): WorkspaceConfigFinding {
  return {
    ...finding,
    file,
    line
  };
}

function stripJsonComments(content: string): string {
  let result = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];

    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (current === '"' || current === "'") {
      inString = true;
      stringQuote = current;
      result += current;
      continue;
    }

    if (current === "/" && next === "/") {
      result += "  ";
      index += 2;
      while (index < content.length && content[index] !== "\n") {
        result += " ";
        index += 1;
      }
      if (index < content.length) {
        result += content[index];
      }
      continue;
    }

    if (current === "/" && next === "*") {
      result += "  ";
      index += 2;
      while (index < content.length) {
        if (content[index] === "*" && content[index + 1] === "/") {
          result += "  ";
          index += 1;
          break;
        }

        result += content[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    result += current;
  }

  return result;
}

function stripTrailingCommas(content: string): string {
  const characters = content.split("");
  let inString = false;
  let stringQuote = "";
  let escaped = false;

  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (current === '"' || current === "'") {
      inString = true;
      stringQuote = current;
      continue;
    }

    if (current !== ",") {
      continue;
    }

    let lookAhead = index + 1;
    while (lookAhead < characters.length && /\s/.test(characters[lookAhead] ?? "")) {
      lookAhead += 1;
    }

    if (characters[lookAhead] === "}" || characters[lookAhead] === "]") {
      characters[index] = " ";
    }
  }

  return characters.join("");
}

function parseJsonc(content: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(content)));
}

function findLineNumber(lines: string[], pattern: RegExp | string): number | undefined {
  const index = lines.findIndex((line) => typeof pattern === "string" ? line.includes(pattern) : pattern.test(line));
  return index === -1 ? undefined : index + 1;
}

function findLineText(lines: string[], pattern: RegExp | string): string {
  const lineNumber = findLineNumber(lines, pattern);
  if (!lineNumber) {
    return typeof pattern === "string" ? pattern : pattern.source;
  }

  return lines[lineNumber - 1]?.trim() ?? "";
}

function getParseErrorPosition(error: Error): number | undefined {
  const match = /position\s+(\d+)/i.exec(error.message);
  return match ? Number.parseInt(match[1] ?? "", 10) : undefined;
}

function getLineNumberFromPosition(content: string, position: number | undefined): number | undefined {
  if (position === undefined || Number.isNaN(position)) {
    return undefined;
  }

  return content.slice(0, position).split(/\r?\n/).length;
}

function findTargetLine(lines: string[], candidates: Array<RegExp | string | undefined>): number | undefined {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const line = findLineNumber(lines, candidate);
    if (line) {
      return line;
    }
  }

  return undefined;
}

function commandText(...parts: unknown[]): string {
  return parts.flatMap((part) => {
    if (typeof part === "string") {
      return [part];
    }

    if (Array.isArray(part)) {
      return part.filter((entry): entry is string => typeof entry === "string");
    }

    return [];
  }).join(" ").trim();
}

function pickSeverity(
  profile: WorkspaceConfigScanProfile,
  defaultSeverity: WorkspaceConfigFindingSeverity,
  restrictedSeverity: WorkspaceConfigFindingSeverity
): WorkspaceConfigFindingSeverity {
  return profile === "restricted" ? restrictedSeverity : defaultSeverity;
}

async function walkDirectory(fileSystem: WorkspaceConfigScannerFs, targetPath: string): Promise<string[]> {
  let entries: WorkspaceConfigDirentLike[];

  try {
    entries = await fileSystem.readdir(targetPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(entries.map(async (entry) => {
    const childPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      return await walkDirectory(fileSystem, childPath);
    }

    return entry.isFile() ? [childPath] : [];
  }));

  return nested.flat();
}

function scanTaskConfigurations(file: string, lines: string[], data: JsonObject, profile: WorkspaceConfigScanProfile): WorkspaceConfigFinding[] {
  const findings: WorkspaceConfigFinding[] = [];
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];

  for (const task of tasks) {
    if (!isObject(task)) {
      continue;
    }

    const label = asString(task.label) ?? asString(task.command) ?? "task";
    const line = findTargetLine(lines, [label, /"runOn"\s*:\s*"folderOpen"/]);
    const runOn = asString(task.runOn);
    const taskCommand = commandText(task.command, task.args);

    if (runOn === "folderOpen") {
      findings.push(createFinding(file, line, {
        id: "WG-CFGTASK-001",
        severity: pickSeverity(profile, "medium", "high"),
        category: "task-automation",
        reason: "task can run automatically when the folder opens",
        evidence: findLineText(lines, /"runOn"\s*:\s*"folderOpen"/),
        message: `Task ${label} is configured to run on folder open and should be reviewed before trusting the workspace.`,
        suggestedAction: "Disable automatic task execution or require explicit user invocation.",
        confidence: "high"
      }));
    }

    if (taskCommand && HIGH_RISK_COMMAND_PATTERN.test(taskCommand)) {
      findings.push(createFinding(file, line, {
        id: "WG-CFGTASK-002",
        severity: "high",
        category: "task-command",
        reason: "task command contains a dangerous shell pattern",
        evidence: taskCommand,
        message: `Task ${label} executes a high-risk shell pattern that deserves manual review.`,
        suggestedAction: "Replace destructive or pipe-to-shell task commands with checked-in scripts and explicit review steps.",
        confidence: "medium"
      }));
    }
  }

  return findings;
}

function scanLaunchConfigurations(file: string, lines: string[], data: JsonObject, profile: WorkspaceConfigScanProfile): WorkspaceConfigFinding[] {
  const findings: WorkspaceConfigFinding[] = [];
  const configurations = Array.isArray(data.configurations) ? data.configurations : [];

  for (const configuration of configurations) {
    if (!isObject(configuration)) {
      continue;
    }

    const name = asString(configuration.name) ?? asString(configuration.type) ?? "launch configuration";
    const preLaunchTask = asString(configuration.preLaunchTask);
    const postDebugTask = asString(configuration.postDebugTask);
    const launchCommand = commandText(
      configuration.runtimeExecutable,
      configuration.program,
      configuration.args
    );
    const line = findTargetLine(lines, [name, preLaunchTask, postDebugTask]);

    if (preLaunchTask || postDebugTask) {
      findings.push(createFinding(file, line, {
        id: "WG-CFGLAUNCH-001",
        severity: pickSeverity(profile, "info", "medium"),
        category: "launch-automation",
        reason: "debug configuration triggers a task automatically",
        evidence: preLaunchTask ?? postDebugTask ?? name,
        message: `Launch configuration ${name} triggers a task automatically and should be reviewed before debugging.`,
        suggestedAction: "Confirm that the referenced task is safe, deterministic, and does not execute untrusted commands.",
        confidence: "high"
      }));
    }

    if (launchCommand && HIGH_RISK_COMMAND_PATTERN.test(launchCommand)) {
      findings.push(createFinding(file, line, {
        id: "WG-CFGLAUNCH-002",
        severity: "high",
        category: "launch-command",
        reason: "launch configuration invokes a dangerous command pattern",
        evidence: launchCommand,
        message: `Launch configuration ${name} can execute a high-risk shell pattern.`,
        suggestedAction: "Move complex launch behavior into reviewed scripts and avoid shell-evaluated debug commands.",
        confidence: "medium"
      }));
    }
  }

  return findings;
}

function scanMcpConfiguration(file: string, lines: string[], data: JsonObject, profile: WorkspaceConfigScanProfile): WorkspaceConfigFinding[] {
  const findings: WorkspaceConfigFinding[] = [];
  const serverEntries: Array<[string, JsonObject]> = [];
  const rawServers = data.servers;

  if (isObject(rawServers)) {
    for (const [name, value] of Object.entries(rawServers)) {
      if (isObject(value)) {
        serverEntries.push([name, value]);
      }
    }
  }

  for (const [name, server] of serverEntries) {
    const command = commandText(server.command, server.args);
    const line = findTargetLine(lines, [name, command]);

    if (command && HIGH_RISK_COMMAND_PATTERN.test(command)) {
      findings.push(createFinding(file, line, {
        id: "WG-CFGMCP-001",
        severity: "high",
        category: "mcp-command",
        reason: "MCP server command contains a dangerous shell pattern",
        evidence: command,
        message: `MCP server ${name} executes a high-risk command pattern that expands the workspace trust boundary.`,
        suggestedAction: "Use reviewed binaries or scripts for MCP servers and avoid shell-evaluated commands.",
        confidence: "medium"
      }));
    } else if (command && REMOTE_TOOLCHAIN_PATTERN.test(command)) {
      findings.push(createFinding(file, line, {
        id: "WG-CFGMCP-002",
        severity: pickSeverity(profile, "medium", "high"),
        category: "mcp-launcher",
        reason: "MCP server is launched through a mutable package or container toolchain",
        evidence: command,
        message: `MCP server ${name} is started via a toolchain like npx or docker, which should be reviewed before use.`,
        suggestedAction: "Pin MCP server launchers to reviewed binaries or checked-in scripts instead of mutable toolchain commands.",
        confidence: "high"
      }));
    }
  }

  return findings;
}

function scanSettingsObject(
  file: string,
  lines: string[],
  settings: JsonObject,
  profile: WorkspaceConfigScanProfile
): WorkspaceConfigFinding[] {
  const findings: WorkspaceConfigFinding[] = [];
  const automaticTasks = settings["task.allowAutomaticTasks"];
  const trustEnabled = settings["security.workspace.trust.enabled"];

  if (automaticTasks === true || automaticTasks === "on") {
    findings.push(createFinding(file, findLineNumber(lines, /task\.allowAutomaticTasks/), {
      id: "WG-CFGSET-001",
      severity: pickSeverity(profile, "medium", "high"),
      category: "workspace-setting",
      reason: "workspace settings allow automatic tasks",
      evidence: findLineText(lines, /task\.allowAutomaticTasks/),
      message: "Workspace settings enable automatic tasks, which can execute commands before manual review.",
      suggestedAction: "Set task.allowAutomaticTasks to off or require user confirmation before task execution.",
      confidence: "high"
    }));
  }

  if (trustEnabled === false) {
    findings.push(createFinding(file, findLineNumber(lines, /security\.workspace\.trust\.enabled/), {
      id: "WG-CFGSET-002",
      severity: "high",
      category: "workspace-setting",
      reason: "workspace settings disable VS Code workspace trust",
      evidence: findLineText(lines, /security\.workspace\.trust\.enabled/),
      message: "Workspace settings disable VS Code workspace trust, weakening the editor's built-in safeguards.",
      suggestedAction: "Remove the override and keep security.workspace.trust.enabled enabled for untrusted repositories.",
      confidence: "high"
    }));
  }

  return findings;
}

function scanWorkspaceFile(file: string, lines: string[], data: JsonObject, profile: WorkspaceConfigScanProfile): WorkspaceConfigFinding[] {
  const findings: WorkspaceConfigFinding[] = [];
  const settings = isObject(data.settings) ? data.settings : undefined;
  if (settings) {
    findings.push(...scanSettingsObject(file, lines, settings, profile));
  }

  const extensions = isObject(data.extensions) ? data.extensions : undefined;
  const recommendations = extensions ? asStringArray(extensions.recommendations) : [];
  if (recommendations.some((entry) => RECOMMENDED_EXTENSION_PATTERN.test(entry))) {
    findings.push(createFinding(file, findLineNumber(lines, /recommendations/), {
      id: "WG-CFGWS-001",
      severity: pickSeverity(profile, "info", "medium"),
      category: "workspace-extensions",
      reason: "workspace file recommends extensions that may expand execution or trust boundaries",
      evidence: recommendations.join(", "),
      message: "Workspace recommendations suggest extensions that should be reviewed before installation in an untrusted repository.",
      suggestedAction: "Review each recommended extension and install only the ones required for the current task.",
      confidence: "medium"
    }));
  }

  const tasks = isObject(data.tasks) ? data.tasks : undefined;
  if (tasks) {
    findings.push(...scanTaskConfigurations(file, lines, { tasks: Array.isArray(tasks.tasks) ? tasks.tasks : [] }, profile));
  }

  const launch = isObject(data.launch) ? data.launch : undefined;
  if (launch) {
    findings.push(...scanLaunchConfigurations(file, lines, launch, profile));
  }

  return findings;
}

function scanConfigFile(file: string, content: string, profile: WorkspaceConfigScanProfile): WorkspaceConfigFinding[] {
  const lines = toLines(content);
  let parsed: unknown;

  try {
    parsed = parseJsonc(content);
  } catch (error: unknown) {
    const parseError = error instanceof Error ? error : new Error(String(error));
    return [createFinding(file, getLineNumberFromPosition(content, getParseErrorPosition(parseError)), {
      id: "WG-CFGJSON-001",
      severity: "medium",
      category: "jsonc-parse",
      reason: "workspace configuration file could not be parsed as JSON or JSONC",
      evidence: parseError.message,
      message: `Workspace Guard could not parse ${file}. Broken configuration can hide or misrepresent execution settings.`,
      suggestedAction: "Fix JSON or JSONC syntax before trusting the repository configuration.",
      confidence: "high"
    })];
  }

  if (!isObject(parsed)) {
    return [];
  }

  if (TASKS_FILE_PATTERN.test(file)) {
    return scanTaskConfigurations(file, lines, parsed, profile);
  }

  if (LAUNCH_FILE_PATTERN.test(file)) {
    return scanLaunchConfigurations(file, lines, parsed, profile);
  }

  if (MCP_FILE_PATTERN.test(file)) {
    return scanMcpConfiguration(file, lines, parsed, profile);
  }

  if (SETTINGS_FILE_PATTERN.test(file)) {
    return scanSettingsObject(file, lines, parsed, profile);
  }

  if (WORKSPACE_FILE_PATTERN.test(file)) {
    return scanWorkspaceFile(file, lines, parsed, profile);
  }

  return [];
}

function sortFindings(findings: WorkspaceConfigFinding[]): WorkspaceConfigFinding[] {
  const severityRank: Record<WorkspaceConfigFindingSeverity, number> = {
    high: 0,
    medium: 1,
    info: 2
  };

  return findings.sort((left, right) => {
    const severityDifference = severityRank[left.severity] - severityRank[right.severity];
    if (severityDifference !== 0) {
      return severityDifference;
    }

    const fileDifference = left.file.localeCompare(right.file);
    if (fileDifference !== 0) {
      return fileDifference;
    }

    return (left.line ?? 0) - (right.line ?? 0);
  });
}

export async function scanWorkspaceConfig(
  rootPath: string,
  options: WorkspaceConfigScanOptions = {}
): Promise<WorkspaceConfigScanResult> {
  const fileSystem = options.fs ?? defaultFs;
  const profile = options.profile ?? "default";
  const files = (await walkDirectory(fileSystem, rootPath))
    .map((filePath) => toRelativePath(rootPath, filePath))
    .filter((relativePath) => isWorkspaceConfigFile(relativePath))
    .sort();

  const findings: WorkspaceConfigFinding[] = [];
  for (const file of files) {
    const content = await fileSystem.readFile(path.join(rootPath, file), "utf8");
    findings.push(...scanConfigFile(file, content, profile));
  }

  return {
    rootPath,
    scannedFiles: files,
    findings: sortFindings(findings)
  };
}

export function formatWorkspaceConfigScanResult(result: WorkspaceConfigScanResult): string {
  if (result.scannedFiles.length === 0) {
    return "No workspace configuration files were found.";
  }

  if (result.findings.length === 0) {
    return `Scanned ${result.scannedFiles.length} workspace configuration file${result.scannedFiles.length === 1 ? "" : "s"}. No configuration findings.`;
  }

  const lines = [`Scanned ${result.scannedFiles.length} workspace configuration file${result.scannedFiles.length === 1 ? "" : "s"}.`];
  for (const finding of result.findings) {
    lines.push(`[${finding.severity}] ${finding.id} ${finding.file}${finding.line ? `:${finding.line}` : ""} ${finding.message}`);
  }

  return lines.join("\n");
}