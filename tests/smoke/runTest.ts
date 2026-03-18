import path from "node:path";

import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "suite/index");
  const testWorkspacePath = path.resolve(extensionDevelopmentPath, "tests/fixtures/smoke-risky-workspace");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      testWorkspacePath,
      "--disable-extensions"
    ]
  });
}

void main().catch((error: unknown) => {
  console.error("Failed to run Workspace Guard smoke tests.");
  console.error(error);
  process.exit(1);
});
