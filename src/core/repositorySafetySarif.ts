import type { RepositorySafetyFinding, RepositorySafetyScanResult } from "./repositorySafetyScanner";

interface SarifRule {
  id: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string };
  properties: {
    category: string;
    source: string;
    confidence: string;
  };
}

function mapLevel(severity: RepositorySafetyFinding["severity"]): "error" | "warning" | "note" {
  if (severity === "high") {
    return "error";
  }

  if (severity === "medium") {
    return "warning";
  }

  return "note";
}

function buildSarifRule(finding: RepositorySafetyFinding): SarifRule {
  return {
    id: finding.id,
    shortDescription: { text: finding.message },
    fullDescription: { text: finding.reason },
    help: { text: finding.suggestedAction },
    properties: {
      category: finding.category,
      source: finding.source,
      confidence: finding.confidence
    }
  };
}

export function formatRepositorySafetySarif(result: RepositorySafetyScanResult): string {
  const rules = new Map<string, SarifRule>();
  for (const finding of result.findings) {
    if (!rules.has(finding.id)) {
      rules.set(finding.id, buildSarifRule(finding));
    }
  }

  return JSON.stringify({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Workspace Guard",
            informationUri: "https://github.com/ToppyMicroServices/workspace-guard",
            rules: [...rules.values()]
          }
        },
        results: result.findings.map((finding) => ({
          ruleId: finding.id,
          level: mapLevel(finding.severity),
          message: {
            text: finding.message
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: finding.file
                },
                region: finding.line
                  ? {
                    startLine: finding.line
                  }
                  : undefined
              }
            }
          ],
          properties: {
            source: finding.source,
            category: finding.category,
            confidence: finding.confidence,
            evidence: finding.evidence,
            suggestedAction: finding.suggestedAction
          }
        }))
      }
    ]
  }, null, 2);
}