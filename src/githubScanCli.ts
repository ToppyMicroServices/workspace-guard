#!/usr/bin/env node

import { runRepositoryScanCli } from "./cli/repositoryScanCli";

async function main(argv: string[]): Promise<number> {
  return await runRepositoryScanCli(argv);
}

void main(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
