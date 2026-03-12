export interface OutputChannelLike {
  appendLine: (value: string) => void;
  show?: (preserveFocus?: boolean) => void;
}

export interface HomeguardLoggerOptions {
  homeDir: string;
  verbose?: boolean;
}

function sanitizeString(value: string, homeDir: string): string {
  if (value === homeDir) {
    return "~";
  }

  if (value.startsWith(`${homeDir}/`)) {
    return `~${value.slice(homeDir.length)}`;
  }

  return value;
}

function sanitizeValue(value: unknown, homeDir: string): unknown {
  if (typeof value === "string") {
    return sanitizeString(value, homeDir);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, homeDir));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry, homeDir)])
    );
  }

  return value;
}

export class HomeguardLogger {
  private readonly channel: OutputChannelLike;
  private readonly homeDir: string;
  private readonly verboseEnabled: boolean;

  public constructor(channel: OutputChannelLike, options: HomeguardLoggerOptions) {
    this.channel = channel;
    this.homeDir = options.homeDir;
    this.verboseEnabled = options.verbose ?? false;
  }

  public log(event: string, metadata: Record<string, unknown> = {}): void {
    const sanitized = sanitizeValue(metadata, this.homeDir);
    this.channel.appendLine(`[${event}] ${JSON.stringify(sanitized)}`);
  }

  public verbose(message: string, metadata: Record<string, unknown> = {}): void {
    if (!this.verboseEnabled) {
      return;
    }

    this.log(`verbose:${message}`, metadata);
  }

  public show(preserveFocus = true): void {
    this.channel.show?.(preserveFocus);
  }
}