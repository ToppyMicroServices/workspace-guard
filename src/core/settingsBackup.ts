import { promises as fs } from "node:fs";
import path from "node:path";

export interface SettingsStore {
  getAll: () => Record<string, unknown>;
  update: (key: string, value: unknown) => Promise<void> | void;
}

export interface SettingsMutation {
  key: string;
  previousValue: unknown;
  nextValue: unknown;
}

export interface SettingsBackupOptions {
  backupDir: string;
  timestamp?: string;
}

export interface ApplySettingsOptions extends SettingsBackupOptions {
  backupBeforeApply?: boolean;
}

export interface AppliedSettingsResult {
  backupPath?: string;
  applied: SettingsMutation[];
}

interface SettingsBackupFile {
  snapshot: Record<string, unknown>;
  absentKeys?: string[];
}

function isSettingsBackupFile(value: unknown): value is SettingsBackupFile {
  if (!value || typeof value !== "object" || !("snapshot" in value)) {
    return false;
  }

  const candidate = value as { snapshot: unknown; absentKeys?: unknown };
  return !!candidate.snapshot && typeof candidate.snapshot === "object" && !Array.isArray(candidate.snapshot);
}

function buildBackupFileName(timestamp?: string): string {
  const safeTimestamp = (timestamp ?? new Date().toISOString()).replace(/[:.]/g, "-");
  return `homeguard-settings-backup-${safeTimestamp}.json`;
}

export async function createSettingsBackup(
  snapshot: Record<string, unknown>,
  absentKeys: string[],
  options: SettingsBackupOptions
): Promise<string> {
  await fs.mkdir(options.backupDir, { recursive: true });
  const backupPath = path.join(options.backupDir, buildBackupFileName(options.timestamp));
  const payload: SettingsBackupFile = {
    snapshot,
    absentKeys
  };
  await fs.writeFile(backupPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return backupPath;
}

export async function applySettingsMutations(
  store: SettingsStore,
  mutations: SettingsMutation[],
  options: ApplySettingsOptions
): Promise<AppliedSettingsResult> {
  if (mutations.length === 0) {
    return {
      applied: []
    };
  }

  const snapshot = store.getAll();
  const absentKeys = mutations
    .map((mutation) => mutation.key)
    .filter((key) => !(key in snapshot));
  const backupPath = options.backupBeforeApply === false
    ? undefined
    : await createSettingsBackup(snapshot, absentKeys, options);

  for (const mutation of mutations) {
    await store.update(mutation.key, mutation.nextValue);
  }

  return {
    backupPath,
    applied: mutations
  };
}

export async function rollbackSettingsBackup(
  backupPath: string,
  store: SettingsStore
): Promise<void> {
  const contents = await fs.readFile(backupPath, "utf8");
  const parsed = JSON.parse(contents) as unknown;
  const snapshot = isSettingsBackupFile(parsed)
    ? parsed.snapshot
    : (parsed as Record<string, unknown>);
  const absentKeys = isSettingsBackupFile(parsed)
    ? (parsed.absentKeys ?? [])
    : [];

  for (const [key, value] of Object.entries(snapshot)) {
    await store.update(key, value);
  }

  for (const key of absentKeys) {
    await store.update(key, undefined);
  }
}
