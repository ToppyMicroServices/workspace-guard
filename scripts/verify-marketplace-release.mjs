import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    args.set(key, value);
    index += 1;
  }

  return args;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function showExtension(extensionId) {
  const { stdout } = await execFileAsync(
    'npx',
    ['@vscode/vsce', 'show', extensionId, '--json'],
    {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
      env: process.env,
    },
  );

  return JSON.parse(stdout);
}

async function fetchPackage(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vsix, application/octet-stream;q=0.9, */*;q=0.1',
    },
    redirect: 'follow',
  });

  return response;
}

function normalizeTargets(versions, version) {
  return versions
    .filter(candidate => candidate.version === version)
    .map(candidate => candidate.targetPlatform)
    .filter(Boolean)
    .sort();
}

function compareTargets(actualTargets, expectedTargets) {
  const actual = new Set(actualTargets);
  const expected = new Set(expectedTargets);

  const missing = expectedTargets.filter(target => !actual.has(target));
  const unexpected = actualTargets.filter(target => !expected.has(target));

  return { missing, unexpected };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const publisher = args.get('publisher');
  const extensionName = args.get('name');
  const version = args.get('version');
  const mode = args.get('mode') ?? 'universal';
  const targets = (args.get('targets') ?? '')
    .split(',')
    .map(target => target.trim())
    .filter(Boolean);
  const timeoutSeconds = Number(args.get('timeout-seconds') ?? '900');
  const pollSeconds = Number(args.get('poll-seconds') ?? '20');

  if (!publisher || !extensionName || !version) {
    throw new Error('Expected --publisher, --name, and --version.');
  }

  if (mode !== 'universal' && mode !== 'targeted') {
    throw new Error(`Unsupported mode '${mode}'. Use 'universal' or 'targeted'.`);
  }

  if (mode === 'targeted' && targets.length === 0) {
    throw new Error('Expected --targets when --mode targeted is used.');
  }

  const extensionId = `${publisher}.${extensionName}`;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastPublishedVersion = '';

  while (Date.now() <= deadline) {
    const extension = await showExtension(extensionId);
    const latestVersion = extension.versions?.[0]?.version ?? '';
    lastPublishedVersion = latestVersion;

    if (latestVersion !== version) {
      console.log(
        `Marketplace still shows '${latestVersion || 'unknown'}'; waiting for '${version}'.`,
      );
      await sleep(pollSeconds * 1000);
      continue;
    }

    const publishedTargets = normalizeTargets(extension.versions ?? [], version);

    if (mode === 'universal') {
      if (publishedTargets.length > 0) {
        throw new Error(
          `Expected universal publish for ${extensionId}@${version}, but Marketplace advertises targets: ${publishedTargets.join(', ')}`,
        );
      }
    } else {
      const { missing, unexpected } = compareTargets(publishedTargets, targets);
      if (missing.length > 0 || unexpected.length > 0) {
        throw new Error(
          `Marketplace targets mismatch for ${extensionId}@${version}. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`,
        );
      }
    }

    const packageUrl = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${publisher}/vsextensions/${extensionName}/${version}/vspackage`;
    const packageResponse = await fetchPackage(packageUrl);
    const contentType = packageResponse.headers.get('content-type') ?? '';

    if (!packageResponse.ok) {
      throw new Error(
        `Marketplace package download failed for ${extensionId}@${version}: HTTP ${packageResponse.status}`,
      );
    }

    if (!contentType.includes('application/vsix')) {
      throw new Error(
        `Marketplace package download returned unexpected content type '${contentType}' for ${extensionId}@${version}.`,
      );
    }

    console.log(
      `Marketplace release verified for ${extensionId}@${version} (${mode}, universal vspackage reachable).`,
    );
    return;
  }

  throw new Error(
    `Marketplace did not expose expected version '${version}' for ${extensionId} before timeout. Last visible version: '${lastPublishedVersion || 'unknown'}'.`,
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});