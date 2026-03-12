#!/usr/bin/env node

import { runHomeguardCode } from "./cli/homeguardCode";

void runHomeguardCode(process.argv.slice(2), {
  mode: "redirect"
}).then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
