import type { OpenClawConfig } from "openclaw/plugin-sdk";

export const CHANNEL_ID = "openclaw-channel-wap" as const;
export const DEFAULT_ACCOUNT_ID = "default" as const;
export const DEFAULT_PORT = 8765;
export const DEFAULT_HOST = "127.0.0.1" as const;

export type WapDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
export type WapGroupPolicy = "open" | "allowlist" | "disabled";

export interface WapAccountConfig {
  enabled?: boolean;
  name?: string;
  authToken?: string;
  allowFrom?: string[];
  groupPolicy?: WapGroupPolicy;
  groupAllowChats?: string[];
  groupAllowFrom?: string[];
  noMentionContextGroups?: string[];
  noMentionContextHistoryLimit?: number;
  dmPolicy?: WapDmPolicy;
  requireMentionInGroup?: boolean;
  silentPairing?: boolean;
}

export interface WapChannelConfig extends WapAccountConfig {
  host?: string;
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
    groupAllowChats: next.groupAllowChats ?? base.groupAllowChats,
    groupAllowFrom: next.groupAllowFrom ?? base.groupAllowFrom,
    noMentionContextGroups: next.noMentionContextGroups ?? base.noMentionContextGroups,
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
    groupPolicy: channelConfig.groupPolicy,
    groupAllowChats: channelConfig.groupAllowChats,
    groupAllowFrom: channelConfig.groupAllowFrom,
    noMentionContextGroups: channelConfig.noMentionContextGroups,
    noMentionContextHistoryLimit: channelConfig.noMentionContextHistoryLimit,
    dmPolicy: channelConfig.dmPolicy,
    requireMentionInGroup: channelConfig.requireMentionInGroup,
    silentPairing: channelConfig.silentPairing,
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
  return (config.allowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

export function resolveGroupPolicy(config: WapAccountConfig): WapGroupPolicy {
  return config.groupPolicy ?? "open";
}

export function resolveGroupAllowChats(config: WapAccountConfig): string[] {
  return (config.groupAllowChats ?? [])
    .map((entry) => normalizeWapMessagingTarget(String(entry)))
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function resolveGroupAllowFrom(config: WapAccountConfig): string[] {
  return (config.groupAllowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

export function resolveNoMentionContextGroups(config: WapAccountConfig): string[] {
  return (config.noMentionContextGroups ?? [])
    .map((entry) => normalizeWapMessagingTarget(String(entry)))
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function resolveNoMentionContextHistoryLimit(config: WapAccountConfig): number {
  const raw = Number(config.noMentionContextHistoryLimit);
  if (!Number.isFinite(raw)) {
    return 8;
  }
  const normalized = Math.trunc(raw);
  if (normalized < 0) {
    return 0;
  }
  if (normalized > 50) {
    return 50;
  }
  return normalized;
}

export function normalizeSenderId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeWapMessagingTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^(wechat|wx|wap):/i, "").trim();
}

export function looksLikeWapTargetId(raw: string): boolean {
  const normalized = normalizeWapMessagingTarget(raw);
  if (!normalized) {
    return false;
  }
  const lower = normalized.toLowerCase();
  if (
    lower.startsWith("group:") ||
    lower.startsWith("room:") ||
    lower.startsWith("chatroom:") ||
    lower.startsWith("friend:") ||
    lower.startsWith("user:") ||
    lower.startsWith("contact:") ||
    lower.startsWith("remark:") ||
    lower.startsWith("nickname:") ||
    lower.startsWith("name:") ||
    lower.startsWith("id:") ||
    lower.startsWith("wxid:")
  ) {
    return true;
  }
  if (normalized.endsWith("@chatroom")) {
    return true;
  }
  if (/^wxid_[A-Za-z0-9_-]+$/.test(normalized)) {
    return true;
  }
  // Allow plain names (e.g. short aliases like "HH") and resolve them on WAuxiliary side.
  return normalized.length > 0;
}

export function resolveWapOutboundTarget(params: {
  to?: string;
  allowFrom?: string[];
  mode?: "explicit" | "implicit" | "heartbeat";
}): { ok: true; to: string } | { ok: false; error: Error } {
  const mode = params.mode ?? "explicit";
  const explicitTarget = params.to ? normalizeWapMessagingTarget(params.to) : "";
  if (explicitTarget) {
    return { ok: true, to: explicitTarget };
  }

  const normalizedAllowFrom = (params.allowFrom ?? [])
    .map((entry) => normalizeWapMessagingTarget(String(entry)))
    .filter((entry): entry is string => Boolean(entry));
  const fallbackTarget = normalizedAllowFrom[0];
  if (mode !== "explicit" && fallbackTarget) {
    return { ok: true, to: fallbackTarget };
  }

  return {
    ok: false,
    error: new Error(
      `Missing WeChat target. Provide ${mode === "explicit" ? "--to <wxid|group:群名|friend:备注>" : "wxid/group:群名/friend:备注"}.`,
    ),
  };
}

export function isSenderAllowed(
  senderId: string,
  allowFrom: string[],
  allowWhenEmpty = true,
): boolean {
  if (allowFrom.length === 0) {
    return allowWhenEmpty;
  }
  const normalizedSender = normalizeSenderId(senderId);
  return allowFrom.some((entry) => {
    const normalizedEntry = normalizeSenderId(entry);
    return normalizedEntry === "*" || normalizedEntry === normalizedSender;
  });
}

export function isGroupChatAllowed(
  talker: string,
  groupPolicy: WapGroupPolicy,
  groupAllowChats: string[],
): boolean {
  if (groupPolicy === "disabled") {
    return false;
  }
  if (groupPolicy === "open") {
    return true;
  }
  if (groupAllowChats.length === 0) {
    return false;
  }
  const normalizedTalker = normalizeWapMessagingTarget(talker).trim().toLowerCase();
  return groupAllowChats.some((entry) => entry === "*" || entry === normalizedTalker);
}

export function isNoMentionContextGroupEnabled(talker: string, groups: string[]): boolean {
  if (groups.length === 0) {
    return false;
  }
  const normalizedTalker = normalizeWapMessagingTarget(talker).trim().toLowerCase();
  return groups.some((entry) => entry === "*" || entry === normalizedTalker);
}

export const wapChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      name: { type: "string" },
      host: { type: "string" },
      port: { type: "number" },
      authToken: { type: "string" },
      allowFrom: { type: "array", items: { type: "string" } },
      groupPolicy: {
        type: "string",
        enum: ["open", "allowlist", "disabled"],
      },
      groupAllowChats: { type: "array", items: { type: "string" } },
      groupAllowFrom: { type: "array", items: { type: "string" } },
      noMentionContextGroups: { type: "array", items: { type: "string" } },
      noMentionContextHistoryLimit: { type: "number" },
      dmPolicy: {
        type: "string",
        enum: ["open", "pairing", "allowlist", "disabled"],
      },
      requireMentionInGroup: { type: "boolean" },
      silentPairing: { type: "boolean" },
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
            groupPolicy: {
              type: "string",
              enum: ["open", "allowlist", "disabled"],
            },
            groupAllowChats: { type: "array", items: { type: "string" } },
            groupAllowFrom: { type: "array", items: { type: "string" } },
            noMentionContextGroups: { type: "array", items: { type: "string" } },
            noMentionContextHistoryLimit: { type: "number" },
            dmPolicy: {
              type: "string",
              enum: ["open", "pairing", "allowlist", "disabled"],
            },
            requireMentionInGroup: { type: "boolean" },
            silentPairing: { type: "boolean" },
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
    "channels.openclaw-channel-wap.requireMentionInGroup": {
      help: "When true, group messages trigger only when @mentioned.",
    },
    "channels.openclaw-channel-wap.groupPolicy": {
      help: "Group policy: open (all groups), allowlist (groupAllowChats only), disabled.",
    },
    "channels.openclaw-channel-wap.groupAllowChats": {
      help: "Allowed group talker IDs when groupPolicy=allowlist (supports '*').",
    },
    "channels.openclaw-channel-wap.noMentionContextGroups": {
      help: "Groups where non-mention messages are uploaded as context only (supports '*').",
    },
    "channels.openclaw-channel-wap.noMentionContextHistoryLimit": {
      help: "Pending context entries kept per group for no-mention messages.",
    },
    "channels.openclaw-channel-wap.silentPairing": {
      help: "When true, pairing requests are recorded silently without auto-reply.",
    },
  },
} as const;
