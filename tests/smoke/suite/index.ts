import assert from "node:assert/strict";

import * as vscode from "vscode";

interface GithubReviewTreeSnapshotNode {
  kind: "summary" | "workspace" | "finding" | "empty";
  label: string;
  description?: string | boolean;
  contextValue?: string;
  children?: GithubReviewTreeSnapshotNode[];
}

interface GithubReviewTreeSnapshot {
  filter: "all" | "high" | "medium" | "info";
  summary: {
    workspaceFoldersScanned: number;
    workspaceFoldersWithGithub: number;
    workspaceFoldersWithRisk: number;
    totalFindings: number;
    highFindings: number;
    mediumFindings: number;
    infoFindings: number;
  };
  nodes: GithubReviewTreeSnapshotNode[];
}

function flattenTree(nodes: GithubReviewTreeSnapshotNode[]): GithubReviewTreeSnapshotNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children ?? [])]);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("ToppyMicroServices.workspace-guard");
  assert.ok(extension, "Workspace Guard extension should be available in the Extension Development Host.");

  await extension.activate();
  await vscode.commands.executeCommand("workbench.view.explorer");

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("homeguard.reviewGithubAutomation"));
  assert.ok(commands.includes("homeguard.refreshGithubAutomationReview"));
  assert.ok(commands.includes("homeguard.suggestGithubRemediation"));

  const snapshot = await vscode.commands.executeCommand<GithubReviewTreeSnapshot>("homeguard.__captureGithubReviewTree");
  assert.ok(snapshot, "Workspace Guard should expose a review tree snapshot for smoke testing.");

  assert.equal(snapshot.filter, "all");
  assert.equal(snapshot.summary.workspaceFoldersScanned, 1);
  assert.equal(snapshot.summary.workspaceFoldersWithGithub, 1);
  assert.ok(snapshot.summary.workspaceFoldersWithRisk >= 1);
  assert.ok(snapshot.summary.highFindings >= 1);

  const allNodes = flattenTree(snapshot.nodes);
  assert.ok(allNodes.some((node) => node.kind === "summary" && node.label.includes(".github findings")));
  assert.ok(allNodes.some((node) => node.kind === "workspace" && node.label.includes("smoke-risky-workspace")));
  assert.ok(allNodes.some((node) => node.kind === "finding" && (
    node.label.includes("pull_request_target")
    || node.label.includes("write")
    || node.label.includes("curl")
  )));
}
