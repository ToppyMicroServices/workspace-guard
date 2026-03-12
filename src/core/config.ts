export type HomeguardMode = "warn" | "redirect" | "block" | "audit-only";

export const DEFAULT_ESCAPE_FOLDER = "~/work/_escape";

export interface HomeguardCliSettings {
  checkDotFromHome: boolean;
  redirectDotFromHomeToEscape: boolean;
}

export interface HomeguardPrivacySettings {
  auditOnStartup: boolean;
  offerHardening: boolean;
  knownTelemetryProfile: "default";
  backupBeforeApply: boolean;
}

export interface HomeguardSafetySettings {
  enableSaveGuard: boolean;
  enableGitGuard: boolean;
  enableTerminalGuard: boolean;
  enableTaskGuard: boolean;
  enableDeleteGuard: boolean;
  enablePublishGuard: boolean;
  requireConfirmationForDestructiveActions: boolean;
  blockHighRiskPublish: boolean;
}

export interface HomeguardSettings {
  enable: boolean;
  mode: HomeguardMode;
  escapeFolder: string;
  enableEphemeralEscape: boolean;
  checkOnStartup: boolean;
  checkOnWorkspaceFolderAdd: boolean;
  allowList: string[];
  highRiskFolders: string[];
  cli: HomeguardCliSettings;
  safety: HomeguardSafetySettings;
  privacy: HomeguardPrivacySettings;
  verbose: boolean;
}

export interface HomeguardSettingsInput {
  enable?: boolean;
  mode?: HomeguardMode;
  escapeFolder?: string;
  enableEphemeralEscape?: boolean;
  checkOnStartup?: boolean;
  checkOnWorkspaceFolderAdd?: boolean;
  allowList?: string[];
  highRiskFolders?: string[];
  cli?: Partial<HomeguardCliSettings>;
  safety?: Partial<HomeguardSafetySettings>;
  privacy?: Partial<HomeguardPrivacySettings>;
  verbose?: boolean;
}

export function getDefaultHomeguardSettings(): HomeguardSettings {
  return {
    enable: true,
    mode: "redirect",
    escapeFolder: DEFAULT_ESCAPE_FOLDER,
    enableEphemeralEscape: false,
    checkOnStartup: true,
    checkOnWorkspaceFolderAdd: true,
    allowList: ["~/work", "~/projects", "~/.config/myapp"],
    highRiskFolders: ["~/.ssh", "~/.gnupg", "~/.aws", "~/.config/gcloud"],
    cli: {
      checkDotFromHome: true,
      redirectDotFromHomeToEscape: true
    },
    safety: {
      enableSaveGuard: true,
      enableGitGuard: true,
      enableTerminalGuard: true,
      enableTaskGuard: true,
      enableDeleteGuard: true,
      enablePublishGuard: true,
      requireConfirmationForDestructiveActions: true,
      blockHighRiskPublish: true
    },
    privacy: {
      auditOnStartup: false,
      offerHardening: true,
      knownTelemetryProfile: "default",
      backupBeforeApply: true
    },
    verbose: false
  };
}

export function resolveHomeguardSettings(input: HomeguardSettingsInput = {}): HomeguardSettings {
  const defaults = getDefaultHomeguardSettings();

  return {
    ...defaults,
    ...input,
    allowList: input.allowList ?? defaults.allowList,
    highRiskFolders: input.highRiskFolders ?? defaults.highRiskFolders,
    cli: {
      ...defaults.cli,
      ...input.cli
    },
    safety: {
      ...defaults.safety,
      ...input.safety
    },
    privacy: {
      ...defaults.privacy,
      ...input.privacy
    }
  };
}