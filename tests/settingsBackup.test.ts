import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applySettingsMutations,
  rollbackSettingsBackup,
  type SettingsMutation,
  type SettingsStore
} from "../src/core/settingsBackup";

class MemorySettingsStore implements SettingsStore {
  public values: Record<string, unknown>;

  public constructor(initial: Record<string, unknown>) {
    this.values = { ...initial };
  }

  public getAll(): Record<string, unknown> {
    return { ...this.values };
  }

  public async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      delete this.values[key];
      return;
    }

    this.values[key] = value;
  }
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dirPath) => {
    await rm(dirPath, { recursive: true, force: true });
  }));
});

describe("settingsBackup", () => {
  it("removes keys that were absent before applying mutations", async () => {
    const backupDir = await mkdtemp(path.join(tmpdir(), "settings-backup-"));
    tempDirs.push(backupDir);
    const store = new MemorySettingsStore({
      "telemetry.telemetryLevel": "all"
    });
    const mutations: SettingsMutation[] = [
      {
        key: "telemetry.telemetryLevel",
        previousValue: "all",
        nextValue: "off"
      },
      {
        key: "github.copilot.advanced.telemetryEnabled",
        previousValue: undefined,
        nextValue: false
      }
    ];

    const result = await applySettingsMutations(store, mutations, {
      backupDir,
      backupBeforeApply: true
    });

    expect(result.backupPath).toBeDefined();
    expect(store.values["github.copilot.advanced.telemetryEnabled"]).toBe(false);

    await rollbackSettingsBackup(result.backupPath as string, store);

    expect(store.values["telemetry.telemetryLevel"]).toBe("all");
    expect("github.copilot.advanced.telemetryEnabled" in store.values).toBe(false);
  });

  it("keeps reading legacy snapshot-only backups", async () => {
    const backupDir = await mkdtemp(path.join(tmpdir(), "settings-backup-"));
    tempDirs.push(backupDir);
    const backupPath = path.join(backupDir, "legacy-backup.json");
    const store = new MemorySettingsStore({
      "telemetry.telemetryLevel": "off",
      "github.copilot.advanced.telemetryEnabled": false
    });

    await writeFile(backupPath, `${JSON.stringify({
      "telemetry.telemetryLevel": "all"
    }, null, 2)}\n`, "utf8");

    await rollbackSettingsBackup(backupPath, store);

    expect(store.values["telemetry.telemetryLevel"]).toBe("all");
    expect(store.values["github.copilot.advanced.telemetryEnabled"]).toBe(false);
  });

  it("records absent keys in the new backup format", async () => {
    const backupDir = await mkdtemp(path.join(tmpdir(), "settings-backup-"));
    tempDirs.push(backupDir);
    const store = new MemorySettingsStore({});

    const result = await applySettingsMutations(store, [
      {
        key: "github.copilot.advanced.telemetryEnabled",
        previousValue: undefined,
        nextValue: false
      }
    ], {
      backupDir,
      backupBeforeApply: true
    });

    const backupContents = JSON.parse(await readFile(result.backupPath as string, "utf8")) as {
      snapshot: Record<string, unknown>;
      absentKeys?: string[];
    };

    expect(backupContents.snapshot).toEqual({});
    expect(backupContents.absentKeys).toEqual(["github.copilot.advanced.telemetryEnabled"]);
  });
});
