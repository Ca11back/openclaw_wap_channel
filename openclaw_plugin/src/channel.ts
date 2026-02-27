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
import {
  buildWapMediaCommand,
  getClientCount,
  getClientStats,
  getWapRuntime,
  resolveTargetViaClient,
  sendToClient,
} from "./ws-server.js";

function getAccountClientCount(accountId: string): number {
  return getClientStats().filter((client) => client.accountId === accountId).length;
}

function isAccountConfigured(account: WapAccount): boolean {
  const token = account.config.authToken ?? process.env.WAP_AUTH_TOKEN;
  return typeof token === "string" && token.trim().length > 0;
}

function resolvePolicyPath(cfg: OpenClawConfig, account: WapAccount): string {
  if (hasExplicitAccount(cfg, account.accountId)) {
    return `channels.${CHANNEL_ID}.accounts.${account.accountId}.`;
  }
  return `channels.${CHANNEL_ID}.`;
}

function pickString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeToolTarget(raw: string): string {
  const normalized = normalizeWapMessagingTarget(raw);
  if (!normalized) {
    return "";
  }
  const prefixed = normalized.match(/^(group|direct|user|friend):(.+)$/i);
  if (!prefixed) {
    return normalized;
  }
  const prefix = prefixed[1].toLowerCase();
  const body = prefixed[2]?.trim() ?? "";
  if (!body) {
    return "";
  }
  if (prefix === "group") {
    return body.endsWith("@chatroom") ? `group:${body}` : "";
  }
  return `user:${body}`;
}

function parseSendTarget(raw: string): { target: string; kind: "direct" | "group" } | null {
  const normalized = normalizeWapMessagingTarget(raw);
  if (!normalized) {
    return null;
  }
  const prefixed = normalized.match(/^(user|direct|friend|group):(.+)$/i);
  if (!prefixed) {
    return null;
  }
  const body = prefixed[2]?.trim() ?? "";
  if (!body) {
    return null;
  }
  const prefix = prefixed[1].toLowerCase();
  if (prefix === "group") {
    if (!body.endsWith("@chatroom")) {
      return null;
    }
    return { target: body, kind: "group" };
  }
  return { target: body, kind: "direct" };
}

function decorateCanonicalTarget(target: string): string {
  return target.endsWith("@chatroom") ? `group:${target}` : `user:${target}`;
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
    media: true,
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
    isConfigured: (account) => isAccountConfigured(account),
    describeAccount: (account) => {
      const allowFrom = resolveAllowFrom(account.config);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: isAccountConfigured(account),
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
      hint: "<user:direct_id|group:group_id@chatroom>",
    },
  },
  actions: {
    listActions: () => ["search"],
    supportsAction: ({ action }) => action === "search",
    extractToolSend: ({ args }) => {
      const action = pickString(args.action).toLowerCase();
      if (action && action !== "send") {
        getWapRuntime()?.logger.debug(
          `WAP extractToolSend skipped non-send action=${action || "<empty>"}`,
        );
        return null;
      }
      const rawTarget =
        pickString(args.target) ||
        pickString(args.to) ||
        pickString(args.recipient) ||
        pickString(args.talker);
      const to = normalizeToolTarget(rawTarget);
      if (!to) {
        getWapRuntime()?.logger.debug(
          `WAP extractToolSend no target resolved rawTarget=${rawTarget || "<empty>"}`,
        );
        return null;
      }
      const accountId =
        pickString(args.accountId) ||
        pickString(args.account_id) ||
        pickString(args.account) ||
        null;
      return { to, accountId };
    },
    handleAction: async ({ action, params, accountId }) => {
      const runtime = getWapRuntime();
      runtime?.logger.debug(
        `WAP action called action=${action} account=${accountId ?? DEFAULT_ACCOUNT_ID}`,
      );
      if (action !== "search") {
        throw new Error(`WAP action not supported: ${action}`);
      }
      const queryRaw =
        (typeof params.query === "string" ? params.query : "") ||
        (typeof params.target === "string" ? params.target : "") ||
        (typeof params.to === "string" ? params.to : "");
      const query = normalizeWapMessagingTarget(queryRaw);
      if (!query) {
        runtime?.logger.debug("WAP search aborted: empty query");
        throw new Error("WAP search requires query/target");
      }
      const effectiveAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      runtime?.logger.debug(
        `WAP search start account=${effectiveAccountId} query=${query}`,
      );
      const resolved = await resolveTargetViaClient({
        target: query,
        accountId: effectiveAccountId,
      });
      if (!resolved.ok) {
        runtime?.logger.debug(
          `WAP search failed account=${effectiveAccountId} query=${query} error=${resolved.error}`,
        );
        throw new Error(resolved.error);
      }
      const kind = resolved.kind === "group" || resolved.talker.endsWith("@chatroom") ? "group" : "direct";
      const canonicalTarget = decorateCanonicalTarget(resolved.talker);
      runtime?.logger.debug(
        `WAP search ok account=${effectiveAccountId} query=${query} canonical=${canonicalTarget} kind=${kind}`,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                input: queryRaw,
                canonicalTarget,
                targetKind: kind,
                usage: "Use canonicalTarget as message target",
              },
              null,
              2,
            ),
          },
        ],
      } as unknown;
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
      const parsedTarget = parseSendTarget(to);
      if (!parsedTarget) {
        runtime?.logger.warn(
          `WAP sendText rejected non-typed target account=${effectiveAccountId} target=${to}`,
        );
        return {
          ok: false,
          error: "Missing/invalid WeChat target. Provide <user:direct_id|group:group_id@chatroom>.",
          channel: CHANNEL_ID,
        };
      }
      const resolvedTarget = await resolveTargetViaClient({
        target: parsedTarget.target,
        accountId: effectiveAccountId,
      });
      if (!resolvedTarget.ok) {
        runtime?.logger.warn(
          `WAP sendText target resolve failed account=${effectiveAccountId} target=${parsedTarget.target}: ${resolvedTarget.error}`,
        );
        return {
          ok: false,
          error: resolvedTarget.error,
          channel: CHANNEL_ID,
        };
      }
      const resolvedKind =
        resolvedTarget.kind === "group" || resolvedTarget.talker.endsWith("@chatroom")
          ? "group"
          : "direct";
      if (
        resolvedTarget.talker.toLowerCase() !== parsedTarget.target.toLowerCase() ||
        resolvedKind !== parsedTarget.kind
      ) {
        const canonicalTarget = decorateCanonicalTarget(resolvedTarget.talker);
        return {
          ok: false,
          error: `Target "${to}" is not canonical. Use message action=search and resend with canonicalTarget "${canonicalTarget}".`,
          channel: CHANNEL_ID,
        };
      }
      const sent = sendToClient(
        {
          type: "send_text",
          data: { talker: resolvedTarget.talker, content: text },
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
      runtime?.logger.debug(
        `WAP sendText to ${resolvedTarget.talker} (from ${to}): ${text.substring(0, 50)}...`,
      );
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
      const parsedTarget = parseSendTarget(to);
      if (!parsedTarget) {
        runtime?.logger.warn(
          `WAP sendMedia rejected non-typed target account=${effectiveAccountId} target=${to}`,
        );
        return {
          ok: false,
          error: "Missing/invalid WeChat target. Provide <user:direct_id|group:group_id@chatroom>.",
          channel: CHANNEL_ID,
        };
      }
      const resolvedTarget = await resolveTargetViaClient({
        target: parsedTarget.target,
        accountId: effectiveAccountId,
      });
      if (!resolvedTarget.ok) {
        runtime?.logger.warn(
          `WAP sendMedia target resolve failed account=${effectiveAccountId} target=${parsedTarget.target}: ${resolvedTarget.error}`,
        );
        return {
          ok: false,
          error: resolvedTarget.error,
          channel: CHANNEL_ID,
        };
      }
      const resolvedKind =
        resolvedTarget.kind === "group" || resolvedTarget.talker.endsWith("@chatroom")
          ? "group"
          : "direct";
      if (
        resolvedTarget.talker.toLowerCase() !== parsedTarget.target.toLowerCase() ||
        resolvedKind !== parsedTarget.kind
      ) {
        const canonicalTarget = decorateCanonicalTarget(resolvedTarget.talker);
        return {
          ok: false,
          error: `Target "${to}" is not canonical. Use message action=search and resend with canonicalTarget "${canonicalTarget}".`,
          channel: CHANNEL_ID,
        };
      }
      const command = await buildWapMediaCommand({
        source: mediaUrl,
        talker: resolvedTarget.talker,
        accountId: effectiveAccountId,
        caption: text || undefined,
      });
      if (!command) {
        return {
          ok: false,
          error: "WAP media sync failed (invalid URL or local file path unavailable)",
          channel: CHANNEL_ID,
        };
      }
      const sent = sendToClient(command, effectiveAccountId);
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
      runtime?.logger.debug(
        `WAP sendMedia to ${resolvedTarget.talker} (from ${to}): ${mediaUrl}`,
      );
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
        configured: isAccountConfigured(account),
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
