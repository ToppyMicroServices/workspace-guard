import type { GithubMetadataFinding } from "../core/githubMetadataScanner";

export interface GithubFindingRemediation {
  title: string;
  summary: string;
  steps: string[];
  snippet?: string;
}

function createPermissionsRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  return {
    title: "Tighten GitHub token permissions",
    summary: finding.suggestedAction,
    steps: [
      "Declare permissions explicitly at workflow or job scope.",
      "Keep only the scopes the job actually needs.",
      "Use read access by default and grant write only to the single job that requires it."
    ],
    snippet: `permissions:
  contents: read`
  };
}

function createActionPinRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  return {
    title: "Pin mutable action references",
    summary: finding.suggestedAction,
    steps: [
      "Replace branch or tag references with a full 40-character commit SHA.",
      "Document how the dependency is reviewed and updated.",
      "If the reference is external and reusable, audit the callee revision before trusting it."
    ],
    snippet: `- uses: actions/checkout@<40-character-commit-sha>`
  };
}

function createPullRequestTargetRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  return {
    title: "Split trusted metadata handling from untrusted PR code",
    summary: finding.suggestedAction,
    steps: [
      "Prefer pull_request for workflows that build or test PR code.",
      "Keep pull_request_target only for metadata-only jobs such as labels or comments.",
      "Do not checkout PR head refs in a privileged workflow."
    ],
    snippet: `on:
  pull_request:

permissions:
  contents: read`
  };
}

function createDangerousRunRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  return {
    title: "Replace risky shell execution with reviewed commands",
    summary: finding.suggestedAction,
    steps: [
      "Move complex logic into a checked-in script that can be reviewed in the repository.",
      "Avoid pipe-to-shell, encoded payloads, and eval-style execution.",
      "Validate any user-controlled values before they reach shell execution."
    ],
    snippet: `- run: ./scripts/ci-safe-step.sh`
  };
}

function createSecretInheritanceRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  return {
    title: "Pass only the secrets the callee needs",
    summary: finding.suggestedAction,
    steps: [
      "Replace secrets: inherit with an explicit secret map.",
      "Pass the minimum required secret names only.",
      "Keep reusable workflow interfaces narrow and documented."
    ],
    snippet: `secrets:
  deployment_token: \${{ secrets.DEPLOYMENT_TOKEN }}`
  };
}

function createSelfHostedRunnerRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  return {
    title: "Reduce runner trust exposure",
    summary: finding.suggestedAction,
    steps: [
      "Prefer GitHub-hosted runners for untrusted repository content.",
      "If self-hosted runners are required, isolate them from sensitive networks and credentials.",
      "Separate privileged deploy jobs from code that processes untrusted inputs."
    ]
  };
}

function createDependabotRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  return {
    title: "Disable insecure external code execution",
    summary: finding.suggestedAction,
    steps: [
      "Remove insecure-external-code-execution: allow unless there is a narrow documented exception.",
      "Keep registry credentials scoped and avoid handing execution to external dependency hooks.",
      "Review whether this repository actually needs external code execution in dependency updates."
    ],
    snippet: `updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly`
  };
}

function createTemplateRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  return {
    title: "Remove unsafe contributor instructions",
    summary: finding.suggestedAction,
    steps: [
      "Replace risky commands with safer manual steps or links to reviewed documentation.",
      "Do not ask contributors to paste secrets, tokens, or private keys into templates.",
      "Route sensitive troubleshooting through private support channels if it is ever needed."
    ]
  };
}

function createWorkspaceExecutionRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  return {
    title: "Review workspace execution surfaces before trusting this repository",
    summary: finding.suggestedAction,
    steps: [
      "Treat .vscode/settings.json, tasks.json, launch.json, and .code-workspace files like executable code review inputs.",
      "Keep automatic task execution and shell-based helpers disabled until the repository is approved.",
      "Prefer Restricted Mode and narrow allowlists for workspace-recommended extensions."
    ]
  };
}

function createExtensionAllowlistRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  return {
    title: "Restrict workspace extension recommendations to the approved allowlist",
    summary: finding.suggestedAction,
    steps: [
      "Remove extension recommendations that are not explicitly approved.",
      "For LaTeX workspaces, keep recommendations limited to the approved secure LaTeX extension set.",
      "Require manual approval before installing any additional Marketplace extensions."
    ],
    snippet: `{
  "recommendations": [
    "LaTeX-Secure-Workspace"
  ]
}`
  };
}

function createDefaultRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  return {
    title: "Review and remediate this finding",
    summary: finding.suggestedAction,
    steps: [
      "Read the file around the flagged line to confirm the exact behavior.",
      "Apply the suggested action in the least-privilege direction.",
      "Re-run the .github review after editing to confirm the finding is gone."
    ]
  };
}

export function buildGithubFindingRemediation(finding: GithubMetadataFinding): GithubFindingRemediation {
  switch (finding.id) {
    case "WG-GHWF-001":
    case "WG-GHWF-002":
    case "WG-GHWF-003":
    case "WG-GHWF-010":
      return createPermissionsRemediation(finding);
    case "WG-GHWF-004":
    case "WG-GHWF-016":
    case "WG-GHWF-017":
      return createActionPinRemediation(finding);
    case "WG-GHWF-005":
      return createSelfHostedRunnerRemediation(finding);
    case "WG-GHWF-006":
    case "WG-GHWF-007":
    case "WG-GHWF-011":
    case "WG-GHWF-018":
    case "WG-GHWF-019":
      return createDangerousRunRemediation(finding);
    case "WG-GHWF-008":
    case "WG-GHWF-009":
      return createPullRequestTargetRemediation(finding);
    case "WG-GHWF-015":
      return createSecretInheritanceRemediation(finding);
    case "WG-GHDB-001":
      return createDependabotRemediation(finding);
    case "WG-GHTM-001":
    case "WG-GHTM-002":
      return createTemplateRemediation(finding);
    case "WG-WS-001":
    case "WG-WS-002":
    case "WG-WS-003":
    case "WG-WS-004":
    case "WG-WS-007":
      return createWorkspaceExecutionRemediation(finding);
    case "WG-WS-005":
    case "WG-WS-006":
      return createExtensionAllowlistRemediation(finding);
    default:
      return createDefaultRemediation(finding);
  }
}

export function formatGithubFindingRemediationMarkdown(finding: GithubMetadataFinding): string {
  const remediation = buildGithubFindingRemediation(finding);
  const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
  const lines = [
    `# ${remediation.title}`,
    "",
    `Finding: \`${finding.id}\``,
    `Location: \`${location}\``,
    "",
    `## Why This Was Flagged`,
    finding.message,
    "",
    `Reason: ${finding.reason}`,
    "",
    `## Suggested Action`,
    remediation.summary,
    "",
    `## Recommended Playbook`,
    ...remediation.steps.map((step, index) => `${index + 1}. ${step}`)
  ];

  if (remediation.snippet) {
    lines.push("", "## Example", "```yaml", remediation.snippet, "```");
  }

  return lines.join("\n");
}

export function getGithubFindingRemediationSnippet(finding: GithubMetadataFinding): string | undefined {
  return buildGithubFindingRemediation(finding).snippet;
}
