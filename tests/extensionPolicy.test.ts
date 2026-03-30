import { describe, expect, it } from "vitest";

import { reviewInstalledExtensions } from "../src";

describe("reviewInstalledExtensions", () => {
  it("flags non-allowlisted command-running extensions", () => {
    const findings = reviewInstalledExtensions([
      { id: "example.shell-runner", displayName: "Shell Runner", tags: ["terminal", "runner"] },
      { id: "ToppyMicroServices.workspace-guard", displayName: "Workspace Guard" }
    ], ["ToppyMicroServices.workspace-guard", "LaTeX-Secure-Workspace"]);

    expect(findings).toEqual([
      expect.objectContaining({
        id: "WG-EXT-001",
        extensionId: "example.shell-runner",
        severity: "high"
      })
    ]);
  });

  it("ignores approved extensions", () => {
    const findings = reviewInstalledExtensions([
      { id: "LaTeX-Secure-Workspace", displayName: "LaTeX Secure Workspace" }
    ], ["LaTeX-Secure-Workspace"]);

    expect(findings).toEqual([]);
  });
});
