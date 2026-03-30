import { promises as fs } from "node:fs";
import https from "node:https";
import path from "node:path";
import { parseDocument } from "yaml";

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

export interface GithubMetadataResolvedWorkflow {
  file: string;
  content: string;
}

export interface GithubMetadataExternalWorkflowResolver {
  resolve: (reference: string) => Promise<GithubMetadataResolvedWorkflow | undefined>;
}

export interface GithubMetadataScanOptions {
  fs?: GithubMetadataScannerFs;
  resolveExternalWorkflows?: boolean;
  externalWorkflowResolver?: GithubMetadataExternalWorkflowResolver;
  allowedExtensionIds?: string[];
  recommendedLatexExtensionIds?: string[];
}

type YamlObject = Record<string, unknown>;
type GithubPermissions = Record<string, unknown>;
type TaintedExpressionMap = Map<string, string>;

interface WorkflowTriggerSummary {
  names: Set<string>;
}

interface WorkflowContext {
  file: string;
  lines: string[];
  data: YamlObject;
  triggers: WorkflowTriggerSummary;
}

interface ExternalReusableWorkflowReference {
  owner: string;
  repo: string;
  workflowPath: string;
  ref: string;
}

interface WorkflowResolutionContext {
  workflowContents: ReadonlyMap<string, string>;
  resolveExternalWorkflows: boolean;
  externalWorkflowResolver?: GithubMetadataExternalWorkflowResolver;
  resolvedExternalWorkflowCache: Map<string, GithubMetadataResolvedWorkflow | null>;
  resolvedExternalFiles: Set<string>;
}

type TaintedEnvMap = Map<string, string>;

const defaultFs: GithubMetadataScannerFs = {
  readdir: fs.readdir,
  readFile: async (targetPath, encoding) => await fs.readFile(targetPath, encoding)
};

const WORKFLOW_FILE_PATTERN = /^\.github\/workflows\/.+\.ya?ml$/i;
const DEPENDABOT_FILE_PATTERN = /^\.github\/dependabot\.ya?ml$/i;
const CODEOWNERS_FILE_PATTERN = /^\.github\/CODEOWNERS$/;
const ISSUE_TEMPLATE_FILE_PATTERN = /^\.github\/ISSUE_TEMPLATE\/.+/;
const PR_TEMPLATE_FILE_PATTERN = /^\.github\/PULL_REQUEST_TEMPLATE(?:\/.+|[^/]*)$/;
const VSCODE_SETTINGS_FILE_PATTERN = /^\.vscode\/settings\.json$/i;
const VSCODE_TASKS_FILE_PATTERN = /^\.vscode\/tasks\.json$/i;
const VSCODE_LAUNCH_FILE_PATTERN = /^\.vscode\/launch\.json$/i;
const VSCODE_EXTENSIONS_FILE_PATTERN = /^\.vscode\/extensions\.json$/i;
const CODE_WORKSPACE_FILE_PATTERN = /(^|\/)[^/]+\.code-workspace$/i;
const LATEX_INPUT_FILE_PATTERN = /\.(tex|bib|cls|sty)$/i;
const CODEQL_ACTION_PATTERN = /^github\/codeql-action\/analyze@/i;
const EXTERNAL_REUSABLE_WORKFLOW_PATTERN = /^[^./][^@]+\/\.github\/workflows\/[^@]+@/i;
const IGNORED_WORKSPACE_DIRS = new Set([".git", ".beads", "node_modules", "dist", "out", "build", ".next", ".venv", "vendor"]);
const DEFAULT_ALLOWED_EXTENSION_IDS = ["ToppyMicroServices.workspace-guard", "LaTeX-Secure-Workspace"];
const DEFAULT_RECOMMENDED_LATEX_EXTENSION_IDS = ["LaTeX-Secure-Workspace"];
const RISKY_WRITE_PERMISSION_SEVERITY: Record<string, GithubMetadataFindingSeverity> = {
  "actions": "high",
  "attestations": "medium",
  "contents": "medium",
  "deployments": "medium",
  "id-token": "high",
  "issues": "medium",
  "packages": "medium",
  "pages": "medium",
  "pull-requests": "medium",
  "statuses": "medium"
};
const DANGEROUS_RUN_PATTERNS = [
  /\bcurl\b.+\|\s*(bash|sh)\b/i,
  /\bwget\b.+\|\s*(bash|sh)\b/i,
  /\bInvoke-WebRequest\b.+\|\s*(iex|pwsh|powershell)\b/i,
  /\birm\b.+\|\s*(iex|pwsh|powershell)\b/i,
  /\b(?:bash|sh)\s+-c\s+["'`$].*(?:curl|wget|Invoke-WebRequest|irm).*/i,
  /\beval\s+["'`$].*(?:curl|wget|Invoke-WebRequest|irm).*/i,
  /\bbash\s+<\(/i,
  /\bsource\s+<\(/i,
  /\bbase64\b[^\n]*(?:-d|--decode)[^\n]*\|\s*(?:bash|sh|pwsh|powershell)\b/i,
  /\bcertutil\b[^\n]*-decode\b/i,
  /\b(?:powershell|pwsh)\b[^\n]*-(?:EncodedCommand|enc)\b/i,
  /\bFromBase64String\b/i,
  /\bpython(?:3)?\b[^\n]*-c[^\n]*\b(exec|eval)\s*\(/i,
  /\bnode\b[^\n]*-(?:e|p)\b[^\n]*\b(?:eval|Function)\s*\(/i,
  /\bsudo\b/i,
  /\bchmod\s+\+x\b/i
];
const SECRET_ECHO_PATTERN = /\b(echo|printf)\b.+\${{\s*secrets\.[^}]+}}/i;
const TEMPLATE_SECRET_REQUEST_PATTERN = /\b(paste|attach|share|send|provide|include)\b.+\b(token|secret|password|credential|api[ -]?key|ssh key|private key|cookie)\b/i;
const TEMPLATE_COMMAND_PATTERN = /\b(curl|wget)\b.+\|\s*(bash|sh)\b|\bsudo\b|\bchmod\s+\+x\b/i;
const DIRECT_USER_CONTROLLED_EXPRESSION_PATTERN = /\${{\s*(github\.event\.(pull_request|issue|comment|discussion|review|head_commit)|github\.head_ref|github\.event\.inputs)/i;
const EXECUTION_SINK_KEYS = new Set(["script", "command", "args", "entrypoint", "ref", "repository"]);
const RISKY_EXTENSION_PATTERN = /(shell|command|task|terminal|runner|code[- ]runner|script|executor|automation)/i;
const RISKY_SETTINGS_KEY_PATTERN = /^(code-runner\.|command-runner\.|task\.allowAutomaticTasks$|terminal\.integrated\.(shell|profiles|defaultProfile)|latex-workshop\.latex\.(tools|recipes|autoBuild))/i;

function toRelativePath(rootPath: string, filePath: string): string {
  return path.relative(rootPath, filePath).split(path.sep).join("/");
}

function toLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function isObject(value: unknown): value is YamlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
      if (IGNORED_WORKSPACE_DIRS.has(entry.name)) {
        return [];
      }
      return await walkDirectory(fileSystem, childPath);
    }

    if (entry.isFile()) {
      return [childPath];
    }

    return [];
  }));

  return nestedFiles.flat();
}

function findLineNumber(lines: string[], pattern: RegExp | string): number | undefined {
  const matcher = typeof pattern === "string"
    ? (line: string) => line.includes(pattern)
    : (line: string) => pattern.test(line);
  const index = lines.findIndex((line) => matcher(line));
  return index === -1 ? undefined : index + 1;
}

function findLineText(lines: string[], pattern: RegExp | string): string {
  const lineNumber = findLineNumber(lines, pattern);
  return lineNumber ? (lines[lineNumber - 1]?.trim() ?? "") : (typeof pattern === "string" ? pattern : pattern.source);
}

function mergeTaintedEnv(...maps: TaintedEnvMap[]): TaintedEnvMap {
  const merged = new Map<string, string>();
  for (const map of maps) {
    for (const [key, value] of map.entries()) {
      merged.set(key, value);
    }
  }

  return merged;
}

function mergeTaintedExpressions(...maps: TaintedExpressionMap[]): TaintedExpressionMap {
  const merged = new Map<string, string>();
  for (const map of maps) {
    for (const [key, value] of map.entries()) {
      merged.set(key, value);
    }
  }

  return merged;
}

function buildExpressionReferencePattern(expressionPath: string): RegExp {
  const escapedExpressionPath = expressionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\$\\{\\{\\s*${escapedExpressionPath}\\s*\\}\\}`, "i");
}

function findTaintedExpressionReference(
  value: string,
  taintedExpressions: TaintedExpressionMap
): [string, string] | undefined {
  if (DIRECT_USER_CONTROLLED_EXPRESSION_PATTERN.test(value)) {
    return ["github.event", value];
  }

  for (const [expressionPath, source] of taintedExpressions.entries()) {
    if (buildExpressionReferencePattern(expressionPath).test(value)) {
      return [expressionPath, source];
    }
  }

  return undefined;
}

function collectWorkflowInputTaints(context: WorkflowContext): TaintedExpressionMap {
  const tainted = new Map<string, string>();
  if (!context.triggers.names.has("workflow_dispatch")) {
    return tainted;
  }

  const triggerConfig = isObject(context.data.on) ? context.data.on.workflow_dispatch : undefined;
  if (!isObject(triggerConfig) || !isObject(triggerConfig.inputs)) {
    return tainted;
  }

  for (const inputName of Object.keys(triggerConfig.inputs)) {
    tainted.set(`inputs.${inputName}`, `workflow_dispatch input ${inputName}`);
  }

  return tainted;
}

function collectTaintedEnv(env: unknown, taintedExpressions: TaintedExpressionMap): TaintedEnvMap {
  const tainted = new Map<string, string>();
  if (!isObject(env)) {
    return tainted;
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      continue;
    }

    const taintedReference = findTaintedExpressionReference(value, taintedExpressions);
    if (taintedReference) {
      tainted.set(key, taintedReference[1]);
    }
  }

  return tainted;
}

function findReferencedTaintedEnv(runValue: string, taintedEnv: TaintedEnvMap): [string, string] | undefined {
  for (const [key, source] of taintedEnv.entries()) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\$(?:env:)?${escapedKey}\\b|\\$\\{${escapedKey}\\}`, "i");
    if (pattern.test(runValue)) {
      return [key, source];
    }
  }

  return undefined;
}

function collectTaintedWithInputs(
  withValue: unknown,
  taintedExpressions: TaintedExpressionMap
): TaintedExpressionMap {
  const tainted = new Map<string, string>();
  if (!isObject(withValue)) {
    return tainted;
  }

  for (const [key, value] of Object.entries(withValue)) {
    if (typeof value !== "string") {
      continue;
    }

    const taintedReference = findTaintedExpressionReference(value, taintedExpressions);
    if (taintedReference) {
      tainted.set(`inputs.${key}`, taintedReference[1]);
    }
  }

  return tainted;
}

function extractTaintedFileCommandAssignments(
  runValue: string,
  targetVariableName: "GITHUB_ENV" | "GITHUB_OUTPUT",
  taintedExpressions: TaintedExpressionMap,
  taintedEnv: TaintedEnvMap
): Map<string, string> {
  const assignments = new Map<string, string>();

  for (const line of runValue.split(/\r?\n/)) {
    if (!new RegExp(`\\b${targetVariableName}\\b`).test(line)) {
      continue;
    }

    const quotedAssignment = line.match(/["']([A-Za-z_][A-Za-z0-9_-]*)=(.+?)["']/);
    const plainAssignment = line.match(/\b([A-Za-z_][A-Za-z0-9_-]*)=([^>\n|]+)(?:>>|\|\s*tee\b)/);
    const assignment = quotedAssignment ?? plainAssignment;
    if (!assignment) {
      continue;
    }

    const [, key, rawValue] = assignment;
    const taintedExpression = findTaintedExpressionReference(rawValue, taintedExpressions);
    if (taintedExpression) {
      assignments.set(key, taintedExpression[1]);
      continue;
    }

    const taintedEnvReference = findReferencedTaintedEnv(rawValue, taintedEnv);
    if (taintedEnvReference) {
      assignments.set(key, taintedEnvReference[1]);
    }
  }

  return assignments;
}

function collectJobDerivedStepTaints(
  context: WorkflowContext,
  jobValue: YamlObject,
  taintedExpressions: TaintedExpressionMap,
  inheritedTaintedEnv: TaintedEnvMap
): { jobTaintedEnv: TaintedEnvMap; stepOutputTaints: TaintedExpressionMap } {
  let jobTaintedEnv = mergeTaintedEnv(
    inheritedTaintedEnv,
    collectTaintedEnv(jobValue.env, taintedExpressions)
  );
  const stepOutputTaints = new Map<string, string>();

  for (const step of asArray(jobValue.steps)) {
    if (!isObject(step)) {
      continue;
    }

    const stepTaintedEnv = mergeTaintedEnv(jobTaintedEnv, collectTaintedEnv(step.env, taintedExpressions));
    const runValue = asString(step.run);
    if (!runValue) {
      continue;
    }

    const taintedEnvAssignments = extractTaintedFileCommandAssignments(
      runValue,
      "GITHUB_ENV",
      taintedExpressions,
      stepTaintedEnv
    );
    if (taintedEnvAssignments.size > 0) {
      jobTaintedEnv = mergeTaintedEnv(jobTaintedEnv, taintedEnvAssignments);
    }

    const stepId = asString(step.id);
    if (!stepId) {
      continue;
    }

    const taintedOutputAssignments = extractTaintedFileCommandAssignments(
      runValue,
      "GITHUB_OUTPUT",
      taintedExpressions,
      mergeTaintedEnv(stepTaintedEnv, taintedEnvAssignments)
    );
    for (const [outputName, source] of taintedOutputAssignments.entries()) {
      stepOutputTaints.set(`steps.${stepId}.outputs.${outputName}`, source);
    }
  }

  return {
    jobTaintedEnv,
    stepOutputTaints
  };
}

function collectWorkflowJobOutputTaints(
  context: WorkflowContext,
  baseTaintedExpressions: TaintedExpressionMap
): TaintedExpressionMap {
  const jobs = isObject(context.data.jobs) ? context.data.jobs : {};
  let jobOutputTaints = new Map<string, string>();
  const workflowBaseTaintedEnv = collectTaintedEnv(context.data.env, baseTaintedExpressions);

  for (let iteration = 0; iteration < Math.max(1, Object.keys(jobs).length); iteration += 1) {
    const combinedTaintedExpressions = mergeTaintedExpressions(baseTaintedExpressions, jobOutputTaints);
    const nextJobOutputTaints = new Map(jobOutputTaints);

    for (const [jobName, jobValue] of Object.entries(jobs)) {
      if (!isObject(jobValue)) {
        continue;
      }

      const stepDerivedTaints = collectJobDerivedStepTaints(
        context,
        jobValue,
        combinedTaintedExpressions,
        workflowBaseTaintedEnv
      );
      const jobOutputs = isObject(jobValue.outputs) ? jobValue.outputs : {};
      const outputTaintedExpressions = mergeTaintedExpressions(combinedTaintedExpressions, stepDerivedTaints.stepOutputTaints);

      for (const [outputName, outputValue] of Object.entries(jobOutputs)) {
        if (typeof outputValue !== "string") {
          continue;
        }

        const taintedReference = findTaintedExpressionReference(outputValue, outputTaintedExpressions);
        if (taintedReference) {
          nextJobOutputTaints.set(`needs.${jobName}.outputs.${outputName}`, taintedReference[1]);
        }
      }
    }

    const changed = nextJobOutputTaints.size !== jobOutputTaints.size
      || Array.from(nextJobOutputTaints.entries()).some(([key, value]) => jobOutputTaints.get(key) !== value);
    if (!changed) {
      jobOutputTaints = nextJobOutputTaints;
      break;
    }

    jobOutputTaints = nextJobOutputTaints;
  }

  return jobOutputTaints;
}

function normalizeWorkflowTriggers(value: unknown): WorkflowTriggerSummary {
  if (typeof value === "string") {
    return {
      names: new Set([value])
    };
  }

  if (Array.isArray(value)) {
    return {
      names: new Set(value.flatMap((entry) => typeof entry === "string" ? [entry] : []))
    };
  }

  if (isObject(value)) {
    return {
      names: new Set(Object.keys(value))
    };
  }

  return {
    names: new Set()
  };
}

function parseExternalReusableWorkflowReference(reference: string): ExternalReusableWorkflowReference | undefined {
  const match = reference.match(/^([^/]+)\/([^/]+)\/(.+?)@([^@]+)$/);
  if (!match) {
    return undefined;
  }

  const [, owner, repo, workflowPath, ref] = match;
  if (!workflowPath.startsWith(".github/workflows/")) {
    return undefined;
  }

  return {
    owner,
    repo,
    workflowPath,
    ref
  };
}

function fetchHttpsText(url: string, headers: Record<string, string>): Promise<string | undefined> {
  return new Promise((resolve) => {
    const request = https.get(url, {
      headers
    }, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        response.resume();
        resolve(undefined);
        return;
      }

      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });

    request.on("error", () => resolve(undefined));
  });
}

function createDefaultExternalWorkflowResolver(): GithubMetadataExternalWorkflowResolver {
  return {
    resolve: async (reference: string) => {
      const parsedReference = parseExternalReusableWorkflowReference(reference);
      if (!parsedReference) {
        return undefined;
      }

      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      const url = `https://raw.githubusercontent.com/${parsedReference.owner}/${parsedReference.repo}/${parsedReference.ref}/${parsedReference.workflowPath}`;
      const headers: Record<string, string> = {
        "Accept": "application/vnd.github.raw",
        "User-Agent": "workspace-guard"
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const content = await fetchHttpsText(url, headers);
      if (!content) {
        return undefined;
      }

      return {
        file: `external:${reference}`,
        content
      };
    }
  };
}

function buildWorkflowContext(file: string, content: string): WorkflowContext {
  const lines = toLines(content);
  const document = parseDocument(content, {
    prettyErrors: false,
    strict: false
  });
  const data = document.toJS({ maxAliasCount: 50 }) as unknown;

  if (document.errors.length > 0 || !isObject(data)) {
    return {
      file,
      lines,
      data: {},
      triggers: { names: new Set() }
    };
  }

  return {
    file,
    lines,
    data,
    triggers: normalizeWorkflowTriggers(data.on)
  };
}

function collectWorkflowParseFindings(file: string, content: string): GithubMetadataFinding[] {
  const document = parseDocument(content, {
    prettyErrors: false,
    strict: false
  });

  return document.errors.map((error) => {
    const line = typeof error.linePos?.[0]?.line === "number" ? error.linePos[0].line : undefined;
    return createFinding(file, line, {
      id: "WG-GHWF-000",
      severity: "medium",
      category: "workflow-parse",
      reason: "workflow YAML could not be parsed reliably",
      evidence: error.message,
      message: "Workflow file has YAML parse errors, so automated review is incomplete.",
      suggestedAction: "Fix YAML syntax before trusting the workflow.",
      confidence: "high"
    });
  });
}

function scanPermissions(
  context: WorkflowContext,
  permissions: unknown,
  scopeLabel: string,
  actionReferences: string[]
): GithubMetadataFinding[] {
  const findings: GithubMetadataFinding[] = [];

  if (permissions === undefined) {
    findings.push(createFinding(context.file, findLineNumber(context.lines, /^\s*permissions\s*:/i), {
      id: "WG-GHWF-010",
      severity: "info",
      category: "workflow-permissions",
      reason: `${scopeLabel} does not declare explicit token permissions`,
      evidence: scopeLabel,
      message: `${scopeLabel} omits explicit permissions, so token scope depends on repository defaults.`,
      suggestedAction: "Declare minimal permissions explicitly at workflow or job scope.",
      confidence: "medium"
    }));
    return findings;
  }

  if (typeof permissions === "string") {
    if (permissions === "write-all") {
      findings.push(createFinding(context.file, findLineNumber(context.lines, /^\s*permissions\s*:\s*write-all\s*$/i), {
        id: "WG-GHWF-001",
        severity: "high",
        category: "workflow-permissions",
        reason: `${scopeLabel} grants write-all token permissions`,
        evidence: "permissions: write-all",
        message: `${scopeLabel} grants broad write permissions to GITHUB_TOKEN.`,
        suggestedAction: "Replace write-all with per-job minimal permissions.",
        confidence: "high"
      }));
    }

    return findings;
  }

  if (!isObject(permissions)) {
    return findings;
  }

  for (const [permissionName, permissionValue] of Object.entries(permissions as GithubPermissions)) {
    if (permissionValue !== "write") {
      continue;
    }

    if (permissionName === "security-events" && actionReferences.some((entry) => CODEQL_ACTION_PATTERN.test(entry))) {
      continue;
    }

    const severity = RISKY_WRITE_PERMISSION_SEVERITY[permissionName];
    if (!severity) {
      continue;
    }

    findings.push(createFinding(context.file, findLineNumber(context.lines, new RegExp(`^\\s*${permissionName}\\s*:\\s*write\\s*$`, "i")), {
      id: permissionName === "id-token" ? "WG-GHWF-002" : "WG-GHWF-003",
      severity,
      category: "workflow-permissions",
      reason: `${scopeLabel} grants ${permissionName}: write`,
      evidence: `${permissionName}: write`,
      message: `${scopeLabel} grants ${permissionName}: write, which expands the impact of token misuse.`,
      suggestedAction: `Reduce ${permissionName} to read or remove it unless the job strictly requires write access.`,
      confidence: "high"
    }));
  }

  return findings;
}

function scanActionReference(
  context: WorkflowContext,
  actionReference: string,
  lineHint: string | RegExp,
  externalWorkflowResolved = false
): GithubMetadataFinding[] {
  const findings: GithubMetadataFinding[] = [];

  if (actionReference.startsWith("docker://")) {
    if (!/@sha256:[0-9a-f]{64}$/i.test(actionReference)) {
      findings.push(createFinding(context.file, findLineNumber(context.lines, lineHint), {
        id: "WG-GHWF-016",
        severity: "medium",
        category: "workflow-action-pin",
        reason: "docker action reference is not pinned to an immutable digest",
        evidence: actionReference,
        message: "docker:// action reference uses a mutable tag instead of an image digest.",
        suggestedAction: "Pin docker actions to an image digest such as @sha256:... .",
        confidence: "high"
      }));
    }

    return findings;
  }

  if (actionReference.startsWith("./")) {
    return findings;
  }

  if (!isPinnedActionReference(actionReference)) {
    findings.push(createFinding(context.file, findLineNumber(context.lines, lineHint), {
      id: "WG-GHWF-004",
      severity: "medium",
      category: "workflow-action-pin",
      reason: "workflow action is referenced by tag or branch instead of a full commit SHA",
      evidence: actionReference,
      message: "GitHub Action or reusable workflow reference is mutable and should be pinned to a full commit SHA.",
      suggestedAction: "Pin the reference to a 40-character commit SHA and document update cadence.",
      confidence: "high"
    }));
  }

  if (EXTERNAL_REUSABLE_WORKFLOW_PATTERN.test(actionReference) && !externalWorkflowResolved) {
    findings.push(createFinding(context.file, findLineNumber(context.lines, lineHint), {
      id: "WG-GHWF-017",
      severity: "medium",
      category: "workflow-reusable",
      reason: "workflow calls a reusable workflow whose contents are not local to this repository",
      evidence: actionReference,
      message: "Reusable workflow contents live outside this repository, so local scanning cannot verify the callee logic directly.",
      suggestedAction: "Audit the referenced workflow revision separately or vendor the reusable workflow into a reviewed internal repository.",
      confidence: "high"
    }));
  }

  return findings;
}

function scanRunBlock(
  context: WorkflowContext,
  runValue: string,
  taintedEnv: TaintedEnvMap,
  taintedExpressions: TaintedExpressionMap
): GithubMetadataFinding[] {
  const findings: GithubMetadataFinding[] = [];
  const lineNumber = findLineNumber(context.lines, runValue) ?? findLineNumber(context.lines, /^\s*run\s*:/i);
  const hasDecodedPayload = /\bbase64\b[^\n]*(?:-d|--decode)\b/i.test(runValue)
    || /\bFromBase64String\b/i.test(runValue)
    || /\bcertutil\b[^\n]*-decode\b/i.test(runValue);
  const executesVariablePayload = /\b(?:bash|sh)\s+-c\s+["']?\$[A-Za-z_][A-Za-z0-9_]*/i.test(runValue)
    || /\beval\s+["']?\$[A-Za-z_][A-Za-z0-9_]*/i.test(runValue);

  if (DANGEROUS_RUN_PATTERNS.some((pattern) => pattern.test(runValue))) {
    findings.push(createFinding(context.file, lineNumber, {
      id: "WG-GHWF-006",
      severity: "high",
      category: "workflow-command",
      reason: "workflow run step includes a dangerous shell pattern",
      evidence: runValue.trim(),
      message: "Workflow run step executes a high-risk shell pattern that deserves manual review.",
      suggestedAction: "Remove external pipe-to-shell patterns and avoid privileged shell commands in CI jobs.",
      confidence: "medium"
    }));
  }

  if (hasDecodedPayload && executesVariablePayload) {
    findings.push(createFinding(context.file, lineNumber, {
      id: "WG-GHWF-006",
      severity: "high",
      category: "workflow-command",
      reason: "workflow decodes an encoded payload and executes it through a shell",
      evidence: runValue.trim(),
      message: "Workflow run step decodes an encoded payload and feeds it into shell execution, which is a strong obfuscation signal.",
      suggestedAction: "Replace encoded payload execution with checked-in scripts or explicit, reviewable commands.",
      confidence: "high"
    }));
  }

  if (SECRET_ECHO_PATTERN.test(runValue)) {
    findings.push(createFinding(context.file, lineNumber, {
      id: "WG-GHWF-007",
      severity: "high",
      category: "workflow-command",
      reason: "workflow prints a GitHub secret into shell output",
      evidence: runValue.trim(),
      message: "Workflow step may expose secrets through logs or downstream shell expansion.",
      suggestedAction: "Avoid echoing secrets and pass them only through masked environment bindings when necessary.",
      confidence: "high"
    }));
  }

  const taintedExpressionReference = findTaintedExpressionReference(runValue, taintedExpressions);
  if (taintedExpressionReference) {
    findings.push(createFinding(context.file, lineNumber, {
      id: "WG-GHWF-011",
      severity: "high",
      category: "workflow-command",
      reason: "workflow shell command interpolates tainted workflow expression",
      evidence: taintedExpressionReference[1],
      message: "Workflow step interpolates a tainted workflow expression into shell execution.",
      suggestedAction: "Avoid direct shell interpolation of untrusted expressions; pass values through validated inputs or quoted environment bindings.",
      confidence: "medium"
    }));
  }

  const taintedEnvReference = findReferencedTaintedEnv(runValue, taintedEnv);
  if (taintedEnvReference) {
    findings.push(createFinding(context.file, lineNumber, {
      id: "WG-GHWF-018",
      severity: "high",
      category: "workflow-command",
      reason: `workflow shell command consumes tainted env variable ${taintedEnvReference[0]}`,
      evidence: taintedEnvReference[1],
      message: "Workflow run step executes shell code that reads an environment variable populated from user-controlled GitHub context.",
      suggestedAction: "Do not pass attacker-controlled event fields into shell via env; validate or sanitize first.",
      confidence: "medium"
    }));
  }

  return findings;
}

function scanWithBlock(
  context: WorkflowContext,
  usesReference: string | undefined,
  withValue: unknown,
  taintedExpressions: TaintedExpressionMap
): GithubMetadataFinding[] {
  if (!isObject(withValue)) {
    return [];
  }

  const findings: GithubMetadataFinding[] = [];

  for (const [key, value] of Object.entries(withValue)) {
    if (typeof value !== "string") {
      continue;
    }

    if (!EXECUTION_SINK_KEYS.has(key)) {
      continue;
    }

    const taintedReference = findTaintedExpressionReference(value, taintedExpressions);
    if (!taintedReference) {
      continue;
    }

    findings.push(createFinding(context.file, findLineNumber(context.lines, value) ?? findLineNumber(context.lines, new RegExp(`^\\s*${key}\\s*:`, "i")), {
      id: "WG-GHWF-019",
      severity: key === "script" || key === "command" || key === "entrypoint" ? "high" : "medium",
      category: "workflow-expression",
      reason: `${key} receives a user-controlled GitHub expression`,
      evidence: taintedReference[1],
      message: `${usesReference ?? "Workflow step"} passes a tainted workflow expression into ${key}.`,
      suggestedAction: `Avoid feeding tainted expressions into ${key}; validate values before passing them into execution-sensitive inputs.`,
      confidence: "medium"
    }));
  }

  return findings;
}

function scanTriggerSurface(context: WorkflowContext): GithubMetadataFinding[] {
  const findings: GithubMetadataFinding[] = [];

  if (context.triggers.names.has("pull_request_target")) {
    findings.push(createFinding(context.file, findLineNumber(context.lines, /\bpull_request_target\b/), {
      id: "WG-GHWF-008",
      severity: "high",
      category: "workflow-trigger",
      reason: "workflow is triggered by pull_request_target",
      evidence: findLineText(context.lines, /\bpull_request_target\b/),
      message: "pull_request_target runs in a higher-trust context and must not process untrusted PR code.",
      suggestedAction: "Prefer pull_request, or keep pull_request_target workflows read-only and avoid untrusted checkout.",
      confidence: "high"
    }));
  }

  if (context.triggers.names.has("workflow_dispatch")) {
    findings.push(createFinding(context.file, findLineNumber(context.lines, /\bworkflow_dispatch\b/), {
      id: "WG-GHWF-012",
      severity: "info",
      category: "workflow-trigger",
      reason: "workflow can be manually dispatched",
      evidence: findLineText(context.lines, /\bworkflow_dispatch\b/),
      message: "workflow_dispatch enables manual execution and should be reviewed before repository import or transfer.",
      suggestedAction: "Confirm that manual dispatch is necessary and that privileged inputs are validated.",
      confidence: "high"
    }));
  }

  if (context.triggers.names.has("schedule")) {
    findings.push(createFinding(context.file, findLineNumber(context.lines, /\bschedule\b/), {
      id: "WG-GHWF-013",
      severity: "info",
      category: "workflow-trigger",
      reason: "workflow runs on a schedule",
      evidence: findLineText(context.lines, /\bschedule\b/),
      message: "Scheduled workflows execute automatically and should be verified after repository import or fork.",
      suggestedAction: "Confirm that schedules are expected and disable them until the workflow is trusted.",
      confidence: "high"
    }));
  }

  if (context.triggers.names.has("workflow_run")) {
    findings.push(createFinding(context.file, findLineNumber(context.lines, /\bworkflow_run\b/), {
      id: "WG-GHWF-014",
      severity: "info",
      category: "workflow-trigger",
      reason: "workflow is chained from other workflows",
      evidence: findLineText(context.lines, /\bworkflow_run\b/),
      message: "workflow_run expands execution flow beyond direct push or PR triggers.",
      suggestedAction: "Review upstream workflows and confirm this chain does not elevate trust unexpectedly.",
      confidence: "medium"
    }));
  }

  return findings;
}

function normalizeLocalReusableWorkflowPath(fileReference: string): string | undefined {
  if (!fileReference.startsWith("./")) {
    return undefined;
  }

  const normalizedPath = path.posix.normalize(fileReference.slice(2));
  if (!WORKFLOW_FILE_PATTERN.test(normalizedPath)) {
    return undefined;
  }

  return normalizedPath;
}

async function scanWorkflowFile(
  file: string,
  content: string,
  resolutionContext: WorkflowResolutionContext,
  seedTaintedExpressions: TaintedExpressionMap = new Map(),
  activeWorkflowStack: ReadonlySet<string> = new Set()
): Promise<GithubMetadataFinding[]> {
  const parseFindings = collectWorkflowParseFindings(file, content);
  const context = buildWorkflowContext(file, content);
  const findings: GithubMetadataFinding[] = [...parseFindings, ...scanTriggerSurface(context)];
  const workflowPermissions = context.data.permissions;
  const baseWorkflowTaintedExpressions = mergeTaintedExpressions(
    collectWorkflowInputTaints(context),
    seedTaintedExpressions
  );
  const workflowTaintedExpressions = mergeTaintedExpressions(
    baseWorkflowTaintedExpressions,
    collectWorkflowJobOutputTaints(context, baseWorkflowTaintedExpressions)
  );
  let workflowTaintedEnv = collectTaintedEnv(context.data.env, workflowTaintedExpressions);
  const jobs = isObject(context.data.jobs) ? context.data.jobs : {};
  const workflowActionReferences: string[] = [];
  const hasCheckoutStep = context.lines.some((line) => /uses:\s*actions\/checkout@/i.test(line));

  for (const jobValue of Object.values(jobs)) {
    if (!isObject(jobValue)) {
      continue;
    }

    const jobUses = asString(jobValue.uses);
    if (jobUses) {
      workflowActionReferences.push(jobUses);
    }

    for (const step of asArray(jobValue.steps)) {
      if (!isObject(step)) {
        continue;
      }

      const stepUses = asString(step.uses);
      if (stepUses) {
        workflowActionReferences.push(stepUses);
      }
    }
  }

  findings.push(...scanPermissions(context, workflowPermissions, "Workflow", workflowActionReferences));

  let pullRequestTargetChecksOutHead = false;

  for (const [jobName, jobValue] of Object.entries(jobs)) {
    if (!isObject(jobValue)) {
      continue;
    }

    const jobUses = asString(jobValue.uses);
    let jobTaintedEnv = mergeTaintedEnv(workflowTaintedEnv, collectTaintedEnv(jobValue.env, workflowTaintedExpressions));
    if (jobUses) {
      let resolvedExternalWorkflow: GithubMetadataResolvedWorkflow | undefined;
      if (
        resolutionContext.resolveExternalWorkflows
        && EXTERNAL_REUSABLE_WORKFLOW_PATTERN.test(jobUses)
      ) {
        if (!resolutionContext.resolvedExternalWorkflowCache.has(jobUses)) {
          const resolvedWorkflow = await resolutionContext.externalWorkflowResolver?.resolve(jobUses);
          resolutionContext.resolvedExternalWorkflowCache.set(jobUses, resolvedWorkflow ?? null);
        }

        resolvedExternalWorkflow = resolutionContext.resolvedExternalWorkflowCache.get(jobUses) ?? undefined;
        if (resolvedExternalWorkflow) {
          resolutionContext.resolvedExternalFiles.add(resolvedExternalWorkflow.file);
        }
      }

      findings.push(...scanActionReference(context, jobUses, jobUses, Boolean(resolvedExternalWorkflow)));
      findings.push(...scanWithBlock(context, jobUses, jobValue.with, workflowTaintedExpressions));

      const localReusableWorkflowPath = normalizeLocalReusableWorkflowPath(jobUses);
      if (localReusableWorkflowPath) {
        const calleeContent = resolutionContext.workflowContents.get(localReusableWorkflowPath);
        const calleeSeedTaints = collectTaintedWithInputs(jobValue.with, workflowTaintedExpressions);
        if (
          calleeContent
          && calleeSeedTaints.size > 0
          && !activeWorkflowStack.has(localReusableWorkflowPath)
        ) {
          findings.push(...await scanWorkflowFile(
            localReusableWorkflowPath,
            calleeContent,
            resolutionContext,
            calleeSeedTaints,
            new Set([...activeWorkflowStack, file])
          ));
        }
      } else if (resolvedExternalWorkflow && !activeWorkflowStack.has(resolvedExternalWorkflow.file)) {
        findings.push(...await scanWorkflowFile(
          resolvedExternalWorkflow.file,
          resolvedExternalWorkflow.content,
          resolutionContext,
          collectTaintedWithInputs(jobValue.with, workflowTaintedExpressions),
          new Set([...activeWorkflowStack, file])
        ));
      }
    }

    if (jobValue.secrets === "inherit") {
      findings.push(createFinding(context.file, findLineNumber(context.lines, /^\s*secrets\s*:\s*inherit\s*$/i), {
        id: "WG-GHWF-015",
        severity: "high",
        category: "workflow-secrets",
        reason: `job ${jobName} forwards all caller secrets to a reusable workflow`,
        evidence: "secrets: inherit",
        message: "Reusable workflow call inherits all available secrets.",
        suggestedAction: "Pass only the specific secrets required by the reusable workflow.",
        confidence: "high"
      }));
    }

    if (jobValue.permissions !== undefined || workflowPermissions === undefined) {
      findings.push(...scanPermissions(context, jobValue.permissions, `Job ${jobName}`, workflowActionReferences));
    }

    const runsOnValues = [
      asString(jobValue["runs-on"]),
      ...asArray(jobValue["runs-on"]).flatMap((entry) => typeof entry === "string" ? [entry] : [])
    ].filter((entry): entry is string => Boolean(entry));
    if (runsOnValues.some((entry) => /\bself-hosted\b/i.test(entry))) {
      findings.push(createFinding(context.file, findLineNumber(context.lines, /\bself-hosted\b/i), {
        id: "WG-GHWF-005",
        severity: "high",
        category: "workflow-runner",
        reason: `job ${jobName} uses a self-hosted runner`,
        evidence: findLineText(context.lines, /\bself-hosted\b/i),
        message: "Self-hosted runners expand the trust boundary to runner-host assets and network access.",
        suggestedAction: "Prefer GitHub-hosted runners or isolate self-hosted runners behind strict segmentation.",
        confidence: "high"
      }));
    }

    for (const step of asArray(jobValue.steps)) {
      if (!isObject(step)) {
        continue;
      }

      const stepUses = asString(step.uses);
      let stepTaintedEnv = mergeTaintedEnv(jobTaintedEnv, collectTaintedEnv(step.env, workflowTaintedExpressions));
      if (stepUses) {
        findings.push(...scanActionReference(context, stepUses, stepUses));
        findings.push(...scanWithBlock(context, stepUses, step.with, workflowTaintedExpressions));

        if (/^actions\/checkout@/i.test(stepUses)) {
          const stepWith = isObject(step.with) ? step.with : {};
          const ref = asString(stepWith.ref) ?? "";
          const repository = asString(stepWith.repository) ?? "";
          if (
            /github\.event\.pull_request\.head\./.test(ref)
            || /github\.event\.pull_request\.head\./.test(repository)
          ) {
            pullRequestTargetChecksOutHead = true;
          }
        }
      }

      const runValue = asString(step.run);
      if (runValue) {
        findings.push(...scanRunBlock(context, runValue, stepTaintedEnv, workflowTaintedExpressions));
        if (/github\.event\.pull_request\.head\./.test(runValue)) {
          pullRequestTargetChecksOutHead = true;
        }

        const taintedEnvAssignments = extractTaintedFileCommandAssignments(
          runValue,
          "GITHUB_ENV",
          workflowTaintedExpressions,
          stepTaintedEnv
        );
        if (taintedEnvAssignments.size > 0) {
          jobTaintedEnv = mergeTaintedEnv(jobTaintedEnv, taintedEnvAssignments);
          workflowTaintedEnv = mergeTaintedEnv(workflowTaintedEnv, taintedEnvAssignments);
          stepTaintedEnv = mergeTaintedEnv(stepTaintedEnv, taintedEnvAssignments);
        }

        const stepId = asString(step.id);
        if (stepId) {
          const taintedOutputAssignments = extractTaintedFileCommandAssignments(
            runValue,
            "GITHUB_OUTPUT",
            workflowTaintedExpressions,
            stepTaintedEnv
          );
          if (taintedOutputAssignments.size > 0) {
            for (const [outputName, source] of taintedOutputAssignments.entries()) {
              workflowTaintedExpressions.set(`steps.${stepId}.outputs.${outputName}`, source);
            }
          }
        }
      }
    }
  }

  if (
    context.triggers.names.has("pull_request_target")
    && (pullRequestTargetChecksOutHead || (hasCheckoutStep && context.lines.some((line) => /github\.event\.pull_request\.head\./.test(line))))
  ) {
    findings.push(createFinding(context.file, findLineNumber(context.lines, /github\.event\.pull_request\.head\./), {
      id: "WG-GHWF-009",
      severity: "high",
      category: "workflow-checkout",
      reason: "pull_request_target workflow checks out or executes PR head content",
      evidence: findLineText(context.lines, /github\.event\.pull_request\.head\./),
      message: "This workflow combines pull_request_target with PR-head checkout or execution, which can run attacker-controlled code with elevated repository context.",
      suggestedAction: "Do not use PR-head refs in pull_request_target workflows; separate trusted metadata handling from untrusted code execution.",
      confidence: "high"
    }));
  }

  return findings;
}

function scanDependabotFile(file: string, content: string): GithubMetadataFinding[] {
  const lines = toLines(content);
  const findings: GithubMetadataFinding[] = [];
  const document = parseDocument(content, {
    prettyErrors: false,
    strict: false
  });
  const data = document.toJS({ maxAliasCount: 50 }) as unknown;

  if (!isObject(data)) {
    return findings;
  }

  for (const updateEntry of asArray(data.updates)) {
    if (!isObject(updateEntry)) {
      continue;
    }

    if (updateEntry["insecure-external-code-execution"] === "allow") {
      findings.push(createFinding(file, findLineNumber(lines, /^\s*insecure-external-code-execution\s*:\s*allow\s*$/i), {
        id: "WG-GHDB-001",
        severity: "high",
        category: "dependabot-execution",
        reason: "dependabot allows insecure external code execution",
        evidence: "insecure-external-code-execution: allow",
        message: "Dependabot is configured to allow insecure external code execution.",
        suggestedAction: "Disable insecure-external-code-execution unless there is a narrowly justified and documented need.",
        confidence: "high"
      }));
    }
  }

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

function parseJsonObject(content: string): YamlObject | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeExtensionIdList(ids: string[] | undefined, defaults: string[]): string[] {
  const source = ids && ids.length > 0 ? ids : defaults;
  return source.map((entry) => entry.trim()).filter(Boolean);
}

function collectWorkspaceExtensionRecommendations(data: YamlObject): string[] {
  const extensions = isObject(data.extensions) ? data.extensions : undefined;
  const recommendations = extensions?.recommendations ?? data.recommendations;
  return asArray(recommendations)
    .map((entry) => asString(entry)?.trim())
    .filter((entry): entry is string => Boolean(entry));
}

function scanWorkspaceSettingsLikeFile(file: string, content: string): GithubMetadataFinding[] {
  const lines = toLines(content);
  const data = parseJsonObject(content);

  if (!data) {
    return [];
  }

  const findings: GithubMetadataFinding[] = [];
  const settings = file.endsWith(".code-workspace") && isObject(data.settings)
    ? data.settings
    : data;

  if (!isObject(settings)) {
    return findings;
  }

  for (const [key, value] of Object.entries(settings)) {
    if (!RISKY_SETTINGS_KEY_PATTERN.test(key)) {
      continue;
    }

    findings.push(createFinding(file, findLineNumber(lines, new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`)), {
      id: "WG-WS-001",
      severity: "medium",
      category: "workspace-settings",
      reason: `workspace settings configure command execution or automatic tooling through ${key}`,
      evidence: `"${key}": ${JSON.stringify(value)}`,
      message: "Workspace settings configure an execution-related feature that should be reviewed before trusting the repository.",
      suggestedAction: "Review execution-related workspace settings and keep automatic command execution disabled unless it is explicitly approved.",
      confidence: "medium"
    }));
  }

  return findings;
}

function scanTasksFile(file: string, content: string): GithubMetadataFinding[] {
  const lines = toLines(content);
  const data = parseJsonObject(content);
  const findings: GithubMetadataFinding[] = [];

  if (!data) {
    return findings;
  }

  for (const task of asArray(data.tasks)) {
    if (!isObject(task)) {
      continue;
    }

    const command = asString(task.command);
    const type = asString(task.type);
    const runOn = isObject(task.runOptions) ? asString(task.runOptions.runOn) : undefined;

    if (type === "shell" || command) {
      findings.push(createFinding(file, findLineNumber(lines, command ?? /"type"\s*:\s*"shell"/), {
        id: "WG-WS-002",
        severity: "high",
        category: "workspace-tasks",
        reason: "workspace task executes shell or external commands",
        evidence: command ?? `type: ${type ?? "shell"}`,
        message: "Workspace tasks can run external commands and should be treated like executable code during review.",
        suggestedAction: "Require explicit review for shared tasks.json files and avoid shell tasks in untrusted workspaces.",
        confidence: "high"
      }));
    }

    if (runOn === "folderOpen") {
      findings.push(createFinding(file, findLineNumber(lines, /"runOn"\s*:\s*"folderOpen"/), {
        id: "WG-WS-003",
        severity: "high",
        category: "workspace-tasks",
        reason: "workspace task is configured to run when the folder opens",
        evidence: "runOn: folderOpen",
        message: "Workspace tasks are configured for automatic execution when the folder opens.",
        suggestedAction: "Disable folderOpen task automation and require manual invocation after review.",
        confidence: "high"
      }));
    }
  }

  return findings;
}

function scanLaunchFile(file: string, content: string): GithubMetadataFinding[] {
  const lines = toLines(content);
  const data = parseJsonObject(content);
  const findings: GithubMetadataFinding[] = [];

  if (!data) {
    return findings;
  }

  for (const config of asArray(data.configurations)) {
    if (!isObject(config)) {
      continue;
    }

    for (const key of ["preLaunchTask", "postDebugTask"]) {
      const value = asString(config[key]);
      if (!value) {
        continue;
      }

      findings.push(createFinding(file, findLineNumber(lines, new RegExp(`"${key}"\\s*:`)), {
        id: "WG-WS-004",
        severity: "medium",
        category: "workspace-debug",
        reason: `launch configuration triggers ${key}`,
        evidence: `${key}: ${value}`,
        message: "Launch configurations can chain task execution and should be reviewed like code before trust is granted.",
        suggestedAction: "Review launch.json for task chaining and avoid automatic task execution in untrusted workspaces.",
        confidence: "high"
      }));
    }
  }

  return findings;
}

function scanExtensionsFile(
  file: string,
  content: string,
  options: Pick<GithubMetadataScanOptions, "allowedExtensionIds" | "recommendedLatexExtensionIds">,
  latexFiles: string[]
): GithubMetadataFinding[] {
  const lines = toLines(content);
  const data = parseJsonObject(content);
  const findings: GithubMetadataFinding[] = [];

  if (!data) {
    return findings;
  }

  const recommendations = collectWorkspaceExtensionRecommendations(data);
  const allowedExtensionIds = new Set(normalizeExtensionIdList(options.allowedExtensionIds, DEFAULT_ALLOWED_EXTENSION_IDS));
  const recommendedLatexExtensions = normalizeExtensionIdList(
    options.recommendedLatexExtensionIds,
    DEFAULT_RECOMMENDED_LATEX_EXTENSION_IDS
  );

  for (const extensionId of recommendations) {
    if (allowedExtensionIds.has(extensionId)) {
      continue;
    }

    findings.push(createFinding(file, findLineNumber(lines, extensionId), {
      id: "WG-WS-005",
      severity: RISKY_EXTENSION_PATTERN.test(extensionId) ? "high" : "medium",
      category: "workspace-extensions",
      reason: "workspace recommends an extension outside the approved allowlist",
      evidence: extensionId,
      message: "Workspace recommendations include an extension that is not on the approved allowlist.",
      suggestedAction: "Recommend only approved extensions and require manual approval for any additional Marketplace installs.",
      confidence: "high"
    }));
  }

  if (latexFiles.length > 0 && recommendedLatexExtensions.length > 0) {
    const recommendedLatex = recommendations.filter((entry) => recommendedLatexExtensions.includes(entry));
    const nonLatexRecommendations = recommendations.filter((entry) => !recommendedLatexExtensions.includes(entry));

    if (recommendedLatex.length === 0 || nonLatexRecommendations.length > 0) {
      findings.push(createFinding(file, findLineNumber(lines, /"recommendations"\s*:/), {
        id: "WG-WS-006",
        severity: "medium",
        category: "workspace-extensions",
        reason: "LaTeX workspace recommendations do not match the approved LaTeX extension policy",
        evidence: recommendations.join(", ") || "recommendations: []",
        message: "LaTeX-related files are present, but the workspace does not recommend only the approved LaTeX extension set.",
        suggestedAction: `Keep LaTeX workspace recommendations limited to the approved extension IDs: ${recommendedLatexExtensions.join(", ")}.`,
        confidence: "medium"
      }));
    }
  }

  return findings;
}

function scanLatexWorkspaceInputs(file: string): GithubMetadataFinding[] {
  return [createFinding(file, undefined, {
    id: "WG-WS-007",
    severity: "info",
    category: "latex-inputs",
    reason: "workspace contains LaTeX source or support files that should be treated as untrusted input",
    evidence: file,
    message: "LaTeX source, bibliography, class, and style files should be reviewed before trust because they can influence tooling and build behavior.",
    suggestedAction: "Treat .tex, .bib, .cls, and .sty files as untrusted input until the workspace and its build configuration have been reviewed.",
    confidence: "high"
  })];
}

export async function scanGithubMetadata(
  rootPath: string,
  options: GithubMetadataScanOptions = {}
): Promise<GithubMetadataScanResult> {
  const fileSystem = options.fs ?? defaultFs;
  const workspaceFiles = await walkDirectory(fileSystem, rootPath);
  const githubFiles = workspaceFiles.filter((filePath) => {
    const relativeFilePath = toRelativePath(rootPath, filePath);
    return relativeFilePath.startsWith(".github/");
  });
  const workspaceReviewFiles = workspaceFiles.filter((filePath) => {
    const relativeFilePath = toRelativePath(rootPath, filePath);
    return VSCODE_SETTINGS_FILE_PATTERN.test(relativeFilePath)
      || VSCODE_TASKS_FILE_PATTERN.test(relativeFilePath)
      || VSCODE_LAUNCH_FILE_PATTERN.test(relativeFilePath)
      || VSCODE_EXTENSIONS_FILE_PATTERN.test(relativeFilePath)
      || CODE_WORKSPACE_FILE_PATTERN.test(relativeFilePath);
  });
  const latexFiles = workspaceFiles
    .map((filePath) => toRelativePath(rootPath, filePath))
    .filter((relativeFilePath) => LATEX_INPUT_FILE_PATTERN.test(relativeFilePath));
  const findings: GithubMetadataFinding[] = [];
  const workflowContents = new Map<string, string>();
  const resolutionContext: WorkflowResolutionContext = {
    workflowContents,
    resolveExternalWorkflows: options.resolveExternalWorkflows ?? false,
    externalWorkflowResolver: options.resolveExternalWorkflows
      ? (options.externalWorkflowResolver ?? createDefaultExternalWorkflowResolver())
      : undefined,
    resolvedExternalWorkflowCache: new Map(),
    resolvedExternalFiles: new Set()
  };

  for (const filePath of githubFiles) {
    const relativeFilePath = toRelativePath(rootPath, filePath);
    if (!WORKFLOW_FILE_PATTERN.test(relativeFilePath)) {
      continue;
    }

    workflowContents.set(relativeFilePath, await fileSystem.readFile(filePath, "utf8"));
  }

  for (const filePath of githubFiles) {
    const relativeFilePath = toRelativePath(rootPath, filePath);
    const content = workflowContents.get(relativeFilePath) ?? await fileSystem.readFile(filePath, "utf8");

    if (WORKFLOW_FILE_PATTERN.test(relativeFilePath)) {
      findings.push(...await scanWorkflowFile(relativeFilePath, content, resolutionContext));
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

  for (const filePath of workspaceReviewFiles) {
    const relativeFilePath = toRelativePath(rootPath, filePath);
    const content = await fileSystem.readFile(filePath, "utf8");

    if (VSCODE_SETTINGS_FILE_PATTERN.test(relativeFilePath) || CODE_WORKSPACE_FILE_PATTERN.test(relativeFilePath)) {
      findings.push(...scanWorkspaceSettingsLikeFile(relativeFilePath, content));
    }

    if (VSCODE_TASKS_FILE_PATTERN.test(relativeFilePath)) {
      findings.push(...scanTasksFile(relativeFilePath, content));
      continue;
    }

    if (VSCODE_LAUNCH_FILE_PATTERN.test(relativeFilePath)) {
      findings.push(...scanLaunchFile(relativeFilePath, content));
      continue;
    }

    if (VSCODE_EXTENSIONS_FILE_PATTERN.test(relativeFilePath) || CODE_WORKSPACE_FILE_PATTERN.test(relativeFilePath)) {
      findings.push(...scanExtensionsFile(relativeFilePath, content, options, latexFiles));
    }
  }

  if (latexFiles.length > 0) {
    findings.push(...scanLatexWorkspaceInputs(latexFiles[0]));
  }

  findings.sort((left, right) => {
    if (left.file === right.file) {
      return (left.line ?? 0) - (right.line ?? 0);
    }

    return left.file.localeCompare(right.file);
  });

  const scannedFiles = [
    ...githubFiles.map((filePath) => toRelativePath(rootPath, filePath)),
    ...workspaceReviewFiles.map((filePath) => toRelativePath(rootPath, filePath)),
    ...(latexFiles.length > 0 ? [latexFiles[0]] : []),
    ...resolutionContext.resolvedExternalFiles
  ].sort();

  return {
    rootPath,
    scannedFiles,
    findings: findings.filter((finding, index, allFindings) => allFindings.findIndex((candidate) => (
      candidate.id === finding.id
      && candidate.file === finding.file
      && candidate.line === finding.line
      && candidate.evidence === finding.evidence
      && candidate.message === finding.message
    )) === index)
  };
}

export function formatGithubMetadataScanResult(result: GithubMetadataScanResult): string {
  if (result.findings.length === 0) {
    return "No repository-trust findings detected.";
  }

  return result.findings.map((finding) => {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    return `[${finding.severity}] ${finding.id} ${location} ${finding.message}`;
  }).join("\n");
}
