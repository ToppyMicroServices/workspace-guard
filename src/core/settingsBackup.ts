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

interface SettingsBackupPayload {
  snapshot: Record<string, unknown>;
  removedOnRollback: string[];
}

function buildBackupFileName(timestamp?: string): string {
  const safeTimestamp = (timestamp ?? new Date().toISOString()).replace(/[:.]/g, "-");
  return `homeguard-settings-backup-${safeTimestamp}.json`;
}

export async function createSettingsBackup(
  snapshot: Record<string, unknown>,
  removedOnRollback: string[],
  options: SettingsBackupOptions
): Promise<string> {
  await fs.mkdir(options.backupDir, { recursive: true });
  const backupPath = path.join(options.backupDir, buildBackupFileName(options.timestamp));
  const payload: SettingsBackupPayload = {
    snapshot,
    removedOnRollback
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
  const removedOnRollback = mutations
    .map((mutation) => mutation.key)
    .filter((key) => !(key in snapshot));
  const backupPath = options.backupBeforeApply === false
    ? undefined
    : await createSettingsBackup(snapshot, removedOnRollback, options);

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
  const parsed = JSON.parse(contents) as Record<string, unknown>;
  const snapshot = "snapshot" in parsed
    ? parsed.snapshot as Record<string, unknown>
    : parsed;
  const removedOnRollback = Array.isArray(parsed.removedOnRollback)
    ? parsed.removedOnRollback.filter((key): key is string => typeof key === "string")
    : [];

  for (const [key, value] of Object.entries(snapshot)) {
    await store.update(key, value);
  }

  for (const key of removedOnRollback) {
    await store.update(key, undefined);
  }
}
