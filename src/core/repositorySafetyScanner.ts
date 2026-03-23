import path from "node:path";

import {
  formatGithubMetadataScanResult,
  scanGithubMetadata,
  type GithubMetadataFinding,
  type GithubMetadataScanOptions,
  type GithubMetadataScanResult
} from "./githubMetadataScanner";
import {
  formatWorkspaceConfigScanResult,
  isWorkspaceConfigFile,
  scanWorkspaceConfig,
  type WorkspaceConfigFinding,
  type WorkspaceConfigScanOptions,
  type WorkspaceConfigScanProfile,
  type WorkspaceConfigScanResult
} from "./workspaceConfigScanner";
import {
  filterFindingsWithRepositoryPolicy,
  loadRepositoryPolicy,
  type LoadedRepositoryPolicy,
  type RepositorySafetyPolicy
} from "./repositoryPolicy";

export type RepositorySafetyFindingSeverity = "high" | "medium" | "info";
export type RepositorySafetyFindingConfidence = "high" | "medium" | "low";
export type RepositorySafetySource = "github" | "config" | "policy";
export type RepositorySafetyFailOn = "none" | "high" | "medium" | "info";

export interface RepositorySafetyFinding {
  id: string;
  source: RepositorySafetySource;
  severity: RepositorySafetyFindingSeverity;
  category: string;
  file: string;
  line?: number;
  reason: string;
  evidence: string;
  message: string;
  suggestedAction: string;
  confidence: RepositorySafetyFindingConfidence;
}

export interface RepositorySafetySummary {
  totalFindings: number;
  highFindings: number;
  mediumFindings: number;
  infoFindings: number;
}

export interface RepositorySafetyScanResult {
  rootPath: string;
  profile: WorkspaceConfigScanProfile;
  scannedFiles: string[];
  findings: RepositorySafetyFinding[];
  summary: RepositorySafetySummary;
  github: GithubMetadataScanResult;
  config: WorkspaceConfigScanResult;
  policy: LoadedRepositoryPolicy;
}

export interface RepositorySafetyScanOptions extends GithubMetadataScanOptions, WorkspaceConfigScanOptions {
  profile?: WorkspaceConfigScanProfile;
  policy?: RepositorySafetyPolicy;
  policyPath?: string;
}

const GITHUB_METADATA_FILE_PATTERNS = [
  /^\.github\/workflows\/.+\.ya?ml$/i,
  /^\.github\/dependabot\.ya?ml$/i,
  /^\.github\/CODEOWNERS$/,
  /^\.github\/ISSUE_TEMPLATE\/.+/,
  /^\.github\/PULL_REQUEST_TEMPLATE(?:\/.+|[^/]*)$/
];

function mapGithubFinding(finding: GithubMetadataFinding): RepositorySafetyFinding {
  return {
    ...finding,
    source: "github"
  };
}

function mapConfigFinding(finding: WorkspaceConfigFinding): RepositorySafetyFinding {
  return {
    ...finding,
    source: "config"
  };
}

function mapPolicyIssue(policy: LoadedRepositoryPolicy): RepositorySafetyFinding[] {
  if (!policy.filePath) {
    return [];
  }

  const relativePath = path.relative(policy.rootPath, policy.filePath).split(path.sep).join("/");
  return policy.validationIssues.map((issue, index) => ({
    id: `WG-POLICY-${String(index + 1).padStart(3, "0")}`,
    source: "policy",
    severity: "medium",
    category: "policy-validation",
    file: relativePath,
    line: issue.line,
    reason: issue.message,
    evidence: issue.message,
    message: issue.message,
    suggestedAction: "Fix the repository policy file so filtering and profile selection remain deterministic.",
    confidence: "high"
  }));
}

function sortFindings(findings: RepositorySafetyFinding[]): RepositorySafetyFinding[] {
  const severityRank: Record<RepositorySafetyFindingSeverity, number> = {
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

export function summarizeRepositorySafetyFindings(findings: RepositorySafetyFinding[]): RepositorySafetySummary {
  const summary: RepositorySafetySummary = {
    totalFindings: findings.length,
    highFindings: 0,
    mediumFindings: 0,
    infoFindings: 0
  };

  for (const finding of findings) {
    if (finding.severity === "high") {
      summary.highFindings += 1;
    } else if (finding.severity === "medium") {
      summary.mediumFindings += 1;
    } else {
      summary.infoFindings += 1;
    }
  }

  return summary;
}

export function isRepositorySafetyRelevantPath(rootPath: string, filePath: string): boolean {
  const relativePath = path.relative(rootPath, filePath).split(path.sep).join("/");
  return isWorkspaceConfigFile(relativePath) || GITHUB_METADATA_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

export function getRepositorySafetyExitCode(
  result: RepositorySafetyScanResult,
  failOn: RepositorySafetyFailOn = "medium"
): number {
  if (failOn === "none") {
    return 0;
  }

  const severityRank: Record<RepositorySafetyFailOn | RepositorySafetyFindingSeverity, number> = {
    none: 99,
    high: 0,
    medium: 1,
    info: 2
  };
  const threshold = severityRank[failOn];
  return result.findings.some((finding) => severityRank[finding.severity] <= threshold) ? 1 : 0;
}

export async function scanRepositorySafety(
  rootPath: string,
  options: RepositorySafetyScanOptions = {}
): Promise<RepositorySafetyScanResult> {
  const loadedPolicy = await loadRepositoryPolicy(rootPath, {
    explicitPath: options.policyPath
  });
  const effectivePolicy = options.policy ?? loadedPolicy.policy;
  const profile = options.profile ?? effectivePolicy.profile ?? "default";
  const [github, config] = await Promise.all([
    scanGithubMetadata(rootPath, {
      fs: options.fs,
      resolveExternalWorkflows: options.resolveExternalWorkflows,
      externalWorkflowResolver: options.externalWorkflowResolver
    }),
    scanWorkspaceConfig(rootPath, {
      fs: options.fs,
      profile
    })
  ]);

  const rawFindings = [
    ...github.findings.map(mapGithubFinding),
    ...config.findings.map(mapConfigFinding),
    ...mapPolicyIssue(loadedPolicy)
  ];
  const findings = sortFindings(filterFindingsWithRepositoryPolicy(rawFindings, effectivePolicy));
  const scannedFiles = [...new Set([...github.scannedFiles, ...config.scannedFiles])].sort();

  return {
    rootPath,
    profile,
    scannedFiles,
    findings,
    summary: summarizeRepositorySafetyFindings(findings),
    github,
    config,
    policy: loadedPolicy
  };
}

export function formatRepositorySafetyScanResult(result: RepositorySafetyScanResult): string {
  const summary = result.summary;
  const headline = summary.totalFindings === 0
    ? `Scanned ${result.scannedFiles.length} repository safety file${result.scannedFiles.length === 1 ? "" : "s"}. No findings.`
    : `Scanned ${result.scannedFiles.length} repository safety file${result.scannedFiles.length === 1 ? "" : "s"}. ${summary.highFindings} high, ${summary.mediumFindings} medium, ${summary.infoFindings} info findings.`;

  const sections = [headline];
  if (result.github.scannedFiles.length > 0) {
    sections.push("", "## .github Review", formatGithubMetadataScanResult(result.github));
  }
  if (result.config.scannedFiles.length > 0) {
    sections.push("", "## Workspace Config Review", formatWorkspaceConfigScanResult(result.config));
  }

  return sections.join("\n");
}