import type { OpenClawConfig } from "openclaw/plugin-sdk";

export const CHANNEL_ID = "openclaw-channel-wap" as const;
export const DEFAULT_ACCOUNT_ID = "default" as const;
export const DEFAULT_PORT = 8765;

export type WapDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

export interface WapAccountConfig {
  enabled?: boolean;
  name?: string;
  authToken?: string;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  dmPolicy?: WapDmPolicy;
  requireMentionInGroup?: boolean;
  silentPairing?: boolean;
  whitelist?: string[];
}

export interface WapChannelConfig extends WapAccountConfig {
  port?: number;
  accounts?: Record<string, WapAccountConfig>;
}

export interface WapAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: WapAccountConfig;
}

type ChannelsConfig = Record<string, unknown> | undefined;

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function mergeAccountConfig(base: WapAccountConfig, next: WapAccountConfig): WapAccountConfig {
  return {
    ...base,
    ...next,
    allowFrom: next.allowFrom ?? base.allowFrom,
    groupAllowFrom: next.groupAllowFrom ?? base.groupAllowFrom,
    whitelist: next.whitelist ?? base.whitelist,
  };
}

export function getWapChannelConfig(cfg: OpenClawConfig): WapChannelConfig {
  const channels = cfg.channels as ChannelsConfig;
  const raw = asObject(channels?.[CHANNEL_ID]);
  if (!raw) {
    return {};
  }
  return raw as WapChannelConfig;
}

export function hasExplicitAccount(cfg: OpenClawConfig, accountId: string): boolean {
  const channelConfig = getWapChannelConfig(cfg);
  return Boolean(channelConfig.accounts?.[accountId]);
}

export function listWapAccountIds(cfg: OpenClawConfig): string[] {
  const channelConfig = getWapChannelConfig(cfg);
  const accountIds = Object.keys(channelConfig.accounts ?? {});
  return accountIds.length > 0 ? accountIds : [DEFAULT_ACCOUNT_ID];
}

export function resolveWapAccount(cfg: OpenClawConfig, accountId?: string | null): WapAccount {
  const id = (accountId ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
  const channelConfig = getWapChannelConfig(cfg);
  const base: WapAccountConfig = {
    enabled: channelConfig.enabled,
    name: channelConfig.name,
    authToken: channelConfig.authToken,
    allowFrom: channelConfig.allowFrom,
    groupAllowFrom: channelConfig.groupAllowFrom,
    dmPolicy: channelConfig.dmPolicy,
    requireMentionInGroup: channelConfig.requireMentionInGroup,
    silentPairing: channelConfig.silentPairing,
    whitelist: channelConfig.whitelist,
  };
  const accountSpecific = channelConfig.accounts?.[id] ?? {};
  const merged = mergeAccountConfig(base, accountSpecific);
  return {
    accountId: id,
    enabled: merged.enabled ?? true,
    name: merged.name,
    config: merged,
  };
}

export function resolveAllowFrom(config: WapAccountConfig): string[] {
  return (config.allowFrom ?? config.whitelist ?? [])
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

export function resolveGroupAllowFrom(config: WapAccountConfig): string[] {
  return (config.groupAllowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

export function normalizeSenderId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.length === 0) {
    return true;
  }
  const normalizedSender = normalizeSenderId(senderId);
  return allowFrom.some((entry) => {
    const normalizedEntry = normalizeSenderId(entry);
    return normalizedEntry === "*" || normalizedEntry === normalizedSender;
  });
}

export const wapChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      name: { type: "string" },
      port: { type: "number" },
      authToken: { type: "string" },
      allowFrom: { type: "array", items: { type: "string" } },
      groupAllowFrom: { type: "array", items: { type: "string" } },
      dmPolicy: {
        type: "string",
        enum: ["open", "pairing", "allowlist", "disabled"],
      },
      requireMentionInGroup: { type: "boolean" },
      silentPairing: { type: "boolean" },
      whitelist: { type: "array", items: { type: "string" } },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            name: { type: "string" },
            authToken: { type: "string" },
            allowFrom: { type: "array", items: { type: "string" } },
            groupAllowFrom: { type: "array", items: { type: "string" } },
            dmPolicy: {
              type: "string",
              enum: ["open", "pairing", "allowlist", "disabled"],
            },
            requireMentionInGroup: { type: "boolean" },
            silentPairing: { type: "boolean" },
            whitelist: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
  uiHints: {
    "channels.openclaw-channel-wap.authToken": {
      sensitive: true,
      help: "Shared WebSocket bearer token (can be overridden per account).",
    },
    "channels.openclaw-channel-wap.accounts.*.authToken": {
      sensitive: true,
      help: "Per-account WebSocket bearer token.",
    },
    "channels.openclaw-channel-wap.whitelist": {
      advanced: true,
      help: "Deprecated alias of allowFrom for backward compatibility.",
    },
    "channels.openclaw-channel-wap.accounts.*.whitelist": {
      advanced: true,
      help: "Deprecated alias of allowFrom for backward compatibility.",
    },
    "channels.openclaw-channel-wap.requireMentionInGroup": {
      help: "When true, group messages trigger only when @mentioned.",
    },
    "channels.openclaw-channel-wap.silentPairing": {
      help: "When true, pairing requests are recorded silently without auto-reply.",
    },
  },
} as const;
