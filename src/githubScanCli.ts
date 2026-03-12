#!/usr/bin/env node

import path from "node:path";

import { formatGithubMetadataScanResult, scanGithubMetadata } from "./core/githubMetadataScanner";

async function main(argv: string[]): Promise<number> {
  const targetPath = path.resolve(argv[0] ?? ".");
  const result = await scanGithubMetadata(targetPath);
  process.stdout.write(`${formatGithubMetadataScanResult(result)}\n`);

  return result.findings.some((finding) => finding.severity !== "info") ? 1 : 0;
}

void main(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
