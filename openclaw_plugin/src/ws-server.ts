import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveSenderCommandAuthorization } from "openclaw/plugin-sdk";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_PORT,
  getWapChannelConfig,
  isSenderAllowed,
  resolveAllowFrom,
  resolveGroupAllowFrom,
  resolveWapAccount,
  type WapAccount,
} from "./config.js";
import type { WapMessageData, WapSendTextCommand, WapUpstreamMessage } from "./protocol.js";

let wss: WebSocketServer | null = null;
let runtime: OpenClawPluginApi | null = null;

interface ClientInfo {
  ws: WebSocket;
  accountId: string;
  account: WapAccount;
  ip: string;
  connectedAt: Date;
  messageCount: number;
  lastMessageAt: number;
}

const clients = new Map<string, ClientInfo>();

const AUTH_TOKEN_ENV = "WAP_AUTH_TOKEN";
const MAX_MESSAGE_SIZE = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MESSAGES = 10;

const wechatContextHint = `
[WeChat Context]
尽可能保持简洁（单条 < 300 字）
禁止使用MarkDown
`;

export function setWapRuntime(api: OpenClawPluginApi) {
  runtime = api;
}

export function getWapRuntime(): OpenClawPluginApi | null {
  return runtime;
}

export function startWsService(api: OpenClawPluginApi) {
  if (wss) {
    api.logger.warn("WAP WebSocket server is already running");
    return;
  }

  const channelConfig = getWapChannelConfig(api.config);
  const port = channelConfig.port ?? DEFAULT_PORT;

  wss = new WebSocketServer({
    port,
    maxPayload: MAX_MESSAGE_SIZE,
  });
  api.logger.info(`WAP WebSocket server started on port ${port}`);

  wss.on("connection", (ws, req) => {
    const clientId = handleConnection(ws, req, api);
    if (!clientId) {
      return;
    }
    ws.on("message", (data) => handleMessage(clientId, data, api));
    ws.on("close", () => handleDisconnect(clientId, api));
    ws.on("error", (err) => api.logger.error(`WAP WebSocket error: ${err.message}`));
  });
}

export function stopWsService() {
  if (wss) {
    wss.close();
    wss = null;
  }
  clients.clear();
  runtime?.logger.info("WAP WebSocket server stopped");
}

function resolveAccountId(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return (
    url.searchParams.get("accountId") ?? req.headers["x-wap-account-id"]?.toString() ?? DEFAULT_ACCOUNT_ID
  );
}

function handleConnection(ws: WebSocket, req: IncomingMessage, api: OpenClawPluginApi): string | null {
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  const accountId = resolveAccountId(req);
  const account = resolveWapAccount(api.config, accountId);

  if (!account.enabled) {
    api.logger.warn(`WAP connection rejected for disabled account ${accountId} from ${ip}`);
    ws.close(4003, "Account disabled");
    return null;
  }

  const authToken = account.config.authToken ?? process.env[AUTH_TOKEN_ENV];
  if (!authToken) {
    api.logger.error(
      `WAP connection rejected for ${accountId}: missing auth token (set account authToken or ${AUTH_TOKEN_ENV})`,
    );
    ws.close(4001, "Unauthorized");
    return null;
  }

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${authToken}`) {
    api.logger.warn(`WAP connection rejected from ${ip}: invalid token for account ${accountId}`);
    ws.close(4001, "Unauthorized");
    return null;
  }

  const clientId = `wap-${accountId}-${Date.now()}`;
  clients.set(clientId, {
    ws,
    accountId,
    account,
    ip,
    connectedAt: new Date(),
    messageCount: 0,
    lastMessageAt: 0,
  });

  const allowFrom = resolveAllowFrom(account.config);
  const groupAllowFrom = resolveGroupAllowFrom(account.config);
  const requireMentionInGroup = account.config.requireMentionInGroup ?? true;
  const silentPairing = account.config.silentPairing ?? true;

  ws.send(
    JSON.stringify({
      type: "config",
      data: {
        allow_from: allowFrom,
        group_allow_from: groupAllowFrom,
        dm_policy: account.config.dmPolicy ?? "pairing",
        require_mention_in_group: requireMentionInGroup,
        silent_pairing: silentPairing,
      },
    }),
  );

  api.logger.info(`WAP client connected: ${clientId} from ${ip} (account: ${accountId})`);
  return clientId;
}

async function handleMessage(
  clientId: string,
  data: Buffer | ArrayBuffer | Buffer[],
  api: OpenClawPluginApi,
) {
  const client = clients.get(clientId);
  if (!client) {
    return;
  }

  const now = Date.now();
  if (now - client.lastMessageAt < RATE_LIMIT_WINDOW_MS) {
    client.messageCount++;
    if (client.messageCount > RATE_LIMIT_MAX_MESSAGES) {
      api.logger.warn(`WAP rate limit exceeded for ${clientId}, dropping message`);
      return;
    }
  } else {
    client.messageCount = 1;
    client.lastMessageAt = now;
  }

  try {
    const text = Buffer.isBuffer(data)
      ? data.toString()
      : Array.isArray(data)
        ? Buffer.concat(data).toString()
        : Buffer.from(data).toString();
    const parsed = JSON.parse(text) as unknown;
    const msg = validateUpstreamMessage(parsed);
    if (!msg) {
      api.logger.warn(`WAP invalid message structure from ${clientId}`);
      return;
    }

    if (msg.type === "heartbeat") {
      client.ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    await processWapInboundMessage({
      api,
      client,
      msgData: msg.data,
      ws: client.ws,
    });
  } catch (err) {
    api.logger.error(`Failed to handle WAP message: ${String(err)}`);
  }
}

async function processWapInboundMessage(params: {
  api: OpenClawPluginApi;
  client: ClientInfo;
  msgData: WapMessageData;
  ws: WebSocket;
}) {
  const { api, client, msgData, ws } = params;
  const core = api.runtime;
  const cfg = api.config;
  const bodyText = msgData.content.trim();
  if (!bodyText) {
    return;
  }

  const isGroup = msgData.is_group;
  const kind: "dm" | "group" = isGroup ? "group" : "dm";
  const chatType = isGroup ? "group" : "direct";
  const dmPolicy = client.account.config.dmPolicy ?? "pairing";
  const allowFrom = resolveAllowFrom(client.account.config);
  const groupAllowFrom = resolveGroupAllowFrom(client.account.config);
  const configuredAllowFrom = isGroup ? groupAllowFrom : allowFrom;
  const senderAllowed = isSenderAllowed(
    msgData.sender,
    configuredAllowFrom,
    isGroup ? true : dmPolicy === "open",
  );

  if (isGroup) {
    const requireMention = client.account.config.requireMentionInGroup ?? true;
    if (requireMention && msgData.is_at_me !== true) {
      api.logger.debug(`WAP drop group message from ${msgData.sender}: mention required`);
      return;
    }
    if (configuredAllowFrom.length > 0 && !senderAllowed) {
      api.logger.debug(`WAP drop group message from ${msgData.sender}: sender not allowlisted`);
      return;
    }
  } else {
    if (dmPolicy === "disabled") {
      api.logger.debug(`WAP drop DM from ${msgData.sender}: dmPolicy=disabled`);
      return;
    }
    if (dmPolicy !== "open" && !senderAllowed) {
      if (dmPolicy === "pairing") {
        const silentPairing = client.account.config.silentPairing ?? true;
        const request = await core.channel.pairing.upsertPairingRequest({
          channel: CHANNEL_ID,
          id: msgData.sender,
          meta: { name: msgData.sender },
        });
        api.logger.info(
          `WAP pairing request sender=${msgData.sender} account=${client.accountId} created=${request.created}`,
        );
        if (!silentPairing && request.created && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "send_text",
              data: {
                talker: msgData.talker,
                content: core.channel.pairing.buildPairingReply({
                  channel: CHANNEL_ID,
                  idLine: `Your WeChat id: ${msgData.sender}`,
                  code: request.code,
                }),
              },
            }),
          );
        }
      }
      return;
    }
  }

  const commandAuth = await resolveSenderCommandAuthorization({
    cfg,
    rawBody: bodyText,
    isGroup,
    dmPolicy,
    configuredAllowFrom,
    senderId: msgData.sender,
    isSenderAllowed: (senderId, effectiveAllowFrom) =>
      isSenderAllowed(senderId, effectiveAllowFrom, isGroup ? true : dmPolicy === "open"),
    readAllowFromStore: async () => await core.channel.pairing.readAllowFromStore(CHANNEL_ID),
    shouldComputeCommandAuthorized: (rawBody, config) =>
      core.channel.commands.shouldComputeCommandAuthorized(rawBody, config),
    resolveCommandAuthorizedFromAuthorizers: (authParams) =>
      core.channel.commands.resolveCommandAuthorizedFromAuthorizers(authParams),
  });

  if (
    commandAuth.commandAuthorized === false &&
    core.channel.text.hasControlCommand(bodyText, cfg)
  ) {
    api.logger.debug(`WAP blocked unauthorized control command from ${msgData.sender}`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: client.accountId,
    peer: {
      kind,
      id: msgData.talker,
    },
  });

  core.channel.activity.record({
    channel: CHANNEL_ID,
    accountId: client.accountId,
    direction: "inbound",
  });

  const fromLabel = isGroup ? `${msgData.sender} in ${msgData.talker}` : msgData.sender;
  const body = core.channel.reply.formatInboundEnvelope({
    channel: "WeChat",
    from: fromLabel,
    timestamp: msgData.timestamp,
    body: `${bodyText}\n\n${wechatContextHint}`,
    chatType,
    sender: { name: msgData.sender, id: msgData.sender },
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: bodyText,
    CommandBody: bodyText,
    From: isGroup ? `${CHANNEL_ID}:group:${msgData.talker}` : `${CHANNEL_ID}:${msgData.sender}`,
    To: msgData.talker,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    GroupSubject: isGroup ? msgData.talker : undefined,
    SenderName: msgData.sender,
    SenderId: msgData.sender,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: String(msgData.msg_id),
    Timestamp: msgData.timestamp,
    WasMentioned: isGroup ? msgData.is_at_me === true : undefined,
    CommandAuthorized: commandAuth.commandAuthorized,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: msgData.talker,
  });

  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, CHANNEL_ID, client.accountId, {
    fallbackLimit: 4000,
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
        const replyText = payload.text ?? "";
        if (!replyText) {
          return;
        }
        const chunkMode = core.channel.text.resolveChunkMode(cfg, CHANNEL_ID, client.accountId);
        const chunks = core.channel.text.chunkMarkdownTextWithMode(replyText, textLimit, chunkMode);
        for (const chunk of chunks.length > 0 ? chunks : [replyText]) {
          if (!chunk) {
            continue;
          }
          const command: WapSendTextCommand = {
            type: "send_text",
            data: {
              talker: msgData.talker,
              content: chunk,
            },
          };
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(command));
          } else {
            api.logger.warn(`WAP WebSocket not open, cannot send reply to ${msgData.talker}`);
          }
        }
      },
      onError: (err: unknown, info: { kind: string }) => {
        api.logger.error(`WAP ${info.kind} reply failed: ${String(err)}`);
      },
    });

  try {
    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });
  } finally {
    markDispatchIdle();
  }
}

function validateUpstreamMessage(data: unknown): WapUpstreamMessage | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }

  const obj = data as Record<string, unknown>;
  if (obj.type === "heartbeat") {
    return { type: "heartbeat" };
  }

  if (obj.type !== "message") {
    return null;
  }

  const msgData = obj.data;
  if (typeof msgData !== "object" || msgData === null) {
    return null;
  }
  const d = msgData as Record<string, unknown>;
  if (
    typeof d.msg_id !== "number" ||
    typeof d.talker !== "string" ||
    typeof d.sender !== "string" ||
    typeof d.content !== "string" ||
    typeof d.timestamp !== "number" ||
    typeof d.is_private !== "boolean" ||
    typeof d.is_group !== "boolean"
  ) {
    return null;
  }
  const isAtMe = typeof d.is_at_me === "boolean" ? d.is_at_me : false;
  const atUserList = Array.isArray(d.at_user_list)
    ? d.at_user_list.map((entry) => String(entry))
    : [];
  return {
    type: "message",
    data: {
      msg_id: d.msg_id,
      msg_type: typeof d.msg_type === "number" ? d.msg_type : 0,
      talker: d.talker,
      sender: d.sender,
      content: d.content,
      timestamp: d.timestamp,
      is_private: d.is_private,
      is_group: d.is_group,
      is_at_me: isAtMe,
      at_user_list: atUserList,
    },
  };
}

function handleDisconnect(clientId: string, api: OpenClawPluginApi) {
  const client = clients.get(clientId);
  clients.delete(clientId);
  api.logger.info(
    `WAP client disconnected: ${clientId}` +
      (client ? ` (was connected for ${Date.now() - client.connectedAt.getTime()}ms)` : ""),
  );
}

export function sendToClient(command: WapSendTextCommand, accountId?: string): boolean {
  const targetAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  for (const [, client] of clients) {
    if (client.accountId === targetAccountId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(command));
      return true;
    }
  }
  return false;
}

export function getClientCount(): number {
  return clients.size;
}

export function getClientStats(): Array<{
  clientId: string;
  accountId: string;
  ip: string;
  connectedAt: Date;
}> {
  return Array.from(clients.entries()).map(([clientId, info]) => ({
    clientId,
    accountId: info.accountId,
    ip: info.ip,
    connectedAt: info.connectedAt,
  }));
}
