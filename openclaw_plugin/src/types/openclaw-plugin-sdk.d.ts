declare module "openclaw/plugin-sdk" {
  export type OpenClawConfig = {
    channels?: Record<string, unknown>;
    commands?: { useAccessGroups?: boolean };
    session?: { store?: string };
    [key: string]: unknown;
  };

  export type ChannelConfigSchema = {
    schema: Record<string, unknown>;
    uiHints?: Record<string, unknown>;
  };

  export type OutboundDeliveryResult = {
    ok: boolean;
    error?: string;
    channel?: string;
    [key: string]: unknown;
  };

  export interface ChannelPlugin<ResolvedAccount = unknown, Probe = unknown, Audit = unknown> {
    id: string;
    meta: Record<string, unknown>;
    pairing?: {
      idLabel: string;
      normalizeAllowEntry?: (entry: string) => string;
    };
    capabilities: Record<string, unknown>;
    reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
    configSchema?: ChannelConfigSchema;
    config: {
      listAccountIds: (cfg: OpenClawConfig) => string[];
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
      defaultAccountId?: (cfg: OpenClawConfig) => string;
      isConfigured?: (
        account: ResolvedAccount,
        cfg: OpenClawConfig,
      ) => boolean | Promise<boolean>;
      describeAccount?: (
        account: ResolvedAccount,
        cfg: OpenClawConfig,
      ) => Record<string, unknown>;
      resolveAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
      }) => string[] | undefined;
      formatAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        allowFrom: Array<string | number>;
      }) => string[];
    };
    security?: {
      resolveDmPolicy?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        account: ResolvedAccount;
      }) => Record<string, unknown>;
    };
    groups?: {
      resolveRequireMention?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        groupId?: string | null;
      }) => boolean | undefined;
    };
    messaging?: {
      normalizeTarget?: (target: string) => string;
      targetResolver?: {
        looksLikeId?: (target: string) => boolean;
        hint?: string;
      };
    };
    outbound?: {
      deliveryMode: "direct" | "gateway" | "hybrid";
      textChunkLimit?: number;
      resolveTarget?: (ctx: {
        cfg?: OpenClawConfig;
        to?: string;
        allowFrom?: string[];
        accountId?: string | null;
        mode?: "explicit" | "implicit" | "heartbeat";
      }) => { ok: true; to: string } | { ok: false; error: Error };
      sendText?: (ctx: {
        cfg: OpenClawConfig;
        to: string;
        text: string;
        accountId?: string | null;
      }) => Promise<OutboundDeliveryResult>;
    };
    status?: {
      defaultRuntime?: Record<string, unknown>;
      buildAccountSnapshot?: (params: {
        account: ResolvedAccount;
        cfg: OpenClawConfig;
        runtime?: Record<string, unknown>;
        probe?: Probe;
        audit?: Audit;
      }) => Record<string, unknown> | Promise<Record<string, unknown>>;
      buildChannelSummary?: (params: {
        account: ResolvedAccount;
        cfg: OpenClawConfig;
        defaultAccountId: string;
        snapshot: Record<string, unknown>;
      }) => Record<string, unknown> | Promise<Record<string, unknown>>;
    };
  }

  export interface PluginRuntime {
    channel: {
      pairing: {
        readAllowFromStore: (channel: string) => Promise<string[]>;
        upsertPairingRequest: (params: {
          channel: string;
          id: string;
          meta?: Record<string, unknown>;
        }) => Promise<{ code: string; created: boolean }>;
        buildPairingReply: (params: {
          channel: string;
          idLine: string;
          code: string;
        }) => string;
      };
      commands: {
        shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
        resolveCommandAuthorizedFromAuthorizers: (params: {
          useAccessGroups: boolean;
          authorizers: Array<{ configured: boolean; allowed: boolean }>;
        }) => boolean;
      };
      text: {
        hasControlCommand: (text: string, cfg: OpenClawConfig) => boolean;
        resolveTextChunkLimit: (
          cfg: OpenClawConfig,
          channel: string,
          accountId?: string | null,
          opts?: { fallbackLimit?: number },
        ) => number;
        resolveChunkMode: (
          cfg: OpenClawConfig,
          channel: string,
          accountId?: string | null,
        ) => string;
        chunkMarkdownTextWithMode: (text: string, limit: number, mode: string) => string[];
      };
      routing: {
        resolveAgentRoute: (params: {
          cfg: OpenClawConfig;
          channel: string;
          accountId: string;
          peer: { kind: "dm" | "group" | "channel"; id: string };
        }) => { sessionKey: string; accountId: string; agentId: string };
      };
      activity: {
        record: (params: {
          channel: string;
          accountId: string;
          direction: "inbound" | "outbound";
        }) => void;
      };
      reply: {
        formatInboundEnvelope: (params: {
          channel: string;
          from: string;
          timestamp?: number;
          body: string;
          chatType: "direct" | "group" | "channel";
          sender?: { name: string; id: string };
        }) => string;
        finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
        resolveHumanDelayConfig: (cfg: OpenClawConfig, agentId?: string) => unknown;
        createReplyDispatcherWithTyping: (params: {
          humanDelay?: unknown;
          deliver: (payload: {
            text?: string;
            mediaUrl?: string;
            mediaUrls?: string[];
          }) => Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        }) => {
          dispatcher: unknown;
          replyOptions: unknown;
          markDispatchIdle: () => void;
        };
        dispatchReplyFromConfig: (params: {
          ctx: Record<string, unknown>;
          cfg: OpenClawConfig;
          dispatcher: unknown;
          replyOptions?: unknown;
        }) => Promise<unknown>;
      };
    };
  }

  export interface OpenClawPluginApi {
    id: string;
    config: OpenClawConfig;
    runtime: PluginRuntime;
    logger: {
      debug: (msg: string) => void;
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    };
    registerChannel: (registration: { plugin: ChannelPlugin<any, any, any> }) => void;
    registerService: (service: {
      id: string;
      start: () => void | Promise<void>;
      stop: () => void | Promise<void>;
    }) => void;
  }

  export function emptyPluginConfigSchema(): Record<string, unknown>;

  export function resolveSenderCommandAuthorization(params: {
    cfg: OpenClawConfig;
    rawBody: string;
    isGroup: boolean;
    dmPolicy: string;
    configuredAllowFrom: string[];
    senderId: string;
    isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
    readAllowFromStore: () => Promise<string[]>;
    shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
    resolveCommandAuthorizedFromAuthorizers: (params: {
      useAccessGroups: boolean;
      authorizers: Array<{ configured: boolean; allowed: boolean }>;
    }) => boolean;
  }): Promise<{
    shouldComputeAuth: boolean;
    effectiveAllowFrom: string[];
    senderAllowedForCommands: boolean;
    commandAuthorized: boolean | undefined;
  }>;
}
