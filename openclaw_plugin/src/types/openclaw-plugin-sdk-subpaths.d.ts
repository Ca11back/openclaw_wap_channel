declare module "openclaw/plugin-sdk/core" {
  export type OpenClawConfig = {
    channels?: Record<string, unknown>;
    commands?: { useAccessGroups?: boolean };
    session?: { store?: string };
    [key: string]: unknown;
  };

  export type PluginLogger = {
    debug: (msg: string, meta?: Record<string, unknown>) => void;
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };

  export type OpenClawPluginConfigSchema = {
    safeParse?: (value: unknown) => {
      success: boolean;
      data?: unknown;
      error?: {
        issues?: Array<{ path: Array<string | number>; message: string }>;
      };
    };
    parse?: (value: unknown) => unknown;
    validate?: (value: unknown) => { ok: true; value?: unknown } | { ok: false; errors: string[] };
    uiHints?: Record<string, unknown>;
    jsonSchema?: Record<string, unknown>;
  };

  export type ChannelConfigUiHint = {
    label?: string;
    help?: string;
    tags?: string[];
    advanced?: boolean;
    sensitive?: boolean;
    placeholder?: string;
    itemTemplate?: unknown;
  };

  export type ChannelConfigSchema = {
    schema: Record<string, unknown>;
    uiHints?: Record<string, ChannelConfigUiHint>;
  };

  export type OutboundDeliveryResult = {
    ok: boolean;
    error?: string;
    channel?: string;
    [key: string]: unknown;
  };

  export type ChannelAccountSnapshot = Record<string, unknown>;

  export type ChannelMeta = {
    id: string;
    label: string;
    selectionLabel: string;
    docsPath: string;
    docsLabel?: string;
    blurb: string;
    order?: number;
    aliases?: string[];
    selectionDocsPrefix?: string;
    selectionDocsOmitLabel?: boolean;
    selectionExtras?: string[];
    detailLabel?: string;
    systemImage?: string;
    showConfigured?: boolean;
    quickstartAllowFrom?: boolean;
    forceAccountBinding?: boolean;
    preferSessionLookupForAnnounceTarget?: boolean;
    preferOver?: string[];
  };

  export type ChannelCapabilities = {
    chatTypes: Array<"direct" | "group" | "channel" | "thread">;
    polls?: boolean;
    reactions?: boolean;
    edit?: boolean;
    unsend?: boolean;
    reply?: boolean;
    effects?: boolean;
    groupManagement?: boolean;
    threads?: boolean;
    media?: boolean;
    nativeCommands?: boolean;
    blockStreaming?: boolean;
  };

  export type ChannelLogSink = {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };

  export type ChannelGroupContext = {
    cfg: OpenClawConfig;
    groupId?: string | null;
    groupChannel?: string | null;
    groupSpace?: string | null;
    accountId?: string | null;
    senderId?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    senderE164?: string | null;
  };

  export type ChannelSecurityDmPolicy = {
    policy: string;
    allowFrom?: Array<string | number> | null;
    policyPath?: string;
    allowFromPath: string;
    approveHint: string;
    normalizeEntry?: (raw: string) => string;
  };

  export type ChannelSecurityContext<ResolvedAccount = unknown> = {
    cfg: OpenClawConfig;
    accountId?: string | null;
    account: ResolvedAccount;
  };

  export type ChannelOutboundContext = {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    gifPlayback?: boolean;
    replyToId?: string | null;
    threadId?: string | number | null;
    accountId?: string | null;
    identity?: unknown;
    deps?: unknown;
    silent?: boolean;
  };

  export type ChannelOutboundPayloadContext = ChannelOutboundContext & {
    payload: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      channelData?: Record<string, unknown>;
      replyToId?: string | null;
    };
  };

  export type ChannelGatewayContext<ResolvedAccount = unknown> = {
    cfg: OpenClawConfig;
    accountId: string;
    account: ResolvedAccount;
    runtime: unknown;
    abortSignal: AbortSignal;
    log?: ChannelLogSink;
    getStatus: () => ChannelAccountSnapshot;
    setStatus: (next: ChannelAccountSnapshot) => void;
    channelRuntime?: PluginRuntime["channel"];
  };

  export type ChannelLoginWithQrStartResult = {
    qrDataUrl?: string;
    message: string;
  };

  export type ChannelLoginWithQrWaitResult = {
    connected: boolean;
    message: string;
  };

  export type ChannelLogoutResult = {
    cleared: boolean;
    loggedOut?: boolean;
    [key: string]: unknown;
  };

  export interface ChannelPlugin<ResolvedAccount = unknown, Probe = unknown, Audit = unknown> {
    id: string;
    meta: ChannelMeta;
    defaults?: {
      queue?: {
        debounceMs?: number;
      };
    };
    pairing?: {
      idLabel: string;
      normalizeAllowEntry?: (entry: string) => string;
      notifyApproval?: (params: {
        cfg: OpenClawConfig;
        id: string;
        runtime?: unknown;
      }) => Promise<void>;
    };
    capabilities: ChannelCapabilities;
    reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
    configSchema?: ChannelConfigSchema;
    onboarding?: unknown;
    setup?: unknown;
    config: {
      listAccountIds: (cfg: OpenClawConfig) => string[];
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
      inspectAccount?: (cfg: OpenClawConfig, accountId?: string | null) => unknown;
      defaultAccountId?: (cfg: OpenClawConfig) => string;
      setAccountEnabled?: (params: {
        cfg: OpenClawConfig;
        accountId: string;
        enabled: boolean;
      }) => OpenClawConfig;
      deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
      isEnabled?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean;
      disabledReason?: (account: ResolvedAccount, cfg: OpenClawConfig) => string;
      isConfigured?: (
        account: ResolvedAccount,
        cfg: OpenClawConfig,
      ) => boolean | Promise<boolean>;
      unconfiguredReason?: (account: ResolvedAccount, cfg: OpenClawConfig) => string;
      describeAccount?: (
        account: ResolvedAccount,
        cfg: OpenClawConfig,
      ) => ChannelAccountSnapshot;
      resolveAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
      }) => Array<string | number> | undefined;
      formatAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        allowFrom: Array<string | number>;
      }) => string[];
      resolveDefaultTo?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
      }) => string | undefined;
    };
    security?: {
      resolveDmPolicy?: (
        params: ChannelSecurityContext<ResolvedAccount>,
      ) => ChannelSecurityDmPolicy | null;
      collectWarnings?: (
        params: ChannelSecurityContext<ResolvedAccount>,
      ) => Promise<string[]> | string[];
    };
    groups?: {
      resolveRequireMention?: (params: ChannelGroupContext) => boolean | undefined;
      resolveGroupIntroHint?: (params: ChannelGroupContext) => string | undefined;
      resolveToolPolicy?: (params: ChannelGroupContext) => unknown;
    };
    mentions?: unknown;
    messaging?: {
      normalizeTarget?: (target: string) => string;
      targetResolver?: {
        looksLikeId?: (target: string) => boolean;
        hint?: string;
      };
    };
    actions?: {
      listActions?: (params: { cfg: OpenClawConfig }) => string[];
      supportsAction?: (params: { action: string }) => boolean;
      extractToolSend?: (params: {
        args: Record<string, unknown>;
      }) => { to: string; accountId?: string | null } | null;
      handleAction?: (ctx: {
        channel: string;
        action: string;
        cfg: OpenClawConfig;
        params: Record<string, unknown>;
        accountId?: string | null;
      }) => Promise<unknown>;
    };
    outbound?: {
      deliveryMode: "direct" | "gateway" | "hybrid";
      chunker?: ((text: string, limit: number) => string[]) | null;
      chunkerMode?: "text" | "markdown";
      textChunkLimit?: number;
      pollMaxOptions?: number;
      resolveTarget?: (ctx: {
        cfg?: OpenClawConfig;
        to?: string;
        allowFrom?: string[];
        accountId?: string | null;
        mode?: "explicit" | "implicit" | "heartbeat";
      }) => { ok: true; to: string } | { ok: false; error: Error };
      sendPayload?: (ctx: ChannelOutboundPayloadContext) => Promise<OutboundDeliveryResult>;
      sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
      sendMedia?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
      sendPoll?: (ctx: unknown) => Promise<unknown>;
    };
    status?: {
      defaultRuntime?: ChannelAccountSnapshot;
      buildAccountSnapshot?: (params: {
        account: ResolvedAccount;
        cfg: OpenClawConfig;
        runtime?: ChannelAccountSnapshot;
        probe?: Probe;
        audit?: Audit;
      }) => ChannelAccountSnapshot | Promise<ChannelAccountSnapshot>;
      buildChannelSummary?: (params: {
        account: ResolvedAccount;
        cfg: OpenClawConfig;
        defaultAccountId: string;
        snapshot: ChannelAccountSnapshot;
      }) => Record<string, unknown> | Promise<Record<string, unknown>>;
      probeAccount?: (params: {
        account: ResolvedAccount;
        timeoutMs: number;
        cfg: OpenClawConfig;
      }) => Promise<Probe>;
      auditAccount?: (params: {
        account: ResolvedAccount;
        timeoutMs: number;
        cfg: OpenClawConfig;
        probe?: Probe;
      }) => Promise<Audit>;
    };
    gatewayMethods?: string[];
    gateway?: {
      startAccount?: (
        ctx: ChannelGatewayContext<ResolvedAccount>,
      ) => Promise<void | { stop?: () => void | Promise<void> }>;
      stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
    };
    agentPrompt?: {
      messageToolHints?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
      }) => string[];
    };
    directory?: {
      self?: (params: { accountId?: string | null }) => Promise<unknown>;
      listPeers?: (params: {
        accountId?: string | null;
        query?: string | null;
        limit?: number | null;
      }) => Promise<unknown[]>;
      listGroups?: (params: {
        accountId?: string | null;
        query?: string | null;
        limit?: number | null;
      }) => Promise<unknown[]>;
    };
  }

  export type PluginRuntime = {
    channel: {
      pairing: {
        readAllowFromStore: unknown;
        upsertPairingRequest: (params: {
          channel: string;
          id: string;
          accountId?: string | null;
          meta?: Record<string, unknown>;
        }) => Promise<{ code: string; created: boolean }>;
        buildPairingReply: (params: {
          channel: string;
          idLine: string;
          code: string;
        }) => string;
      };
      routing: {
        resolveAgentRoute: (params: {
          cfg: OpenClawConfig;
          channel: string;
          accountId?: string | null;
          peer: { kind: "dm" | "group"; id: string };
        }) => {
          agentId: string;
          accountId?: string | null;
          sessionKey: string;
        };
      };
      activity: {
        record: (params: {
          channel: string;
          accountId?: string | null;
          direction: "inbound" | "outbound";
        }) => void;
      };
      reply: {
        formatInboundEnvelope: (ctx: Record<string, unknown>) => string;
        finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
        createReplyDispatcherWithTyping: (params: {
          humanDelay?: unknown;
          deliver: (payload: {
            text?: string;
            mediaUrl?: string;
            mediaUrls?: string[];
          }, info: { kind: "tool" | "block" | "final" }) => Promise<void>;
          onError?: (err: unknown, info: { kind: "tool" | "block" | "final" }) => void;
        }) => {
          dispatcher: {
            sendToolResult: (payload: Record<string, unknown>) => boolean;
            sendBlockReply: (payload: Record<string, unknown>) => boolean;
            sendFinalReply: (payload: Record<string, unknown>) => boolean;
            waitForIdle: () => Promise<void>;
            getQueuedCounts: () => Record<string, number>;
            markComplete: () => void;
          };
          replyOptions: Record<string, unknown>;
          markDispatchIdle: () => void;
          markRunComplete: () => void;
        };
        resolveHumanDelayConfig: (cfg: OpenClawConfig, agentId?: string | null) => unknown;
        dispatchReplyFromConfig: (params: {
          ctx: Record<string, unknown>;
          cfg: OpenClawConfig;
          dispatcher: unknown;
          replyOptions?: Record<string, unknown>;
          replyResolver?: unknown;
        }) => Promise<unknown>;
      };
      text: {
        resolveTextChunkLimit: (
          cfg: OpenClawConfig,
          channel: string,
          accountId?: string | null,
          params?: { fallbackLimit?: number },
        ) => number;
        resolveChunkMode: (
          cfg: OpenClawConfig,
          channel: string,
          accountId?: string | null,
        ) => "length" | "newline";
        chunkMarkdownTextWithMode: (
          text: string,
          limit: number,
          mode: "length" | "newline",
        ) => string[];
        hasControlCommand: (body: string, cfg: OpenClawConfig) => boolean;
      };
      commands: {
        shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
        resolveCommandAuthorizedFromAuthorizers: (params: {
          useAccessGroups: boolean;
          authorizers: Array<{ configured: boolean; allowed: boolean }>;
        }) => boolean;
        isControlCommandMessage: (content: string, cfg: OpenClawConfig) => boolean;
      };
    };
  };

  export type OpenClawPluginApi = {
    id?: string;
    name?: string;
    version?: string;
    description?: string;
    source?: string;
    rootDir?: string;
    config: OpenClawConfig;
    runtime: PluginRuntime;
    logger: PluginLogger;
    registerCommand: (command: unknown) => void;
    registerTool: (tool: unknown, opts?: unknown) => void;
    registerChannel: (registration: unknown) => void;
    registerCli: (registrar: (ctx: { program: any; config: OpenClawConfig }) => void, opts?: { commands?: string[] }) => void;
    registerService: (service: unknown) => void;
  };

  export function emptyPluginConfigSchema(): OpenClawPluginConfigSchema;
}

declare module "openclaw/plugin-sdk/command-auth" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

  export function resolveSenderCommandAuthorization(params: {
    cfg: OpenClawConfig;
    rawBody: string;
    isGroup: boolean;
    dmPolicy: string;
    configuredAllowFrom: string[];
    configuredGroupAllowFrom?: string[];
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
    effectiveGroupAllowFrom: string[];
    senderAllowedForCommands: boolean;
    commandAuthorized: boolean | undefined;
  }>;
}
