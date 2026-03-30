import { describe, expect, it } from "vitest";

import type { GithubMetadataScanResult } from "../src";
import { summarizeGithubMetadataReports } from "../src";
import {
  filterGithubMetadataReport,
  formatGithubFindingDescription,
  formatGithubFindingTooltip,
  formatGithubMetadataReportsMarkdown,
  formatGithubMetadataSummary,
  formatGithubTrustLabel,
  getGithubReviewTrustLevel,
  formatGithubMetadataWorkspaceLabel,
  formatGithubMetadataWorkspaceSummary
} from "../src/extension/githubReviewPresentation";

function createReport(): GithubMetadataScanResult {
  return {
    rootPath: "/tmp/demo-repo",
    scannedFiles: [".github/workflows/release.yml"],
    findings: [
      {
        id: "WG-GHWF-001",
        severity: "high",
        category: "workflow",
        file: ".github/workflows/release.yml",
        line: 7,
        reason: "workflow uses pull_request_target",
        evidence: "pull_request_target",
        message: "pull_request_target is risky here.",
        suggestedAction: "Use pull_request instead.",
        confidence: "high"
      },
      {
        id: "WG-GHWF-010",
        severity: "info",
        category: "workflow",
        file: ".github/workflows/release.yml",
        line: 1,
        reason: "permissions missing",
        evidence: "permissions:",
        message: "permissions are implicit.",
        suggestedAction: "Declare least-privilege permissions.",
        confidence: "medium"
      }
    ]
  };
}

describe("githubReviewPresentation", () => {
  it("formats summary and workspace labels for the tree view", () => {
    const report = createReport();
    const summary = summarizeGithubMetadataReports([report]);

    expect(formatGithubMetadataSummary(summary)).toContain("2 repository review findings");
    expect(getGithubReviewTrustLevel(summary)).toBe("high-risk");
    expect(formatGithubTrustLabel(summary)).toBe("High Risk");
    expect(formatGithubMetadataWorkspaceLabel(report)).toBe("demo-repo");
    expect(formatGithubMetadataWorkspaceSummary(report)).toBe("1 high, 1 info");
  });

  it("formats finding descriptions and tooltips", () => {
    const finding = createReport().findings[0];

    expect(formatGithubFindingDescription(finding)).toBe("HIGH · line 7");
    expect(formatGithubFindingTooltip(finding)).toContain("Use pull_request instead.");
  });

  it("shows a clean message when there are no findings", () => {
    const report: GithubMetadataScanResult = {
      rootPath: "/tmp/clean",
      scannedFiles: [".github/workflows/ci.yml"],
      findings: []
    };
    const summary = summarizeGithubMetadataReports([report]);

    expect(formatGithubMetadataSummary(summary)).toBe("Workspace Guard found no repository-trust risks in the current workspace.");
    expect(formatGithubMetadataWorkspaceSummary(report)).toBe("No findings");
  });

  it("filters report findings by severity", () => {
    const report = createReport();
    const filtered = filterGithubMetadataReport(report, "high");

    expect(filtered.findings).toHaveLength(1);
    expect(formatGithubMetadataWorkspaceSummary(filtered, "high")).toBe("1 high");
  });

  it("formats review export markdown", () => {
    const report = createReport();
    const summary = summarizeGithubMetadataReports([report]);
    const markdown = formatGithubMetadataReportsMarkdown([report], summary, "all");

    expect(markdown).toContain("# Workspace Guard Repository Review");
    expect(markdown).toContain("Trust: High Risk");
    expect(markdown).toContain("Suggested action: Use pull_request instead.");
  });
});
