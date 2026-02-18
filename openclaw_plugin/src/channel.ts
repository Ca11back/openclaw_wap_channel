import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { sendToClient, getClientCount, getWapRuntime, getClientStats } from "./ws-server.js";

// ============================================================
// 账户配置类型
// ============================================================

interface WapAccountConfig {
    port?: number;
    authToken?: string;
    allowFrom?: string[];
    enabled?: boolean;
    name?: string;
    dmPolicy?: "open" | "pairing" | "closed";
}

interface WapAccount {
    accountId: string;
    enabled: boolean;
    name?: string;
    config: WapAccountConfig;
}

// ============================================================
// 配置 Schema
// ============================================================

const WapConfigSchema = {
    type: "object" as const,
    additionalProperties: false,
    properties: {
        enabled: { type: "boolean" as const },
        port: { type: "number" as const },
        authToken: { type: "string" as const },
        accounts: {
            type: "object" as const,
            additionalProperties: {
                type: "object" as const,
                properties: {
                    enabled: { type: "boolean" as const },
                    name: { type: "string" as const },
                    allowFrom: {
                        type: "array" as const,
                        items: { type: "string" as const },
                    },
                    dmPolicy: {
                        type: "string" as const,
                        enum: ["open", "pairing", "closed"],
                    },
                },
            },
        },
    },
};

// ============================================================
// Channel 插件定义
// ============================================================

export const wapPlugin: ChannelPlugin<WapAccount> = {
    id: "openclaw-channel-wap",

    meta: {
        id: "openclaw-channel-wap",
        label: "WeChat (WAP)",
        selectionLabel: "WeChat via WAuxiliary",
        docsPath: "/channels/openclaw-channel-wap",
        blurb: "WeChat messaging via WAuxiliary Android plugin.",
        aliases: ["wechat", "wx"],
    },

    capabilities: {
        chatTypes: ["direct", "group"],
        media: false,      // 暂不支持媒体消息
        threads: false,
        reactions: false,
        nativeCommands: false,
    },

    // 配置变更时触发重载
    reload: { configPrefixes: ["channels.openclaw-channel-wap"] },

    // 配置 Schema
    configSchema: WapConfigSchema,

    config: {
        listAccountIds: (cfg) => {
            const wapCfg = (cfg.channels as Record<string, unknown>)?.["openclaw-channel-wap"] as { accounts?: Record<string, unknown> } | undefined;
            const accounts = wapCfg?.accounts;
            if (accounts && Object.keys(accounts).length > 0) {
                return Object.keys(accounts);
            }
            return ["default"];
        },

        resolveAccount: (cfg, accountId) => {
            const id = accountId ?? "default";
            const wapCfg = (cfg.channels as Record<string, unknown>)?.["openclaw-channel-wap"] as
                | { accounts?: Record<string, WapAccountConfig> }
                | undefined;
            const accountCfg = wapCfg?.accounts?.[id] ?? {};
            return {
                accountId: id,
                enabled: accountCfg.enabled ?? true,
                name: accountCfg.name,
                config: accountCfg,
            };
        },

        isConfigured: (account) => {
            // 检查是否有连接的客户端
            const clientCount = getClientCount();
            return clientCount > 0;
        },

        describeAccount: (account) => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: getClientCount() > 0,
            connectedClients: getClientCount(),
        }),
    },

    security: {
        resolveDmPolicy: ({ account }) => ({
            policy: account.config.dmPolicy ?? ("open" as const),
            allowFrom: account.config.allowFrom ?? [],
            policyPath: `channels.openclaw-channel-wap.accounts.${account.accountId}.dmPolicy`,
            allowFromPath: `channels.openclaw-channel-wap.accounts.${account.accountId}.allowFrom`,
        }),
    },

    outbound: {
        deliveryMode: "direct",
        textChunkLimit: 4000,

        sendText: async ({ to, text, accountId }) => {
            const runtime = getWapRuntime();
            const effectiveAccountId = accountId ?? "default";

            const sent = sendToClient(
                {
                    type: "send_text",
                    data: { talker: to, content: text },
                },
                effectiveAccountId
            );

            if (!sent) {
                runtime?.logger.warn(
                    `WAP sendText failed: no connected clients for account ${effectiveAccountId}`
                );
                return {
                    ok: false,
                    error: "No connected WAP clients",
                    channel: "openclaw-channel-wap",
                };
            }

            runtime?.logger.debug(`WAP sendText to ${to}: ${text.substring(0, 50)}...`);
            return { ok: true, channel: "openclaw-channel-wap" };
        },
    },

    status: {
        defaultRuntime: {
            accountId: "default",
            running: false,
            lastStartAt: null,
            lastStopAt: null,
            lastError: null,
        },

        buildAccountSnapshot: ({ account, runtime }) => {
            const clients = getClientStats();
            const accountClients = clients.filter((c) => c.accountId === account.accountId);

            return {
                accountId: account.accountId,
                name: account.name,
                enabled: account.enabled,
                configured: accountClients.length > 0,
                running: runtime?.running ?? (accountClients.length > 0),
                connectedClients: accountClients.length,
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
        }),
    },
};
