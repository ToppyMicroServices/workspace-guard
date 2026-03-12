import { promises as fs } from "node:fs";
import path from "node:path";

export type GithubMetadataFindingSeverity = "high" | "medium" | "info";
export type GithubMetadataFindingConfidence = "high" | "medium" | "low";

export interface GithubMetadataDirentLike {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

export interface GithubMetadataScannerFs {
  readdir: (
    targetPath: string,
    options: { withFileTypes: true }
  ) => Promise<GithubMetadataDirentLike[]>;
  readFile: (targetPath: string, encoding: BufferEncoding) => Promise<string>;
}

export interface GithubMetadataFinding {
  id: string;
  severity: GithubMetadataFindingSeverity;
  category: string;
  file: string;
  line?: number;
  reason: string;
  evidence: string;
  message: string;
  suggestedAction: string;
  confidence: GithubMetadataFindingConfidence;
}

export interface GithubMetadataScanResult {
  rootPath: string;
  scannedFiles: string[];
  findings: GithubMetadataFinding[];
}

const defaultFs: GithubMetadataScannerFs = {
  readdir: fs.readdir,
  readFile: async (targetPath, encoding) => await fs.readFile(targetPath, encoding)
};

const WORKFLOW_FILE_PATTERN = /^\.github\/workflows\/.+\.ya?ml$/i;
const DEPENDABOT_FILE_PATTERN = /^\.github\/dependabot\.ya?ml$/i;
const CODEOWNERS_FILE_PATTERN = /^\.github\/CODEOWNERS$/;
const ISSUE_TEMPLATE_FILE_PATTERN = /^\.github\/ISSUE_TEMPLATE\/.+/;
const PR_TEMPLATE_FILE_PATTERN = /^\.github\/PULL_REQUEST_TEMPLATE(?:\/.+|[^/]*)$/;
const WRITE_PERMISSION_PATTERN = /^\s*(contents|packages|actions|id-token)\s*:\s*write\s*$/i;
const USES_PATTERN = /^\s*-\s*uses:\s*["']?([^"'#\s]+)["']?|^\s*uses:\s*["']?([^"'#\s]+)["']?/i;
const SELF_HOSTED_PATTERN = /\bself-hosted\b/i;
const PULL_REQUEST_TARGET_PATTERN = /\bpull_request_target\b/;
const DANGEROUS_RUN_PATTERNS = [
  /\bcurl\b.+\|\s*(bash|sh)\b/i,
  /\bwget\b.+\|\s*(bash|sh)\b/i,
  /\bInvoke-WebRequest\b.+\|\s*(iex|pwsh|powershell)\b/i,
  /\bsudo\b/i,
  /\bchmod\s+\+x\b/i
];
const SECRET_ECHO_PATTERN = /\b(echo|printf)\b.+\${{\s*secrets\.[^}]+}}/i;
const TEMPLATE_SECRET_REQUEST_PATTERN = /\b(paste|attach|share|send|provide|include)\b.+\b(token|secret|password|credential|api[ -]?key|ssh key|private key|cookie)\b/i;
const TEMPLATE_COMMAND_PATTERN = /\b(curl|wget)\b.+\|\s*(bash|sh)\b|\bsudo\b|\bchmod\s+\+x\b/i;

function toRelativePath(rootPath: string, filePath: string): string {
  return path.relative(rootPath, filePath).split(path.sep).join("/");
}

function toLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function createFinding(
  file: string,
  line: number | undefined,
  finding: Omit<GithubMetadataFinding, "file" | "line">
): GithubMetadataFinding {
  return {
    ...finding,
    file,
    line
  };
}

function looksLikeFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function isPinnedActionReference(actionReference: string): boolean {
  const atIndex = actionReference.lastIndexOf("@");
  if (atIndex === -1) {
    return true;
  }

  return looksLikeFullCommitSha(actionReference.slice(atIndex + 1));
}

async function walkDirectory(
  fileSystem: GithubMetadataScannerFs,
  targetPath: string
): Promise<string[]> {
  let entries: GithubMetadataDirentLike[];

  try {
    entries = await fileSystem.readdir(targetPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const childPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      return await walkDirectory(fileSystem, childPath);
    }

    if (entry.isFile()) {
      return [childPath];
    }

    return [];
  }));

  return nestedFiles.flat();
}

function scanWorkflowFile(file: string, content: string): GithubMetadataFinding[] {
  const findings: GithubMetadataFinding[] = [];
  const lines = toLines(content);
  let pullRequestTargetLine: number | undefined;
  let checkoutLine: number | undefined;
  let prHeadCheckoutLine: number | undefined;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (PULL_REQUEST_TARGET_PATTERN.test(line) && !line.trimStart().startsWith("#")) {
      pullRequestTargetLine ??= lineNumber;
    }

    if (/^\s*permissions\s*:\s*write-all\s*$/i.test(line)) {
      findings.push(createFinding(file, lineNumber, {
        id: "WG-GHWF-001",
        severity: "high",
        category: "workflow-permissions",
        reason: "workflow grants write-all token permissions",
        evidence: line.trim(),
        message: "Workflow grants broad write permissions to GITHUB_TOKEN.",
        suggestedAction: "Replace write-all with per-job minimal permissions.",
        confidence: "high"
      }));
    }

    const permissionMatch = line.match(WRITE_PERMISSION_PATTERN);
    if (permissionMatch) {
      const permissionName = permissionMatch[1].toLowerCase();
      findings.push(createFinding(file, lineNumber, {
        id: permissionName === "id-token" ? "WG-GHWF-002" : "WG-GHWF-003",
        severity: permissionName === "id-token" ? "high" : "medium",
        category: "workflow-permissions",
        reason: `${permissionName} permission is granted with write access`,
        evidence: line.trim(),
        message: `Workflow grants ${permissionName}: write, which expands the impact of token misuse.`,
        suggestedAction: `Reduce ${permissionName} to read or remove it unless the job strictly requires write access.`,
        confidence: "high"
      }));
    }

    const usesMatch = line.match(USES_PATTERN);
    if (usesMatch) {
      const actionReference = usesMatch[1] ?? usesMatch[2];
      if (!actionReference) {
        return;
      }

      if (actionReference.startsWith("./") || actionReference.startsWith("docker://")) {
        return;
      }

      if (/^actions\/checkout@/i.test(actionReference)) {
        checkoutLine = lineNumber;
      }

      if (!isPinnedActionReference(actionReference)) {
        findings.push(createFinding(file, lineNumber, {
          id: "WG-GHWF-004",
          severity: "medium",
          category: "workflow-action-pin",
          reason: "workflow action is referenced by tag or branch instead of a full commit SHA",
          evidence: line.trim(),
          message: "GitHub Action reference is mutable and should be pinned to a full commit SHA.",
          suggestedAction: "Pin the action to a 40-character commit SHA and document update cadence.",
          confidence: "high"
        }));
      }
    }

    if (/github\.event\.pull_request\.head\.(sha|ref)/.test(line)) {
      prHeadCheckoutLine ??= lineNumber;
    }

    if ((/^\s*runs-on\s*:/i.test(line) || /^\s*-\s*self-hosted\s*$/i.test(line)) && SELF_HOSTED_PATTERN.test(line)) {
      findings.push(createFinding(file, lineNumber, {
        id: "WG-GHWF-005",
        severity: "high",
        category: "workflow-runner",
        reason: "workflow uses a self-hosted runner",
        evidence: line.trim(),
        message: "Self-hosted runners expand the trust boundary to runner-host assets and network access.",
        suggestedAction: "Prefer GitHub-hosted runners or isolate self-hosted runners behind strict segmentation.",
        confidence: "high"
      }));
    }

    if (DANGEROUS_RUN_PATTERNS.some((pattern) => pattern.test(line))) {
      findings.push(createFinding(file, lineNumber, {
        id: "WG-GHWF-006",
        severity: "high",
        category: "workflow-command",
        reason: "workflow run step includes a dangerous shell pattern",
        evidence: line.trim(),
        message: "Workflow run step executes a high-risk shell pattern that deserves manual review.",
        suggestedAction: "Remove external pipe-to-shell patterns and avoid privileged shell commands in CI jobs.",
        confidence: "medium"
      }));
    }

    if (SECRET_ECHO_PATTERN.test(line)) {
      findings.push(createFinding(file, lineNumber, {
        id: "WG-GHWF-007",
        severity: "high",
        category: "workflow-command",
        reason: "workflow prints a GitHub secret into shell output",
        evidence: line.trim(),
        message: "Workflow step may expose secrets through logs or downstream shell expansion.",
        suggestedAction: "Avoid echoing secrets and pass them only through masked environment bindings when necessary.",
        confidence: "high"
      }));
    }
  });

  if (pullRequestTargetLine) {
    findings.push(createFinding(file, pullRequestTargetLine, {
      id: "WG-GHWF-008",
      severity: "high",
      category: "workflow-trigger",
      reason: "workflow is triggered by pull_request_target",
      evidence: lines[pullRequestTargetLine - 1]?.trim() ?? "pull_request_target",
      message: "pull_request_target runs in a higher-trust context and must not process untrusted PR code.",
      suggestedAction: "Prefer pull_request, or keep pull_request_target workflows read-only and avoid untrusted checkout.",
      confidence: "high"
    }));
  }

  if (pullRequestTargetLine && checkoutLine && prHeadCheckoutLine) {
    findings.push(createFinding(file, prHeadCheckoutLine, {
      id: "WG-GHWF-009",
      severity: "high",
      category: "workflow-checkout",
      reason: "pull_request_target workflow checks out PR head code",
      evidence: lines[prHeadCheckoutLine - 1]?.trim() ?? "github.event.pull_request.head.ref",
      message: "This workflow combines pull_request_target with PR-head checkout, which can execute attacker-controlled code with elevated repository context.",
      suggestedAction: "Do not check out PR-head code in pull_request_target workflows; split trusted metadata tasks from untrusted code execution.",
      confidence: "high"
    }));
  }

  return findings;
}

function scanDependabotFile(file: string, content: string): GithubMetadataFinding[] {
  const lines = toLines(content);
  const findings: GithubMetadataFinding[] = [];

  lines.forEach((line, index) => {
    if (/^\s*insecure-external-code-execution\s*:\s*allow\s*$/i.test(line)) {
      findings.push(createFinding(file, index + 1, {
        id: "WG-GHDB-001",
        severity: "high",
        category: "dependabot-execution",
        reason: "dependabot allows insecure external code execution",
        evidence: line.trim(),
        message: "Dependabot is configured to allow insecure external code execution.",
        suggestedAction: "Disable insecure-external-code-execution unless there is a narrowly justified and documented need.",
        confidence: "high"
      }));
    }
  });

  return findings;
}

function scanCodeownersFile(file: string, content: string): GithubMetadataFinding[] {
  const lines = toLines(content);
  const catchAllLine = lines.findIndex((line) => /^\s*\*\s+\S+/.test(line));

  if (catchAllLine === -1) {
    return [];
  }

  return [createFinding(file, catchAllLine + 1, {
    id: "WG-GHCO-001",
    severity: "info",
    category: "review-routing",
    reason: "CODEOWNERS contains a repository-wide catch-all owner entry",
    evidence: lines[catchAllLine]?.trim() ?? "*",
    message: "Repository-wide CODEOWNERS entries affect who must review changes and should be audited as part of trust evaluation.",
    suggestedAction: "Review broad CODEOWNERS entries to confirm they reflect the intended approval path.",
    confidence: "high"
  })];
}

function scanTemplateFile(file: string, content: string): GithubMetadataFinding[] {
  const lines = toLines(content);
  const findings: GithubMetadataFinding[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (TEMPLATE_SECRET_REQUEST_PATTERN.test(line)) {
      findings.push(createFinding(file, lineNumber, {
        id: "WG-GHTM-001",
        severity: "medium",
        category: "template-social-engineering",
        reason: "template asks users to share secrets or credentials",
        evidence: line.trim(),
        message: "Template text asks contributors to provide sensitive credentials.",
        suggestedAction: "Remove requests for secrets and replace them with guidance to use secure private channels if absolutely necessary.",
        confidence: "high"
      }));
    }

    if (TEMPLATE_COMMAND_PATTERN.test(line)) {
      findings.push(createFinding(file, lineNumber, {
        id: "WG-GHTM-002",
        severity: "medium",
        category: "template-social-engineering",
        reason: "template instructs contributors to run a high-risk shell command",
        evidence: line.trim(),
        message: "Template text includes a command pattern that can be abused for social engineering.",
        suggestedAction: "Replace risky shell instructions with safer, reviewable manual steps.",
        confidence: "medium"
      }));
    }
  });

  return findings;
}

export async function scanGithubMetadata(
  rootPath: string,
  options: { fs?: GithubMetadataScannerFs } = {}
): Promise<GithubMetadataScanResult> {
  const fileSystem = options.fs ?? defaultFs;
  const githubFiles = await walkDirectory(fileSystem, path.join(rootPath, ".github"));
  const scannedFiles = githubFiles.map((filePath) => toRelativePath(rootPath, filePath)).sort();
  const findings: GithubMetadataFinding[] = [];

  for (const filePath of githubFiles) {
    const relativeFilePath = toRelativePath(rootPath, filePath);
    const content = await fileSystem.readFile(filePath, "utf8");

    if (WORKFLOW_FILE_PATTERN.test(relativeFilePath)) {
      findings.push(...scanWorkflowFile(relativeFilePath, content));
      continue;
    }

    if (DEPENDABOT_FILE_PATTERN.test(relativeFilePath)) {
      findings.push(...scanDependabotFile(relativeFilePath, content));
      continue;
    }

    if (CODEOWNERS_FILE_PATTERN.test(relativeFilePath)) {
      findings.push(...scanCodeownersFile(relativeFilePath, content));
      continue;
    }

    if (ISSUE_TEMPLATE_FILE_PATTERN.test(relativeFilePath) || PR_TEMPLATE_FILE_PATTERN.test(relativeFilePath)) {
      findings.push(...scanTemplateFile(relativeFilePath, content));
    }
  }

  findings.sort((left, right) => {
    if (left.file === right.file) {
      return (left.line ?? 0) - (right.line ?? 0);
    }

    return left.file.localeCompare(right.file);
  });

  return {
    rootPath,
    scannedFiles,
    findings
  };
}

export function formatGithubMetadataScanResult(result: GithubMetadataScanResult): string {
  if (result.findings.length === 0) {
    return "No .github findings detected.";
  }

  return result.findings.map((finding) => {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    return `[${finding.severity}] ${finding.id} ${location} ${finding.message}`;
  }).join("\n");
}
