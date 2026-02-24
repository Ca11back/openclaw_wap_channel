import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  hasExplicitAccount,
  resolveGroupAllowChats,
  resolveGroupPolicy,
  listWapAccountIds,
  looksLikeWapTargetId,
  normalizeWapMessagingTarget,
  resolveAllowFrom,
  resolveWapOutboundTarget,
  resolveWapAccount,
  type WapAccount,
  wapChannelConfigSchema,
} from "./config.js";
import { getClientCount, getClientStats, getWapRuntime, sendToClient } from "./ws-server.js";

function getAccountClientCount(accountId: string): number {
  return getClientStats().filter((client) => client.accountId === accountId).length;
}

function resolvePolicyPath(cfg: OpenClawConfig, account: WapAccount): string {
  if (hasExplicitAccount(cfg, account.accountId)) {
    return `channels.${CHANNEL_ID}.accounts.${account.accountId}.`;
  }
  return `channels.${CHANNEL_ID}.`;
}

export const wapPlugin: ChannelPlugin<WapAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "WeChat (WAP)",
    selectionLabel: "WeChat via WAuxiliary",
    docsPath: "/channels/openclaw-channel-wap",
    blurb: "WeChat messaging via WAuxiliary Android plugin.",
    aliases: ["wechat", "wx"],
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "wxid",
    normalizeAllowEntry: normalizeWapMessagingTarget,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    threads: false,
    reactions: false,
    nativeCommands: false,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  configSchema: wapChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listWapAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWapAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => getAccountClientCount(account.accountId) > 0,
    describeAccount: (account) => {
      const allowFrom = resolveAllowFrom(account.config);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: getAccountClientCount(account.accountId) > 0,
        connectedClients: getAccountClientCount(account.accountId),
        dmPolicy: account.config.dmPolicy ?? "pairing",
        groupPolicy: resolveGroupPolicy(account.config),
        groupAllowChats: resolveGroupAllowChats(account.config),
        allowFrom,
      };
    },
    resolveAllowFrom: ({ cfg, accountId }) => resolveAllowFrom(resolveWapAccount(cfg, accountId).config),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter((entry): entry is string => Boolean(entry)),
  },
  security: {
    resolveDmPolicy: ({ cfg, account }) => {
      const basePath = resolvePolicyPath(cfg, account);
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: resolveAllowFrom(account.config),
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
      };
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId }) => {
      const account = resolveWapAccount(cfg, accountId);
      return account.config.requireMentionInGroup ?? true;
    },
  },
  messaging: {
    normalizeTarget: normalizeWapMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeWapTargetId,
      hint: "<wxid|chatroom_talker>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    resolveTarget: ({ to, allowFrom, mode }) =>
      resolveWapOutboundTarget({
        to,
        allowFrom,
        mode,
      }),
    sendText: async ({ to, text, accountId }) => {
      const runtime = getWapRuntime();
      const effectiveAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const normalizedTarget = normalizeWapMessagingTarget(to);
      const sent = sendToClient(
        {
          type: "send_text",
          data: { talker: normalizedTarget, content: text },
        },
        effectiveAccountId,
      );
      if (!sent) {
        runtime?.logger.warn(
          `WAP sendText failed: no connected clients for account ${effectiveAccountId}`,
        );
        return {
          ok: false,
          error: "No connected WAP clients",
          channel: CHANNEL_ID,
        };
      }
      runtime?.logger.debug(`WAP sendText to ${normalizedTarget}: ${text.substring(0, 50)}...`);
      return { ok: true, channel: CHANNEL_ID };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const runtime = getWapRuntime();
      if (!mediaUrl) {
        return {
          ok: false,
          error: "mediaUrl is required",
          channel: CHANNEL_ID,
        };
      }
      const effectiveAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const normalizedTarget = normalizeWapMessagingTarget(to);
      const content = text ? `${text}\n\nAttachment: ${mediaUrl}` : `Attachment: ${mediaUrl}`;
      const sent = sendToClient(
        {
          type: "send_text",
          data: { talker: normalizedTarget, content },
        },
        effectiveAccountId,
      );
      if (!sent) {
        runtime?.logger.warn(
          `WAP sendMedia failed: no connected clients for account ${effectiveAccountId}`,
        );
        return {
          ok: false,
          error: "No connected WAP clients",
          channel: CHANNEL_ID,
        };
      }
      runtime?.logger.debug(`WAP sendMedia to ${normalizedTarget}: ${mediaUrl}`);
      return { ok: true, channel: CHANNEL_ID };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => {
      const accountClients = getAccountClientCount(account.accountId);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: accountClients > 0,
        running: runtime?.running ?? accountClients > 0,
        connectedClients: accountClients,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
      };
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      connectedClients: (snapshot as { connectedClients?: number }).connectedClients ?? 0,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      totalClients: getClientCount(),
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      ctx.setStatus({
        accountId: ctx.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    },
    stopAccount: async (ctx) => {
      ctx.setStatus({
        accountId: ctx.accountId,
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
