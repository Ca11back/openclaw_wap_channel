import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveSenderCommandAuthorization } from "openclaw/plugin-sdk";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_HOST,
  DEFAULT_PORT,
  getWapChannelConfig,
  isGroupChatAllowed,
  isNoMentionContextGroupEnabled,
  isSenderAllowed,
  normalizeSenderId,
  normalizeWapMessagingTarget,
  resolveAllowFrom,
  resolveGroupAllowChats,
  resolveGroupAllowFrom,
  resolveNoMentionContextGroups,
  resolveNoMentionContextHistoryLimit,
  resolveGroupPolicy,
  resolveWapAccount,
  type WapAccount,
} from "./config.js";
import type { WapDownstreamCommand, WapMessageData, WapSendTextCommand, WapUpstreamMessage } from "./protocol.js";

let wss: WebSocketServer | null = null;
let httpServer: ReturnType<typeof createServer> | null = null;
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
const TEMP_FILE_TTL_MS = 10 * 60 * 1000;

type TempFileEntry = {
  accountId: string;
  filePath: string;
  fileName: string;
  expiresAt: number;
};

const tempFiles = new Map<string, TempFileEntry>();

const wechatContextHint = `
[WeChat Context]
尽可能保持简洁（单条 < 300 字）
禁止使用MarkDown
`;

type PendingGroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};

const pendingGroupHistories = new Map<string, PendingGroupHistoryEntry[]>();

function cleanExpiredTempFiles(now = Date.now()) {
  for (const [id, entry] of tempFiles.entries()) {
    if (entry.expiresAt <= now) {
      tempFiles.delete(id);
    }
  }
}

function sanitizeFileName(rawName: string | undefined, fallback = "wap_media.bin"): string {
  const source = (rawName ?? "").trim() || fallback;
  const sanitized = source.replace(/[\\/:*?"<>|]/g, "_").trim();
  if (!sanitized) {
    return fallback;
  }
  return sanitized.length > 96 ? sanitized.slice(-96) : sanitized;
}

function extractFileNameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const decoded = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");
    return sanitizeFileName(decoded, "wap_media.bin");
  } catch {
    const clean = rawUrl.split("#", 1)[0]?.split("?", 1)[0] ?? rawUrl;
    const tail = clean.slice(clean.lastIndexOf("/") + 1).trim();
    return sanitizeFileName(tail, "wap_media.bin");
  }
}

function resolveLocalSourcePath(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return decodeURIComponent(trimmed.slice("file://".length));
    } catch {
      return null;
    }
  }
  return trimmed;
}

function looksLikeImageMedia(input: string): boolean {
  const clean = input.split("#", 1)[0]?.split("?", 1)[0] ?? input;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(clean);
}

function resolveBearerToken(req: IncomingMessage): string {
  const auth = req.headers.authorization?.trim() ?? "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function buildDmSenderCandidates(msgData: WapMessageData, dmPeerId: string): string[] {
  const raw = [
    dmPeerId,
    msgData.sender,
    msgData.talker,
    normalizeWapMessagingTarget(msgData.sender),
    normalizeWapMessagingTarget(msgData.talker),
  ]
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const key = entry.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function buildPendingHistoryKey(accountId: string, talker: string): string {
  return `${accountId}:${talker.trim().toLowerCase()}`;
}

function appendPendingHistory(
  accountId: string,
  talker: string,
  entry: PendingGroupHistoryEntry,
  limit: number,
) {
  if (limit <= 0) {
    return;
  }
  const key = buildPendingHistoryKey(accountId, talker);
  const list = pendingGroupHistories.get(key) ?? [];
  list.push(entry);
  while (list.length > limit) {
    list.shift();
  }
  pendingGroupHistories.set(key, list);
}

function consumePendingHistory(accountId: string, talker: string): PendingGroupHistoryEntry[] {
  const key = buildPendingHistoryKey(accountId, talker);
  const list = pendingGroupHistories.get(key) ?? [];
  pendingGroupHistories.delete(key);
  return list;
}

export function setWapRuntime(api: OpenClawPluginApi) {
  runtime = api;
}

export function getWapRuntime(): OpenClawPluginApi | null {
  return runtime;
}

export function startWsService(api: OpenClawPluginApi) {
  if (wss || httpServer) {
    api.logger.warn("WAP WebSocket server is already running");
    return;
  }

  const channelConfig = getWapChannelConfig(api.config);
  const host = channelConfig.host?.trim() || DEFAULT_HOST;
  const port = channelConfig.port ?? DEFAULT_PORT;

  httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, api);
  });

  wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_SIZE,
  });

  httpServer.on("upgrade", (req, socket, head) => {
    wss?.handleUpgrade(req, socket, head, (ws) => {
      wss?.emit("connection", ws, req);
    });
  });

  httpServer.listen(port, host, () => {
    api.logger.info(`WAP WebSocket/HTTP server started on ${host}:${port}`);
  });

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
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  if (wss) {
    wss.close();
    wss = null;
  }
  clients.clear();
  tempFiles.clear();
  runtime?.logger.info("WAP WebSocket/HTTP server stopped");
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
  const resolvedAccountId = account.accountId;

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

  const clientId = `wap-${resolvedAccountId}-${Date.now()}`;
  clients.set(clientId, {
    ws,
    accountId: resolvedAccountId,
    account,
    ip,
    connectedAt: new Date(),
    messageCount: 0,
    lastMessageAt: 0,
  });

  const allowFrom = resolveAllowFrom(account.config);
  const groupPolicy = resolveGroupPolicy(account.config);
  const groupAllowChats = resolveGroupAllowChats(account.config);
  const groupAllowFrom = resolveGroupAllowFrom(account.config);
  const noMentionContextGroups = resolveNoMentionContextGroups(account.config);
  const requireMentionInGroup = account.config.requireMentionInGroup ?? true;
  const silentPairing = account.config.silentPairing ?? true;

  ws.send(
    JSON.stringify({
      type: "config",
      data: {
        allow_from: allowFrom,
        group_policy: groupPolicy,
        group_allow_chats: groupAllowChats,
        group_allow_from: groupAllowFrom,
        no_mention_context_groups: noMentionContextGroups,
        dm_policy: account.config.dmPolicy ?? "pairing",
        require_mention_in_group: requireMentionInGroup,
        silent_pairing: silentPairing,
      },
    }),
  );

  api.logger.info(`WAP client connected: ${clientId} from ${ip} (account: ${resolvedAccountId})`);
  return clientId;
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse, api: OpenClawPluginApi) {
  cleanExpiredTempFiles();
  if (!req.url) {
    writeJson(res, 404, { error: "Not found" });
    return;
  }
  const requestUrl = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  if (req.method !== "GET" || !requestUrl.pathname.startsWith("/wap/files/")) {
    writeJson(res, 404, { error: "Not found" });
    return;
  }

  const fileId = requestUrl.pathname.slice("/wap/files/".length).trim();
  if (!fileId) {
    writeJson(res, 400, { error: "file id required" });
    return;
  }

  const accountId = (requestUrl.searchParams.get("accountId") ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
  const account = resolveWapAccount(api.config, accountId);
  const expectedToken = account.config.authToken ?? process.env[AUTH_TOKEN_ENV];
  const receivedToken = resolveBearerToken(req);
  if (!expectedToken || receivedToken !== expectedToken) {
    writeJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const entry = tempFiles.get(fileId);
  if (!entry || entry.accountId !== account.accountId) {
    writeJson(res, 404, { error: "File not found" });
    return;
  }
  if (entry.expiresAt <= Date.now()) {
    tempFiles.delete(fileId);
    writeJson(res, 410, { error: "File expired" });
    return;
  }

  try {
    const stat = await fs.stat(entry.filePath);
    if (!stat.isFile()) {
      writeJson(res, 404, { error: "File not found" });
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(entry.fileName)}"; filename*=UTF-8''${encodeURIComponent(entry.fileName)}`,
    );
    const stream = createReadStream(entry.filePath);
    stream.on("error", (error) => {
      api.logger.warn(`WAP temp file stream failed: ${entry.filePath} (${String(error)})`);
      if (!res.headersSent) {
        writeJson(res, 404, { error: "File not found" });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } catch (error) {
    api.logger.warn(`WAP temp file read failed: ${entry.filePath} (${String(error)})`);
    writeJson(res, 404, { error: "File not found" });
  }
}

export async function buildWapMediaCommand(params: {
  source: string;
  talker: string;
  accountId: string;
  caption?: string;
}): Promise<WapDownstreamCommand | null> {
  const source = params.source.trim();
  if (!source) {
    return null;
  }
  const caption = params.caption || undefined;
  if (/^https?:\/\//i.test(source)) {
    if (looksLikeImageMedia(source)) {
      return {
        type: "send_image",
        data: {
          talker: params.talker,
          image_url: source,
          caption,
        },
      };
    }
    return {
      type: "send_file",
      data: {
        talker: params.talker,
        file_url: source,
        file_name: extractFileNameFromUrl(source),
        caption,
      },
    };
  }

  const localPath = resolveLocalSourcePath(source);
  if (!localPath) {
    runtime?.logger.warn(`WAP file source rejected: ${source}`);
    return null;
  }
  try {
    const stat = await fs.stat(localPath);
    if (!stat.isFile()) {
      runtime?.logger.warn(`WAP file source is not a regular file: ${localPath}`);
      return null;
    }
  } catch (error) {
    runtime?.logger.warn(`WAP local file stat failed for ${localPath}: ${String(error)}`);
    return null;
  }

  const fileId = randomUUID();
  const fileName = sanitizeFileName(path.basename(localPath), "wap_media.bin");
  const now = Date.now();
  tempFiles.set(fileId, {
    accountId: params.accountId,
    filePath: localPath,
    fileName,
    expiresAt: now + TEMP_FILE_TTL_MS,
  });

  if (looksLikeImageMedia(localPath)) {
    return {
      type: "send_image",
      data: {
        talker: params.talker,
        image_id: fileId,
        account_id: params.accountId,
        caption,
      },
    };
  }
  return {
    type: "send_file",
    data: {
      talker: params.talker,
      file_id: fileId,
      account_id: params.accountId,
      file_name: fileName,
      caption,
    },
  };
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
  const normalizedTalker = normalizeWapMessagingTarget(msgData.talker);
  const normalizedSender = normalizeWapMessagingTarget(msgData.sender);
  const dmPeerId = normalizeSenderId(normalizedTalker || normalizedSender || msgData.sender);
  const senderIdForPolicy = isGroup ? msgData.sender : dmPeerId;
  const dmSenderCandidates = isGroup ? [] : buildDmSenderCandidates(msgData, dmPeerId);
  const dmPolicy = client.account.config.dmPolicy ?? "pairing";
  const allowFrom = resolveAllowFrom(client.account.config);
  const groupPolicy = resolveGroupPolicy(client.account.config);
  const groupAllowChats = resolveGroupAllowChats(client.account.config);
  const groupAllowFrom = resolveGroupAllowFrom(client.account.config);
  const noMentionContextGroups = resolveNoMentionContextGroups(client.account.config);
  const noMentionContextHistoryLimit = resolveNoMentionContextHistoryLimit(client.account.config);
  const storeAllowFrom = isGroup
    ? []
    : await core.channel.pairing.readAllowFromStore(CHANNEL_ID, undefined, client.accountId);
  const effectiveDmAllowFrom =
    dmPolicy === "allowlist" ? allowFrom : [...allowFrom, ...storeAllowFrom];
  const configuredAllowFrom = isGroup ? groupAllowFrom : effectiveDmAllowFrom;
  const senderAllowed = isGroup
    ? isSenderAllowed(senderIdForPolicy, configuredAllowFrom, true)
    : dmSenderCandidates.some((candidate) =>
        isSenderAllowed(candidate, configuredAllowFrom, dmPolicy === "open"),
      );

  if (isGroup) {
    if (!isGroupChatAllowed(msgData.talker, groupPolicy, groupAllowChats)) {
      api.logger.debug(
        `WAP drop group message from ${msgData.sender}: group ${msgData.talker} blocked by policy=${groupPolicy}`,
      );
      return;
    }
    const requireMention = client.account.config.requireMentionInGroup ?? true;
    if (requireMention && msgData.is_at_me !== true) {
      if (isNoMentionContextGroupEnabled(msgData.talker, noMentionContextGroups)) {
        appendPendingHistory(
          client.accountId,
          msgData.talker,
          {
            sender: msgData.sender,
            body: bodyText,
            timestamp: msgData.timestamp,
            messageId: String(msgData.msg_id),
          },
          noMentionContextHistoryLimit,
        );
        api.logger.debug(
          `WAP store no-mention context for ${msgData.talker} from ${msgData.sender}`,
        );
      } else {
        api.logger.debug(`WAP drop group message from ${msgData.sender}: mention required`);
      }
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
      api.logger.info(
        `WAP DM auth miss sender=${msgData.sender} talker=${msgData.talker} peer=${dmPeerId} candidates=${dmSenderCandidates.join("|")} allow=${configuredAllowFrom.join("|")} account=${client.accountId}`,
      );
      if (dmPolicy === "pairing") {
        const silentPairing = client.account.config.silentPairing ?? true;
        const request = await core.channel.pairing.upsertPairingRequest({
          channel: CHANNEL_ID,
          id: dmPeerId,
          accountId: client.accountId,
          meta: { name: msgData.sender, talker: msgData.talker, candidates: dmSenderCandidates.join(",") },
        });
        api.logger.info(
          `WAP pairing request sender=${dmPeerId} account=${client.accountId} created=${request.created}`,
        );
        if (!silentPairing && request.created && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "send_text",
              data: {
                talker: msgData.talker,
                content: core.channel.pairing.buildPairingReply({
                  channel: CHANNEL_ID,
                  idLine: `Your WeChat id: ${dmPeerId}`,
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
    senderId: senderIdForPolicy,
    isSenderAllowed: (senderId, effectiveAllowFrom) =>
      isSenderAllowed(senderId, effectiveAllowFrom, isGroup ? true : dmPolicy === "open"),
    readAllowFromStore: async () =>
      isGroup
        ? []
        : await core.channel.pairing.readAllowFromStore(CHANNEL_ID, undefined, client.accountId),
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

  const fromLabel = isGroup ? `${msgData.sender} in ${msgData.talker}` : dmPeerId;
  const body = core.channel.reply.formatInboundEnvelope({
    channel: "WeChat",
    from: fromLabel,
    timestamp: msgData.timestamp,
    body: `${bodyText}\n\n${wechatContextHint}`,
    chatType,
    sender: { name: msgData.sender, id: senderIdForPolicy },
  });
  let combinedBody = body;
  if (isGroup) {
    const pendingEntries = consumePendingHistory(client.accountId, msgData.talker);
    if (pendingEntries.length > 0) {
      const historyLines: string[] = [];
      for (const entry of pendingEntries) {
        historyLines.push(
          core.channel.reply.formatInboundEnvelope({
            channel: "WeChat",
            from: `${entry.sender} in ${msgData.talker}`,
            timestamp: entry.timestamp,
            body: `${entry.body} [id:${entry.messageId ?? "unknown"} group:${msgData.talker}]`,
            chatType: "group",
            sender: { name: entry.sender, id: entry.sender },
          }),
        );
      }
      combinedBody = `${historyLines.join("\n")}\n${body}`;
    }
  }

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: combinedBody,
    RawBody: bodyText,
    CommandBody: bodyText,
    From: isGroup ? `${CHANNEL_ID}:group:${msgData.talker}` : `${CHANNEL_ID}:${dmPeerId}`,
    To: msgData.talker,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    GroupSubject: isGroup ? msgData.talker : undefined,
    SenderName: msgData.sender,
    SenderId: senderIdForPolicy,
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
        const mediaList = payload.mediaUrls?.length
          ? payload.mediaUrls
          : payload.mediaUrl
            ? [payload.mediaUrl]
            : [];
        const replyText = payload.text ?? "";

        if (mediaList.length > 0) {
          for (const mediaUrl of mediaList) {
            if (!mediaUrl || !mediaUrl.trim()) {
              api.logger.warn("WAP skip empty media source in reply");
              continue;
            }
            const command = await buildWapMediaCommand({
              source: mediaUrl,
              talker: msgData.talker,
              accountId: client.accountId,
              caption: replyText || undefined,
            });
            if (!command) {
              continue;
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(command));
            } else {
              api.logger.warn(`WAP WebSocket not open, cannot send media reply to ${msgData.talker}`);
            }
          }
          return;
        }

        if (replyText) {
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

export function sendToClient(command: WapDownstreamCommand, accountId?: string): boolean {
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
