import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { DEFAULT_ESCAPE_FOLDER } from "./config";
import { expandPathInput, type SupportedPlatform } from "./pathPolicy";

export interface EscapeFolderFs {
  access: (targetPath: string) => Promise<void>;
  mkdir: (targetPath: string, options?: { recursive?: boolean }) => Promise<string | undefined>;
  writeFile: (targetPath: string, content: string, encoding: BufferEncoding) => Promise<void>;
}

export interface EscapeFolderOptions {
  escapeFolder?: string;
  enableEphemeralEscape?: boolean;
  cwd?: string;
  env?: Record<string, string | undefined>;
  homeDir: string;
  platform?: SupportedPlatform;
  timestamp?: string;
  initFiles?: boolean;
  fs?: EscapeFolderFs;
}

export interface EscapeFolderResult {
  path: string;
  ephemeral: boolean;
  createdFiles: string[];
}

const defaultFs: EscapeFolderFs = {
  access: fs.access,
  mkdir: fs.mkdir,
  writeFile: async (targetPath, content, encoding) => {
    await fs.writeFile(targetPath, content, { encoding });
  }
};

export const EPHEMERAL_ESCAPE_FOLDER_PREFIX = "vscode-home-escape-";

function sanitizeEphemeralSuffix(value: string): string {
  const collapsed = value
    .replace(/[:.]/g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return collapsed || "session";
}

function buildEphemeralFolderName(timestamp?: string): string {
  return `${EPHEMERAL_ESCAPE_FOLDER_PREFIX}${sanitizeEphemeralSuffix(timestamp ?? new Date().toISOString())}`;
}

export function isEphemeralEscapeFolderPath(targetPath: string): boolean {
  return path.dirname(targetPath) === tmpdir() && path.basename(targetPath).startsWith(EPHEMERAL_ESCAPE_FOLDER_PREFIX);
}

export function resolveEscapeFolderPath(options: EscapeFolderOptions): string {
  if (options.enableEphemeralEscape) {
    return path.join(tmpdir(), buildEphemeralFolderName(options.timestamp));
  }

  return expandPathInput(options.escapeFolder ?? DEFAULT_ESCAPE_FOLDER, {
    env: options.env,
    homeDir: options.homeDir,
    platform: options.platform
  });
}

async function writeFileIfMissing(
  fileSystem: EscapeFolderFs,
  targetPath: string,
  content: string
): Promise<boolean> {
  try {
    await fileSystem.access(targetPath);
    return false;
  } catch {
    await fileSystem.writeFile(targetPath, content, "utf8");
    return true;
  }
}

export async function ensureEscapeFolder(options: EscapeFolderOptions): Promise<EscapeFolderResult> {
  const fileSystem = options.fs ?? defaultFs;
  const escapePath = resolveEscapeFolderPath(options);
  const createdFiles: string[] = [];
  const initFiles = options.initFiles ?? true;

  await fileSystem.mkdir(escapePath, { recursive: true });

  if (!options.enableEphemeralEscape && initFiles) {
    const readmePath = path.join(escapePath, "README.md");
    const gitignorePath = path.join(escapePath, ".gitignore");
    const manifestPath = path.join(escapePath, ".homeguard.json");

    if (await writeFileIfMissing(fileSystem, readmePath, "# Escape Folder\nThis folder is used as a safe workspace when opening the entire home directory is blocked or redirected.\n")) {
      createdFiles.push(readmePath);
    }

    if (await writeFileIfMissing(fileSystem, gitignorePath, "*\n!.gitignore\n!README.md\n!.homeguard.json\n")) {
      createdFiles.push(gitignorePath);
    }

    if (await writeFileIfMissing(fileSystem, manifestPath, `${JSON.stringify({
      createdBy: "homeguard",
      kind: "escape-folder"
    }, null, 2)}\n`)) {
      createdFiles.push(manifestPath);
    }
  }

  return {
    path: escapePath,
    ephemeral: options.enableEphemeralEscape ?? false,
    createdFiles
  };
}
