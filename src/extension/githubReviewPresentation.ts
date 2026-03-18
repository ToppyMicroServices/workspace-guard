import path from "node:path";

import type { GithubMetadataFinding, GithubMetadataScanResult } from "../core/githubMetadataScanner";
import type { GithubMetadataReviewSummary } from "./homeguardExtension";

export function formatGithubMetadataSummary(summary: GithubMetadataReviewSummary): string {
  if (summary.totalFindings === 0) {
    return "Workspace Guard found no .github risks in the current workspace.";
  }

  const severityParts: string[] = [];
  if (summary.highFindings > 0) {
    severityParts.push(`${summary.highFindings} high`);
  }
  if (summary.mediumFindings > 0) {
    severityParts.push(`${summary.mediumFindings} medium`);
  }
  if (summary.infoFindings > 0) {
    severityParts.push(`${summary.infoFindings} info`);
  }

  return `Workspace Guard found ${summary.totalFindings} .github finding${summary.totalFindings === 1 ? "" : "s"} across ${summary.workspaceFoldersWithRisk} workspace folder${summary.workspaceFoldersWithRisk === 1 ? "" : "s"} (${severityParts.join(", ")}).`;
}

export function formatGithubMetadataWorkspaceSummary(report: GithubMetadataScanResult): string {
  if (report.scannedFiles.length === 0) {
    return "No .github files";
  }

  if (report.findings.length === 0) {
    return "No findings";
  }

  const counts = {
    high: report.findings.filter((finding) => finding.severity === "high").length,
    medium: report.findings.filter((finding) => finding.severity === "medium").length,
    info: report.findings.filter((finding) => finding.severity === "info").length
  };
  const parts = [
    counts.high > 0 ? `${counts.high} high` : "",
    counts.medium > 0 ? `${counts.medium} medium` : "",
    counts.info > 0 ? `${counts.info} info` : ""
  ].filter(Boolean);

  return parts.join(", ");
}

export function formatGithubMetadataWorkspaceLabel(report: GithubMetadataScanResult): string {
  return path.basename(report.rootPath) || report.rootPath;
}

export function formatGithubFindingDescription(finding: GithubMetadataFinding): string {
  const linePart = finding.line ? `line ${finding.line}` : "no line";
  return `${finding.severity.toUpperCase()} · ${linePart}`;
}

export function formatGithubFindingTooltip(finding: GithubMetadataFinding): string {
  return [
    `${finding.id} (${finding.severity})`,
    finding.message,
    `Reason: ${finding.reason}`,
    `Action: ${finding.suggestedAction}`
  ].join("\n");
}
