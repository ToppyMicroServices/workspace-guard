import { promises as fs } from "node:fs";
import path from "node:path";

import type { RepositorySafetyFailOn, RepositorySafetyFinding, RepositorySafetySource } from "./repositorySafetyScanner";
import type { WorkspaceConfigScanProfile } from "./workspaceConfigScanner";

export interface RepositoryPolicyFs {
  access: (targetPath: string) => Promise<void>;
  readFile: (targetPath: string, encoding: BufferEncoding) => Promise<string>;
}

export interface RepositoryPolicyFindingAllowRule {
  id?: string;
  file?: string;
  source?: RepositorySafetySource;
}

export interface RepositorySafetyPolicy {
  version: 1;
  profile?: WorkspaceConfigScanProfile;
  failOn?: RepositorySafetyFailOn;
  findingAllowList?: Array<string | RepositoryPolicyFindingAllowRule>;
  commandAllowList?: string[];
}

export interface RepositoryPolicyValidationIssue {
  message: string;
  line?: number;
}

export interface LoadedRepositoryPolicy {
  rootPath: string;
  filePath?: string;
  policy: RepositorySafetyPolicy;
  validationIssues: RepositoryPolicyValidationIssue[];
}

const defaultFs: RepositoryPolicyFs = {
  access: fs.access,
  readFile: async (targetPath, encoding) => await fs.readFile(targetPath, encoding)
};

export const REPOSITORY_POLICY_FILE_CANDIDATES = [
  ".workspace-guard/policy.jsonc",
  ".workspace-guard/policy.json",
  "workspace-guard.policy.jsonc",
  "workspace-guard.policy.json"
] as const;

export const DEFAULT_REPOSITORY_POLICY_RELATIVE_PATH = REPOSITORY_POLICY_FILE_CANDIDATES[0];

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findLineNumber(content: string, text: string): number | undefined {
  const position = content.indexOf(text);
  if (position === -1) {
    return undefined;
  }

  return content.slice(0, position).split(/\r?\n/).length;
}

function validateFindingAllowRule(
  entry: unknown,
  issues: RepositoryPolicyValidationIssue[],
  content: string
): string | RepositoryPolicyFindingAllowRule | undefined {
  if (typeof entry === "string") {
    return entry;
  }

  if (!isObject(entry)) {
    issues.push({ message: "findingAllowList entries must be strings or objects." });
    return undefined;
  }

  const rule: RepositoryPolicyFindingAllowRule = {};
  if (typeof entry.id === "string") {
    rule.id = entry.id;
  }
  if (typeof entry.file === "string") {
    rule.file = entry.file;
  }
  if (typeof entry.source === "string" && ["github", "config", "policy"].includes(entry.source)) {
    rule.source = entry.source as RepositorySafetySource;
  }

  if (!rule.id && !rule.file && !rule.source) {
    issues.push({
      message: "findingAllowList object entries must define at least one of id, file, or source.",
      line: findLineNumber(content, JSON.stringify(entry).slice(1, -1))
    });
    return undefined;
  }

  return rule;
}

export function validateRepositoryPolicy(content: string, raw: unknown): LoadedRepositoryPolicy["validationIssues"] {
  const issues: RepositoryPolicyValidationIssue[] = [];

  if (!isObject(raw)) {
    return [{ message: "Policy file must contain a JSON object." }];
  }

  if (raw.version !== 1) {
    issues.push({
      message: "Policy version must be 1.",
      line: findLineNumber(content, "\"version\"")
    });
  }

  if (raw.profile !== undefined && raw.profile !== "default" && raw.profile !== "restricted") {
    issues.push({
      message: "Policy profile must be default or restricted.",
      line: findLineNumber(content, "\"profile\"")
    });
  }

  if (raw.failOn !== undefined && !["none", "high", "medium", "info"].includes(String(raw.failOn))) {
    issues.push({
      message: "Policy failOn must be none, high, medium, or info.",
      line: findLineNumber(content, "\"failOn\"")
    });
  }

  if (raw.findingAllowList !== undefined && !Array.isArray(raw.findingAllowList)) {
    issues.push({
      message: "findingAllowList must be an array.",
      line: findLineNumber(content, "\"findingAllowList\"")
    });
  }

  if (Array.isArray(raw.findingAllowList)) {
    for (const entry of raw.findingAllowList) {
      validateFindingAllowRule(entry, issues, content);
    }
  }

  if (raw.commandAllowList !== undefined) {
    if (!Array.isArray(raw.commandAllowList) || raw.commandAllowList.some((entry) => typeof entry !== "string")) {
      issues.push({
        message: "commandAllowList must be an array of strings.",
        line: findLineNumber(content, "\"commandAllowList\"")
      });
    }
  }

  return issues;
}

function normalizeRepositoryPolicy(raw: unknown, validationIssues: RepositoryPolicyValidationIssue[], content: string): RepositorySafetyPolicy {
  if (!isObject(raw)) {
    return { version: 1 };
  }

  const findingAllowList = Array.isArray(raw.findingAllowList)
    ? raw.findingAllowList
      .map((entry) => validateFindingAllowRule(entry, validationIssues, content))
      .filter((entry): entry is string | RepositoryPolicyFindingAllowRule => entry !== undefined)
    : undefined;
  const commandAllowList = Array.isArray(raw.commandAllowList)
    ? raw.commandAllowList.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return {
    version: 1,
    profile: raw.profile === "default" || raw.profile === "restricted" ? raw.profile : undefined,
    failOn: raw.failOn === "none" || raw.failOn === "high" || raw.failOn === "medium" || raw.failOn === "info"
      ? raw.failOn
      : undefined,
    findingAllowList,
    commandAllowList
  };
}

export async function loadRepositoryPolicy(
  rootPath: string,
  options: {
    fileSystem?: RepositoryPolicyFs;
    explicitPath?: string;
  } = {}
): Promise<LoadedRepositoryPolicy> {
  const fileSystem = options.fileSystem ?? defaultFs;
  const candidates = options.explicitPath
    ? [options.explicitPath]
    : REPOSITORY_POLICY_FILE_CANDIDATES.map((relativePath) => path.join(rootPath, relativePath));
  let filePath: string | undefined;

  for (const candidate of candidates) {
    try {
      await fileSystem.access(candidate);
      filePath = candidate;
      break;
    } catch {
      continue;
    }
  }

  if (!filePath) {
    return {
      rootPath,
      policy: { version: 1 },
      validationIssues: []
    };
  }

  const content = await fileSystem.readFile(filePath, "utf8");
  try {
    const parsed = parseJsonc(content);
    const validationIssues = validateRepositoryPolicy(content, parsed);
    return {
      rootPath,
      filePath,
      policy: normalizeRepositoryPolicy(parsed, validationIssues, content),
      validationIssues
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      rootPath,
      filePath,
      policy: { version: 1 },
      validationIssues: [{ message: `Policy file could not be parsed: ${message}` }]
    };
  }
}

function matchesFindingAllowRule(
  rule: string | RepositoryPolicyFindingAllowRule,
  finding: Pick<RepositorySafetyFinding, "id" | "file" | "source">
): boolean {
  if (typeof rule === "string") {
    return finding.id === rule;
  }

  if (rule.id && finding.id !== rule.id) {
    return false;
  }
  if (rule.file && finding.file !== rule.file) {
    return false;
  }
  if (rule.source && finding.source !== rule.source) {
    return false;
  }

  return true;
}

export function filterFindingsWithRepositoryPolicy(
  findings: RepositorySafetyFinding[],
  policy: RepositorySafetyPolicy
): RepositorySafetyFinding[] {
  const allowList = policy.findingAllowList ?? [];
  if (allowList.length === 0) {
    return findings;
  }

  return findings.filter((finding) => !allowList.some((rule) => matchesFindingAllowRule(rule, finding)));
}

export function isCommandAllowedByRepositoryPolicy(commandId: string, policy: RepositorySafetyPolicy): boolean {
  const allowList = policy.commandAllowList;
  if (!allowList || allowList.length === 0) {
    return true;
  }

  return allowList.includes(commandId);
}

export function getEffectiveRepositoryPolicyProfile(
  policy: RepositorySafetyPolicy,
  fallback: WorkspaceConfigScanProfile
): WorkspaceConfigScanProfile {
  return policy.profile ?? fallback;
}

export function getEffectiveRepositoryPolicyFailOn(
  policy: RepositorySafetyPolicy,
  fallback: RepositorySafetyFailOn
): RepositorySafetyFailOn {
  return policy.failOn ?? fallback;
}

export function getDefaultRepositoryPolicyPath(rootPath: string): string {
  return path.join(rootPath, DEFAULT_REPOSITORY_POLICY_RELATIVE_PATH);
}

export function formatDefaultRepositoryPolicy(): string {
  return `{
  "version": 1,
  "profile": "restricted",
  "failOn": "medium",
  "findingAllowList": [
    { "id": "WG-CFGWS-001", "file": "demo.code-workspace" }
  ],
  "commandAllowList": [
    "homeguard.reviewRepositorySafety",
    "homeguard.exportRepositorySafetyJson",
    "homeguard.exportRepositorySafetySarif",
    "homeguard.copyRepositorySafetyCopilotPrompt",
    "homeguard.openRepositoryPolicyFile",
    "homeguard.setRepositoryScanProfile"
  ]
}
`;
}