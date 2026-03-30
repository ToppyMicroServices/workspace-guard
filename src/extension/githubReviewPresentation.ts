import path from "node:path";

import type { GithubMetadataFinding, GithubMetadataScanResult } from "../core/githubMetadataScanner";
import type { GithubMetadataReviewSummary } from "./homeguardExtension";

export type GithubReviewTrustLevel = "safe" | "info-only" | "review-needed" | "high-risk";
export type GithubReviewSeverityFilter = "all" | "high" | "medium" | "info";

export function getGithubReviewTrustLevel(summary: GithubMetadataReviewSummary): GithubReviewTrustLevel {
  if (summary.totalFindings === 0) {
    return "safe";
  }

  if (summary.highFindings > 0) {
    return "high-risk";
  }

  if (summary.mediumFindings > 0) {
    return "review-needed";
  }

  return "info-only";
}

export function formatGithubTrustLabel(summary: GithubMetadataReviewSummary): string {
  switch (getGithubReviewTrustLevel(summary)) {
    case "safe":
      return "Safe";
    case "info-only":
      return "Info Only";
    case "review-needed":
      return "Review Needed";
    case "high-risk":
      return "High Risk";
  }
}

export function formatGithubMetadataSummary(summary: GithubMetadataReviewSummary): string {
  if (summary.totalFindings === 0) {
    return "Workspace Guard found no repository-trust risks in the current workspace.";
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

  return `Workspace Guard found ${summary.totalFindings} repository review finding${summary.totalFindings === 1 ? "" : "s"} across ${summary.workspaceFoldersWithRisk} workspace folder${summary.workspaceFoldersWithRisk === 1 ? "" : "s"} (${severityParts.join(", ")}).`;
}

export function filterGithubMetadataReport(
  report: GithubMetadataScanResult,
  filter: GithubReviewSeverityFilter
): GithubMetadataScanResult {
  if (filter === "all") {
    return report;
  }

  return {
    ...report,
    findings: report.findings.filter((finding) => finding.severity === filter)
  };
}

export function formatGithubMetadataWorkspaceSummary(
  report: GithubMetadataScanResult,
  filter: GithubReviewSeverityFilter = "all"
): string {
  const filteredReport = filterGithubMetadataReport(report, filter);

  if (report.scannedFiles.length === 0) {
    return "No reviewable repository files";
  }

  if (filteredReport.findings.length === 0) {
    return filter === "all" ? "No findings" : `No ${filter} findings`;
  }

  const counts = {
    high: filteredReport.findings.filter((finding) => finding.severity === "high").length,
    medium: filteredReport.findings.filter((finding) => finding.severity === "medium").length,
    info: filteredReport.findings.filter((finding) => finding.severity === "info").length
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

export function formatGithubMetadataReportsMarkdown(
  reports: GithubMetadataScanResult[],
  summary: GithubMetadataReviewSummary,
  filter: GithubReviewSeverityFilter = "all"
): string {
  const lines = [
    "# Workspace Guard Repository Review",
    "",
    `Trust: ${formatGithubTrustLabel(summary)}`,
    formatGithubMetadataSummary(summary),
    ""
  ];

  for (const report of reports.map((entry) => filterGithubMetadataReport(entry, filter))) {
    if (report.scannedFiles.length === 0) {
      continue;
    }

    lines.push(`## ${formatGithubMetadataWorkspaceLabel(report)}`);
    lines.push("");
    lines.push(`Path: \`${report.rootPath}\``);
    lines.push(`Summary: ${formatGithubMetadataWorkspaceSummary(report, filter)}`);
    lines.push("");

    if (report.findings.length === 0) {
      lines.push("No findings.", "");
      continue;
    }

    for (const finding of report.findings) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(`- [${finding.severity}] ${finding.id} \`${location}\``);
      lines.push(`  ${finding.message}`);
      lines.push(`  Suggested action: ${finding.suggestedAction}`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
