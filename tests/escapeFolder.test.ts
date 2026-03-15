import path from "node:path";
import { tmpdir } from "node:os";
import * as fc from "fast-check";
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

  it("keeps arbitrary ephemeral suffixes inside tmpdir", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (timestamp) => {
        const targetPath = resolveEscapeFolderPath({
          enableEphemeralEscape: true,
          homeDir: "/Users/akira",
          timestamp
        });

        expect(path.dirname(targetPath)).toBe(tmpdir());
        expect(path.relative(tmpdir(), targetPath).startsWith("..")).toBe(false);
        expect(path.basename(targetPath)).toMatch(/^vscode-home-escape-[A-Za-z0-9_-]+$/);
      })
    );
  });
});
