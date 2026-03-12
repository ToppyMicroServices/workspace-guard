import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { resolveEscapeFolderPath } from "../src";

describe("resolveEscapeFolderPath", () => {
  it("sanitizes ephemeral timestamps into portable folder names", () => {
    const targetPath = resolveEscapeFolderPath({
      enableEphemeralEscape: true,
      homeDir: "/Users/akira",
      timestamp: "2026-03-12T01:02:03.000Z"
    });

    expect(targetPath).toBe(path.join(tmpdir(), "vscode-home-escape-2026-03-12T01-02-03-000Z"));
  });

  it("does not allow traversal tokens in the ephemeral folder suffix", () => {
    const targetPath = resolveEscapeFolderPath({
      enableEphemeralEscape: true,
      homeDir: "/Users/akira",
      timestamp: "../../../etc/passwd"
    });

    expect(path.dirname(targetPath)).toBe(tmpdir());
    expect(path.basename(targetPath)).toBe("vscode-home-escape-etc-passwd");
  });
});
