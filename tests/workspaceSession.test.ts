import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  collectEphemeralWorkspaceCleanupTargets,
  getRecentWorkspaceSuggestions,
  updateRecentWorkspaceHistory
} from "../src/extension/workspaceSession";

describe("workspaceSession", () => {
  it("tracks recent workspaces with the newest current workspace first", () => {
    const history = updateRecentWorkspaceHistory(
      ["/Users/akira/work/project-a", "/Users/akira/work/project-b"],
      ["/Users/akira/work/project-c", "/Users/akira/work/project-a"]
    );

    expect(history).toEqual([
      "/Users/akira/work/project-c",
      "/Users/akira/work/project-a",
      "/Users/akira/work/project-b"
    ]);
  });

  it("filters the current workspace out of recent suggestions", () => {
    const suggestions = getRecentWorkspaceSuggestions(
      [
        "/Users/akira/work/project-c",
        "/Users/akira/work/project-a",
        "/Users/akira/work/project-b"
      ],
      ["/Users/akira/work/project-c"]
    );

    expect(suggestions).toEqual([
      "/Users/akira/work/project-a",
      "/Users/akira/work/project-b"
    ]);
  });

  it("cleans up removed ephemeral escape folders once a real workspace is selected", () => {
    const ephemeralPath = `${tmpdir()}/vscode-home-escape-2026-03-27T01-02-03-000Z`;
    const cleanupTargets = collectEphemeralWorkspaceCleanupTargets(
      [
        ephemeralPath
      ],
      [
        "/Users/akira/work/project-a"
      ]
    );

    expect(cleanupTargets).toEqual([
      ephemeralPath
    ]);
  });

  it("keeps the ephemeral escape folder when no real workspace replaced it", () => {
    const ephemeralPath = `${tmpdir()}/vscode-home-escape-2026-03-27T01-02-03-000Z`;
    const cleanupTargets = collectEphemeralWorkspaceCleanupTargets(
      [
        ephemeralPath
      ],
      []
    );

    expect(cleanupTargets).toEqual([]);
  });
});
