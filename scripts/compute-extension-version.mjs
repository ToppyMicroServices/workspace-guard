#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? undefined : Number(match[3])
  };
}

function formatVersion(parts) {
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

function computeNextReleaseVersion(version) {
  const parsed = parseVersion(version);
  if (parsed.patch === undefined) {
    return formatVersion({
      major: parsed.major,
      minor: parsed.minor + 1,
      patch: 0
    });
  }

  return formatVersion({
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch + 1
  });
}

function computeNextDailyVersion(version, sequence) {
  const parsed = parseVersion(version);
  return formatVersion({
    major: parsed.major,
    minor: parsed.minor + 1,
    patch: sequence
  });
}

async function writePackageVersions(version) {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  packageJson.version = version;
  await writeFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
  packageLock.version = version;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = version;
  }
  await writeFile("package-lock.json", `${JSON.stringify(packageLock, null, 2)}\n`, "utf8");
}

async function main() {
  const [mode, versionArg, sequenceArg, flag] = process.argv.slice(2);
  if (!mode || !versionArg) {
    throw new Error("Usage: compute-extension-version.mjs <next-release|next-daily> <version> [sequence] [--write-package]");
  }

  let nextVersion;
  if (mode === "next-release") {
    nextVersion = computeNextReleaseVersion(versionArg);
  } else if (mode === "next-daily") {
    if (!sequenceArg) {
      throw new Error("next-daily requires a numeric sequence argument");
    }
    const sequence = Number(sequenceArg);
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new Error(`Invalid daily sequence: ${sequenceArg}`);
    }
    nextVersion = computeNextDailyVersion(versionArg, sequence);
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }

  if (flag === "--write-package") {
    await writePackageVersions(nextVersion);
  }

  process.stdout.write(`${nextVersion}\n`);
}

await main();
