import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getDefaultRepositoryPolicyPath,
  getEffectiveRepositoryPolicyFailOn,
  getEffectiveRepositoryPolicyProfile,
  isCommandAllowedByRepositoryPolicy,
  loadRepositoryPolicy
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

describe("repository policy", () => {
  it("loads repository policy from the default workspace path", async () => {
    const rootPath = await createWorkspaceSandbox("workspace-guard-policy");
    const policyPath = getDefaultRepositoryPolicyPath(rootPath);
    await writeRepoFile(rootPath, ".workspace-guard/policy.jsonc", `{
  "version": 1,
  "profile": "restricted",
  "failOn": "high",
  "commandAllowList": ["homeguard.reviewRepositorySafety"]
}
`);

    const loaded = await loadRepositoryPolicy(rootPath);

    expect(loaded.filePath).toBe(policyPath);
    expect(getEffectiveRepositoryPolicyProfile(loaded.policy, "default")).toBe("restricted");
    expect(getEffectiveRepositoryPolicyFailOn(loaded.policy, "medium")).toBe("high");
    expect(isCommandAllowedByRepositoryPolicy("homeguard.reviewRepositorySafety", loaded.policy)).toBe(true);
    expect(isCommandAllowedByRepositoryPolicy("homeguard.exportRepositorySafetyJson", loaded.policy)).toBe(false);
  });

  it("reports validation issues for invalid policy content", async () => {
    const rootPath = await createWorkspaceSandbox("workspace-guard-policy");
    await writeRepoFile(rootPath, ".workspace-guard/policy.jsonc", `{
  "version": 2,
  "profile": "strict",
  "findingAllowList": [{ "unknown": true }]
}
`);

    const loaded = await loadRepositoryPolicy(rootPath);

    expect(loaded.validationIssues).not.toEqual([]);
    expect(loaded.validationIssues.map((issue) => issue.message).join(" ")).toContain("Policy version must be 1");
  });
});