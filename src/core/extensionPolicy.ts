import type { InstalledExtensionInfo } from "./telemetry";

export interface ExtensionPolicyFinding {
  id: string;
  extensionId: string;
  severity: "medium" | "high";
  message: string;
}

const RISKY_EXTENSION_PATTERN = /(shell|command|task|terminal|runner|code[- ]runner|script|executor|automation)/i;

export function reviewInstalledExtensions(
  installedExtensions: InstalledExtensionInfo[] = [],
  allowedExtensionIds: string[] = []
): ExtensionPolicyFinding[] {
  const allowSet = new Set(allowedExtensionIds.map((entry) => entry.trim()).filter(Boolean));

  return installedExtensions.flatMap<ExtensionPolicyFinding>((extension) => {
    if (allowSet.has(extension.id)) {
      return [];
    }

    const searchable = [extension.id, extension.displayName ?? "", ...(extension.tags ?? [])]
      .join(" ");

    if (!RISKY_EXTENSION_PATTERN.test(searchable)) {
      return [];
    }

    return [{
      id: "WG-EXT-001",
      extensionId: extension.id,
      severity: "high",
      message: `Installed extension ${extension.id} looks like a command-executing or automation extension and is not on the approved allowlist.`
    }];
  });
}
