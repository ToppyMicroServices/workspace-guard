import type { RepositorySafetyFinding, RepositorySafetyScanResult } from "../core/repositorySafetyScanner";

export type RepositoryDiagnosticSeverity = "error" | "warning" | "information";

export interface RepositoryDiagnosticItem {
  file: string;
  line?: number;
  severity: RepositoryDiagnosticSeverity;
  code: string;
  source: string;
  message: string;
}

function mapDiagnosticSeverity(finding: RepositorySafetyFinding): RepositoryDiagnosticSeverity {
  if (finding.severity === "high") {
    return "error";
  }

  if (finding.severity === "medium") {
    return "warning";
  }

  return "information";
}

export function buildRepositoryDiagnostics(result: RepositorySafetyScanResult): Map<string, RepositoryDiagnosticItem[]> {
  const diagnostics = new Map<string, RepositoryDiagnosticItem[]>();

  for (const finding of result.findings) {
    const fileDiagnostics = diagnostics.get(finding.file) ?? [];
    fileDiagnostics.push({
      file: finding.file,
      line: finding.line,
      severity: mapDiagnosticSeverity(finding),
      code: finding.id,
      source: "Workspace Guard",
      message: `[${finding.source}] ${finding.message}`
    });
    diagnostics.set(finding.file, fileDiagnostics);
  }

  return diagnostics;
}