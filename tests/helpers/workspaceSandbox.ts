import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const sandboxRoot = path.join(process.cwd(), ".workspace-sandboxes");
const createdSandboxes: string[] = [];

export async function createWorkspaceSandbox(prefix: string): Promise<string> {
  await mkdir(sandboxRoot, { recursive: true });
  const targetPath = path.join(sandboxRoot, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(targetPath, { recursive: true });
  createdSandboxes.push(targetPath);
  return targetPath;
}

export async function cleanupWorkspaceSandboxes(): Promise<void> {
  await Promise.all(createdSandboxes.splice(0).map(async (targetPath) => {
    await rm(targetPath, { recursive: true, force: true });
  }));
}