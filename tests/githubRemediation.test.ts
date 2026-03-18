import { describe, expect, it } from "vitest";

import type { GithubMetadataFinding } from "../src";
import {
  buildGithubFindingRemediation,
  formatGithubFindingRemediationMarkdown
} from "../src/extension/githubRemediation";

function createFinding(id: string, suggestedAction: string): GithubMetadataFinding {
  return {
    id,
    severity: "high",
    category: "workflow",
    file: ".github/workflows/release.yml",
    line: 12,
    reason: "test finding",
    evidence: "test",
    message: "workflow needs review",
    suggestedAction,
    confidence: "high"
  };
}

describe("githubRemediation", () => {
  it("builds targeted remediation for pull_request_target findings", () => {
    const remediation = buildGithubFindingRemediation(
      createFinding("WG-GHWF-008", "Prefer pull_request.")
    );

    expect(remediation.title).toContain("Split trusted metadata");
    expect(remediation.snippet).toContain("pull_request");
  });

  it("builds targeted remediation for permissions findings", () => {
    const remediation = buildGithubFindingRemediation(
      createFinding("WG-GHWF-003", "Reduce contents to read.")
    );

    expect(remediation.title).toContain("token permissions");
    expect(remediation.snippet).toContain("contents: read");
  });

  it("formats a remediation guide as markdown", () => {
    const markdown = formatGithubFindingRemediationMarkdown(
      createFinding("WG-GHWF-015", "Pass only specific secrets.")
    );

    expect(markdown).toContain("# Pass only the secrets the callee needs");
    expect(markdown).toContain("Suggested Action");
    expect(markdown).toContain("```yaml");
  });
});
