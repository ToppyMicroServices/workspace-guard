import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '..');

await build({
  entryPoints: [path.join(workspaceRoot, 'src', 'vscodeExtension.ts')],
  outfile: path.join(workspaceRoot, 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  external: ['vscode'],
  sourcemap: false,
  logLevel: 'info'
});