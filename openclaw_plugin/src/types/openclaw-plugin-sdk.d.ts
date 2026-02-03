// Type declarations for openclaw plugin SDK
// This is a minimal shim since openclaw doesn't export types separately

declare module "openclaw/plugin-sdk" {
    export interface OpenClawPluginApi {
        id: string;
        logger: {
            debug: (msg: string) => void;
            info: (msg: string) => void;
            warn: (msg: string) => void;
            error: (msg: string) => void;
        };
        config: OpenClawConfig;
        runtime: PluginRuntime;
        registerChannel: (opts: { plugin: ChannelPlugin<unknown> }) => void;
        registerService: (opts: {
            id: string;
            start: () => void | Promise<void>;
            stop: () => void | Promise<void>;
        }) => void;
    }

    export interface OpenClawConfig {
        channels?: Record<string, unknown>;
        session?: {
            store?: string;
        };
        [key: string]: unknown;
    }

    export interface PluginRuntime {
        version: string;
        config: {
            loadConfig: () => OpenClawConfig;
            writeConfigFile: (cfg: OpenClawConfig) => void;
        };
        system: {
            enqueueSystemEvent: (text: string, opts?: { sessionKey?: string; contextKey?: string }) => void;
        };
        channel: {
            text: {
                resolveTextChunkLimit: (cfg: OpenClawConfig, channel: string, accountId?: string, opts?: { fallbackLimit?: number }) => number;
                resolveChunkMode: (cfg: OpenClawConfig, channel: string, accountId?: string) => string;
                chunkMarkdownTextWithMode: (text: string, limit: number, mode: string) => string[];
                hasControlCommand: (text: string, cfg: OpenClawConfig) => boolean;
            };
            reply: {
                dispatchReplyFromConfig: (opts: {
                    ctx: unknown;
                    cfg: OpenClawConfig;
                    dispatcher: unknown;
                    replyOptions?: unknown;
                }) => Promise<{ queuedFinal?: boolean; counts?: Record<string, number> }>;
                createReplyDispatcherWithTyping: (opts: {
                    responsePrefix?: string;
                    responsePrefixContextProvider?: () => Record<string, string>;
                    humanDelay?: unknown;
                    deliver: (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => Promise<void>;
                    onError?: (err: unknown, info: { kind: string }) => void;
                    onReplyStart?: () => void;
                }) => {
                    dispatcher: unknown;
                    replyOptions: unknown;
                    markDispatchIdle: () => void;
                };
                resolveHumanDelayConfig: (cfg: OpenClawConfig, agentId?: string) => unknown;
                formatInboundEnvelope: (opts: {
                    channel: string;
                    from: string;
                    timestamp?: number;
                    body: string;
                    chatType: string;
                    sender?: { name: string; id: string };
                    senderLabel?: string;
                }) => string;
                finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
            };
            routing: {
                resolveAgentRoute: (opts: {
                    cfg: OpenClawConfig;
                    channel: string;
                    accountId: string;
                    teamId?: string;
                    peer: { kind: "dm" | "group" | "channel"; id: string };
                }) => {
                    sessionKey: string;
                    mainSessionKey: string;
                    accountId: string;
                    agentId: string;
                };
            };
            activity: {
                record: (opts: { channel: string; accountId: string; direction: "inbound" | "outbound" }) => void;
            };
            session: {
                resolveStorePath: (store: string | undefined, opts: { agentId?: string }) => string;
                updateLastRoute: (opts: {
                    storePath: string;
                    sessionKey: string;
                    deliveryContext: { channel: string; to: string; accountId: string };
                }) => Promise<void>;
            };
        };
        logging: {
            shouldLogVerbose: () => boolean;
            getChildLogger: (bindings?: Record<string, unknown>) => {
                debug?: (msg: string) => void;
                info: (msg: string) => void;
                warn: (msg: string) => void;
                error: (msg: string) => void;
            };
        };
        state: {
            resolveStateDir: (cfg: OpenClawConfig) => string;
        };
    }

    export interface ChannelPlugin<TAccount> {
        id: string;
        meta: {
            id: string;
            label: string;
            selectionLabel?: string;
            docsPath?: string;
            blurb?: string;
            aliases?: string[];
        };
        capabilities: {
            chatTypes: Array<"direct" | "group" | "channel">;
        };
        configSchema?: unknown;
        reload?: {
            configPrefixes?: string[];
        };
        config: {
            listAccountIds: (cfg: OpenClawConfig) => string[];
            isConfigured?: (cfg: OpenClawConfig, accountId?: string) => boolean;
            resolveAccount: (cfg: OpenClawConfig, accountId?: string) => TAccount;
            describeAccount?: (account: TAccount, opts?: { snapshot?: unknown }) => Record<string, unknown>;
        };
        outbound: {
            deliveryMode: "direct" | "buffered";
            sendText: (opts: { to: string; text: string; accountId?: string }) => Promise<{ ok: boolean; channel?: string }>;
        };
        gateway?: {
            startAccount?: (opts: {
                api: OpenClawPluginApi;
                accountId: string;
                abortSignal?: AbortSignal;
                statusSink?: (status: Record<string, unknown>) => void;
            }) => void | Promise<void>;
            stopAccount?: (opts: { accountId: string }) => void | Promise<void>;
        };
        status?: {
            buildConfiguredLabel?: (opts: { cfg: OpenClawConfig; account: TAccount }) => string;
            buildChannelSummary?: (opts: { cfg: OpenClawConfig; account: TAccount; snapshot?: unknown }) => Record<string, unknown>;
        };
    }

    // Re-export common types
    export type ChannelPluginConfig<T> = ChannelPlugin<T>["config"];
}
