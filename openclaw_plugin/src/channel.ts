import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  hasExplicitAccount,
  listWapAccountIds,
  looksLikeWapTargetId,
  normalizeWapMessagingTarget,
  resolveAllowFrom,
  resolveGroupAllowChats,
  resolveGroupPolicy,
  resolveWapAccount,
  resolveWapGroupRequireMention,
  resolveWapGroupSystemPrompt,
  resolveWapGroupToolPolicy,
  resolveWapOutboundTarget,
  type WapAccount,
  wapChannelConfigSchema,
} from "./config.js";
import { getClientCount, getClientStats, getWapRuntime } from "./ws-server.js";
import {
  buildWapClientDiagnostics,
  listWapFriends,
  listWapGroups,
  lookupWapTargets,
  sendWapMediaToCanonicalTarget,
  sendWapTextToCanonicalTarget,
  type WapLookupKind,
} from "./operations.js";
import { resolveReplyMediaUrls } from "./reply-media.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

function jsonResult(details: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

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

function buildPairingApproveHint(): string {
  return `Approve via: openclaw pairing list ${CHANNEL_ID} / openclaw pairing approve ${CHANNEL_ID} <code>`;
}

function describeWapMessageTool() {
  return {
    actions: ["search", "send"],
  };
}

function normalizeOptionalString(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed && !allowEmpty) {
    return undefined;
  }
  return trimmed;
}

function normalizeLookupKind(value: unknown): WapLookupKind {
  return value === "user" || value === "group" ? value : "all";
}

function resolveReplyToMessageId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return undefined;
}

function looksLikeImageSource(raw: string, fileName?: string): boolean {
  const source = (fileName ?? raw).split("#", 1)[0]?.split("?", 1)[0] ?? fileName ?? raw;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(source);
}

async function executeCanonicalWapSend(params: {
  to: string;
  text?: string;
  mediaUrl?: string;
  fileName?: string;
  accountId?: string | null;
  replyToMessageId?: number;
}): Promise<{ ok: true; details: unknown } | { ok: false; error: string; code?: string }> {
  const target = normalizeWapMessagingTarget(params.to);
  if (!target) {
    return {
      ok: false,
      error: "Missing WeChat target. Provide canonical target: <user:wxid> or <group:talker@chatroom>.",
      code: "invalid_canonical_target",
    };
  }
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const text = params.text?.trim() ?? "";
  const mediaUrl = params.mediaUrl?.trim() ?? "";
  let lastSuccess: unknown = {
    ok: true,
    target,
  };

  if (text && mediaUrl) {
    const textResult = await sendWapTextToCanonicalTarget({
      target,
      content: text,
      accountId,
      replyToMessageId: params.replyToMessageId,
    });
    if (!textResult.ok) {
      return {
        ok: false,
        error: textResult.error,
        code: textResult.code,
      };
    }
    lastSuccess = textResult;
  }

  if (mediaUrl) {
    const mediaResult = await sendWapMediaToCanonicalTarget({
      target,
      source: mediaUrl,
      kind: looksLikeImageSource(mediaUrl, params.fileName) ? "image" : "file",
      accountId,
      fileName: params.fileName,
    });
    if (!mediaResult.ok) {
      return {
        ok: false,
        error: mediaResult.error,
        code: mediaResult.code,
      };
    }
    return {
      ok: true,
      details: {
        ...mediaResult,
        ...(text ? { precedingTextSent: true } : {}),
      },
    };
  }

  if (text) {
    const textResult = await sendWapTextToCanonicalTarget({
      target,
      content: text,
      accountId,
      replyToMessageId: params.replyToMessageId,
    });
    if (!textResult.ok) {
      return {
        ok: false,
        error: textResult.error,
        code: textResult.code,
      };
    }
    return {
      ok: true,
      details: textResult,
    };
  }

  return {
    ok: true,
    details: lastSuccess,
  };
}

function extractActionSendTarget(args: Record<string, unknown>) {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (action !== "sendMessage") {
    return null;
  }
  const to = normalizeOptionalString(args.to);
  if (!to) {
    return null;
  }
  const accountId = normalizeOptionalString(args.accountId);
  return accountId ? { to, accountId } : { to };
}

async function handleWapSearchAction(params: {
  params: Record<string, unknown>;
  accountId?: string | null;
}) {
  const query =
    normalizeOptionalString(params.params.query) ??
    normalizeOptionalString(params.params.target) ??
    normalizeOptionalString(params.params.to);
  if (!query) {
    throw new Error("WAP search requires query/target");
  }
  const limitRaw = params.params.limit;
  const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : undefined;
  const result = await lookupWapTargets({
    query,
    accountId: params.accountId,
    kind: normalizeLookupKind(params.params.kind),
    limit,
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return jsonResult({
    ok: true,
    query,
    candidates: result.candidates,
  });
}

async function handleWapSendAction(params: {
  params: Record<string, unknown>;
  accountId?: string | null;
}) {
  const to = normalizeOptionalString(params.params.to);
  const text =
    normalizeOptionalString(params.params.message, true) ??
    normalizeOptionalString(params.params.text, true) ??
    "";
  const mediaUrl =
    normalizeOptionalString(params.params.media) ??
    normalizeOptionalString(params.params.path) ??
    normalizeOptionalString(params.params.filePath) ??
    normalizeOptionalString(params.params.url);
  const fileName =
    normalizeOptionalString(params.params.fileName) ??
    normalizeOptionalString(params.params.name);
  if (!to) {
    throw new Error("WAP send requires `to` canonical target");
  }
  if (!text.trim() && !mediaUrl) {
    throw new Error("WAP send requires at least one of: message/text or media/path/url");
  }
  const result = await executeCanonicalWapSend({
    to,
    text,
    mediaUrl,
    fileName,
    accountId: params.accountId,
    replyToMessageId: resolveReplyToMessageId(params.params.replyTo ?? params.params.replyToMessageId),
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return jsonResult(result.details);
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
    nativeCommands: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Use `wechat_lookup_targets` when you need candidate WeChat recipients before sending.",
      "- Use `wechat_get_friends` and `wechat_get_groups` only for explicit directory inspection.",
      "- Use message action `send` / tool action `sendMessage` with canonical targets only: `user:wxid` or `group:talker@chatroom`.",
      "- WAP no longer supports sending with nickname/remark targets. Resolve candidates first, then send with canonical target.",
    ],
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
        approveHint: buildPairingApproveHint(),
        normalizeEntry: normalizeWapMessagingTarget,
      };
    },
    collectWarnings: ({ accountId }) => {
      const diagnostics = buildWapClientDiagnostics(accountId);
      const warnings: string[] = [];
      if (diagnostics.connectedClients === 0) {
        warnings.push(`No connected WAP clients for account ${diagnostics.accountId}`);
      } else if (!diagnostics.capabilities) {
        warnings.push(`Connected WAP client for account ${diagnostics.accountId} has not advertised capabilities yet`);
      }
      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveWapAccount(cfg, accountId);
      return resolveWapGroupRequireMention({
        config: account.config,
        groupId,
      });
    },
    resolveGroupIntroHint: ({ cfg, accountId, groupId }) => {
      const account = resolveWapAccount(cfg, accountId);
      return resolveWapGroupSystemPrompt({
        config: account.config,
        groupId,
      });
    },
    resolveToolPolicy: ({ cfg, accountId, groupId }) => {
      const account = resolveWapAccount(cfg, accountId);
      return resolveWapGroupToolPolicy({
        config: account.config,
        groupId,
      });
    },
  },
  messaging: {
    normalizeTarget: normalizeWapMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeWapTargetId,
      hint: "<user:wxid|group:talker@chatroom>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async (params: {
      accountId?: string | null;
      query?: string | null;
      limit?: number | null;
    }) => {
      const result = await listWapFriends(params);
      if (!result.ok) {
        return [];
      }
      return result.friends.map((entry) => ({
        kind: "user" as const,
        id: entry.wxid,
        name: entry.displayName,
      }));
    },
    listGroups: async (params: {
      accountId?: string | null;
      query?: string | null;
      limit?: number | null;
    }) => {
      const result = await listWapGroups(params);
      if (!result.ok) {
        return [];
      }
      return result.groups.map((entry) => ({
        kind: "group" as const,
        id: entry.talker,
        name: entry.name,
      }));
    },
  },
  actions: {
    describeMessageTool: () => describeWapMessageTool(),
    supportsAction: ({ action }) => action === "search" || action === "send",
    extractToolSend: ({ args }) => extractActionSendTarget(args),
    handleAction: async ({ action, params, accountId }) => {
      const runtime = getWapRuntime();
      runtime?.logger.debug(`WAP action called action=${action} account=${accountId ?? DEFAULT_ACCOUNT_ID}`);
      if (action === "search") {
        return await handleWapSearchAction({
          params,
          accountId,
        });
      }
      if (action === "send") {
        return await handleWapSendAction({
          params,
          accountId,
        });
      }
      throw new Error(`WAP action not supported: ${action}`);
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
    sendPayload: async ({ to, payload, accountId, replyToId }) => {
      const payloadText = typeof payload?.text === "string" ? payload.text : "";
      const mediaList = resolveReplyMediaUrls(payload);
      if (!payloadText && mediaList.length === 0) {
        return { ok: true, channel: CHANNEL_ID };
      }
      let lastResult: { ok: true; details: unknown } | { ok: false; error: string; code?: string } = {
        ok: true,
        details: { ok: true },
      };
      if (mediaList.length === 0) {
        lastResult = await executeCanonicalWapSend({
          to,
          text: payloadText,
          accountId,
          replyToMessageId: resolveReplyToMessageId(replyToId),
        });
      } else {
        lastResult = await executeCanonicalWapSend({
          to,
          text: payloadText,
          mediaUrl: mediaList[0],
          accountId,
          replyToMessageId: resolveReplyToMessageId(replyToId),
        });
        for (let i = 1; i < mediaList.length && lastResult.ok; i += 1) {
          lastResult = await executeCanonicalWapSend({
            to,
            mediaUrl: mediaList[i],
            accountId,
          });
        }
      }
      return lastResult.ok
        ? { ok: true, channel: CHANNEL_ID, details: lastResult.details }
        : { ok: false, channel: CHANNEL_ID, error: lastResult.error, code: lastResult.code };
    },
    sendText: async ({ to, text, accountId, replyToId }) => {
      const result = await executeCanonicalWapSend({
        to,
        text,
        accountId,
        replyToMessageId: resolveReplyToMessageId(replyToId),
      });
      return result.ok
        ? { ok: true, channel: CHANNEL_ID, details: result.details }
        : { ok: false, channel: CHANNEL_ID, error: result.error, code: result.code };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      if (!mediaUrl) {
        return {
          ok: false,
          channel: CHANNEL_ID,
          error: "mediaUrl is required",
        };
      }
      const result = await executeCanonicalWapSend({
        to,
        text,
        mediaUrl,
        accountId,
      });
      return result.ok
        ? { ok: true, channel: CHANNEL_ID, details: result.details }
        : { ok: false, channel: CHANNEL_ID, error: result.error, code: result.code };
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
