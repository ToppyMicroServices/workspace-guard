import type { AppliedSettingsResult, SettingsMutation, SettingsStore } from "./settingsBackup";
import { applySettingsMutations, rollbackSettingsBackup } from "./settingsBackup";

export type TelemetryAuditStatus = "Safe" | "Actionable" | "Unknown" | "Risky";

export interface TelemetryProfileEntry {
  key: string;
  label: string;
  desiredValue: unknown;
  extensionId?: string;
}

export interface InstalledExtensionInfo {
  id: string;
  displayName?: string;
  tags?: string[];
}

export interface TelemetryAuditItem {
  key: string;
  label: string;
  extensionId?: string;
  currentValue: unknown;
  desiredValue: unknown;
  status: TelemetryAuditStatus;
}

export interface ExtensionAuditItem {
  id: string;
  status: TelemetryAuditStatus;
  reason: string;
}

export interface TelemetryAuditReport {
  settings: TelemetryAuditItem[];
  extensions: ExtensionAuditItem[];
  actionableChanges: SettingsMutation[];
}

export const DEFAULT_TELEMETRY_PROFILE: TelemetryProfileEntry[] = [
  {
    key: "telemetry.telemetryLevel",
    label: "VS Code telemetry level",
    desiredValue: "off"
  },
  {
    key: "redhat.telemetry.enabled",
    label: "Red Hat telemetry",
    desiredValue: false,
    extensionId: "redhat.vscode-yaml"
  },
  {
    key: "github.copilot.advanced.telemetryEnabled",
    label: "GitHub Copilot telemetry",
    desiredValue: false,
    extensionId: "github.copilot"
  },
  {
    key: "azure.telemetry.enabled",
    label: "Azure extension telemetry",
    desiredValue: false,
    extensionId: "ms-azuretools.vscode-azureappservice"
  },
  {
    key: "python.experiments.enabled",
    label: "Python extension experiments",
    desiredValue: false,
    extensionId: "ms-python.python"
  }
];

function isRiskyExtension(extension: InstalledExtensionInfo): boolean {
  const searchable = [extension.id, extension.displayName ?? "", ...(extension.tags ?? [])]
    .join(" ")
    .toLowerCase();
  return /(copilot|assistant|ai|remote|cloud|sync|telemetry|language server)/.test(searchable);
}

export function auditTelemetrySettings(
  currentSettings: Record<string, unknown>,
  installedExtensions: InstalledExtensionInfo[] = [],
  profile: TelemetryProfileEntry[] = DEFAULT_TELEMETRY_PROFILE
): TelemetryAuditReport {
  const settings = profile.map<TelemetryAuditItem>((entry) => {
    const currentValue = currentSettings[entry.key];
    const status: TelemetryAuditStatus = Object.is(currentValue, entry.desiredValue)
      ? "Safe"
      : "Actionable";

    return {
      key: entry.key,
      label: entry.label,
      extensionId: entry.extensionId,
      currentValue,
      desiredValue: entry.desiredValue,
      status
    };
  });

  const actionableChanges = settings
    .filter((entry) => entry.status === "Actionable")
    .map<SettingsMutation>((entry) => ({
      key: entry.key,
      previousValue: currentSettings[entry.key],
      nextValue: entry.desiredValue
    }));

  const knownExtensionIds = new Set(profile.flatMap((entry) => entry.extensionId ? [entry.extensionId] : []));
  const extensions = installedExtensions.map<ExtensionAuditItem>((extension) => {
    if (knownExtensionIds.has(extension.id)) {
      const relatedItems = settings.filter((entry) => entry.extensionId === extension.id);
      const status = relatedItems.every((entry) => entry.status === "Safe") ? "Safe" : "Actionable";
      return {
        id: extension.id,
        status,
        reason: status === "Safe" ? "Known telemetry settings already hardened." : "Known telemetry settings can be hardened."
      };
    }

    if (isRiskyExtension(extension)) {
      return {
        id: extension.id,
        status: "Risky",
        reason: "Communication-heavy extension with unknown HomeGuard profile."
      };
    }

    return {
      id: extension.id,
      status: "Unknown",
      reason: "No known telemetry profile for this extension."
    };
  });

  return {
    settings,
    extensions,
    actionableChanges
  };
}

export async function applyTelemetryHardening(
  store: SettingsStore,
  options: {
    backupDir: string;
    backupBeforeApply?: boolean;
    timestamp?: string;
    installedExtensions?: InstalledExtensionInfo[];
    profile?: TelemetryProfileEntry[];
  }
): Promise<TelemetryAuditReport & AppliedSettingsResult> {
  const report = auditTelemetrySettings(
    store.getAll(),
    options.installedExtensions,
    options.profile
  );
  const applied = await applySettingsMutations(store, report.actionableChanges, {
    backupDir: options.backupDir,
    backupBeforeApply: options.backupBeforeApply,
    timestamp: options.timestamp
  });

  return {
    ...report,
    ...applied
  };
}

export async function rollbackTelemetryHardening(
  backupPath: string,
  store: SettingsStore
): Promise<void> {
  await rollbackSettingsBackup(backupPath, store);
}