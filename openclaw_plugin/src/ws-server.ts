import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { WapUpstreamMessage, WapSendTextCommand, WapMessageData } from "./protocol.js";

let wss: WebSocketServer | null = null;
let runtime: OpenClawPluginApi | null = null;

// 客户端管理：按 accountId 隔离
interface ClientInfo {
    ws: WebSocket;
    accountId: string;
    ip: string;
    connectedAt: Date;
    messageCount: number;
    lastMessageAt: number;
}
const clients = new Map<string, ClientInfo>();

// 安全配置
const DEFAULT_PORT = 8765;
const AUTH_TOKEN_ENV = "WAP_AUTH_TOKEN"; // 环境变量名称，不是 token 值！
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB
const RATE_LIMIT_WINDOW_MS = 1000; // 1 秒
const RATE_LIMIT_MAX_MESSAGES = 10; // 每秒最多 10 条消息

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
    // 调试：输出完整配置
    api.logger.debug(`WAP channels config: ${JSON.stringify(api.config.channels)}`);

    const wapConfig = (api.config.channels as Record<string, unknown>)?.["openclaw-channel-wap"] as
        | { port?: number; authToken?: string; whitelist?: string[] }
        | undefined;

    api.logger.debug(`WAP wapConfig parsed: ${JSON.stringify(wapConfig)}`);

    const port = wapConfig?.port ?? DEFAULT_PORT;
    const authToken = process.env[AUTH_TOKEN_ENV] ?? wapConfig?.authToken;

    // 【安全】强制要求配置 token
    if (!authToken) {
        api.logger.error(
            "WAP WebSocket server NOT started: authToken is required. " +
            "Set WAP_AUTH_TOKEN env or channels.openclaw-channel-wap.authToken in config."
        );
        return;
    }

    wss = new WebSocketServer({
        port,
        maxPayload: MAX_MESSAGE_SIZE, // 【安全】限制消息大小
    });
    api.logger.info(`WAP WebSocket server started on port ${port}`);

    // 日志：白名单配置
    const whitelist = wapConfig?.whitelist ?? [];
    api.logger.info(`WAP whitelist configured: ${whitelist.length > 0 ? whitelist.join(", ") : "(empty - all allowed)"}`);

    wss.on("connection", (ws, req) => {
        const clientId = handleConnection(ws, req, authToken, api, whitelist);
        if (!clientId) return;

        ws.on("message", (data) => handleMessage(clientId, data, api));
        ws.on("close", () => handleDisconnect(clientId, api));
        ws.on("error", (err) => api.logger.error(`WebSocket error: ${err.message}`));
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

function handleConnection(
    ws: WebSocket,
    req: IncomingMessage,
    authToken: string,
    api: OpenClawPluginApi,
    whitelist: string[]
): string | null {
    // 获取客户端 IP
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
        ?? req.socket.remoteAddress
        ?? "unknown";

    // 【安全】Token 认证（已强制要求）
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${authToken}`) {
        api.logger.warn(`WAP connection rejected from ${ip}: invalid token`);
        ws.close(4001, "Unauthorized");
        return null;
    }

    // 从 query 或 header 获取 accountId（可选，默认 "default"）
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const accountId = url.searchParams.get("accountId")
        ?? req.headers["x-wap-account-id"]?.toString()
        ?? "default";

    const clientId = `wap-${accountId}-${Date.now()}`;
    clients.set(clientId, {
        ws,
        accountId,
        ip,
        connectedAt: new Date(),
        messageCount: 0,
        lastMessageAt: 0,
    });

    api.logger.info(`WAP client connected: ${clientId} from ${ip} (account: ${accountId})`);

    // 下发配置（白名单等）
    const configMessage = {
        type: "config",
        data: {
            whitelist: whitelist,
        },
    };
    ws.send(JSON.stringify(configMessage));
    api.logger.debug(`WAP config sent to ${clientId}: whitelist=${whitelist.length} items`);

    return clientId;
}

async function handleMessage(
    clientId: string,
    data: Buffer | ArrayBuffer | Buffer[],
    api: OpenClawPluginApi
) {
    const client = clients.get(clientId);
    if (!client) return;

    // 【安全】速率限制
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

        // 【安全】先解析 JSON
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            api.logger.warn(`WAP invalid JSON from ${clientId}`);
            return;
        }

        // 【安全】验证消息结构
        const msg = validateUpstreamMessage(parsed);
        if (!msg) {
            api.logger.warn(`WAP invalid message structure from ${clientId}`);
            return;
        }

        if (msg.type === "heartbeat") {
            client.ws.send(JSON.stringify({ type: "pong" }));
            return;
        }

        if (msg.type === "message") {
            api.logger.debug(
                `WAP message from ${msg.data.sender}: ${msg.data.content.substring(0, 50)}`
            );

            // 使用 OpenClaw 的正确 API 处理入站消息
            await processWapInboundMessage(api, client.accountId, msg.data, client.ws);
        }
    } catch (err) {
        api.logger.error(`Failed to handle WAP message: ${err}`);
    }
}

/**
 * 处理 WAP 入站消息，使用 OpenClaw 的 dispatchReplyFromConfig
 */
async function processWapInboundMessage(
    api: OpenClawPluginApi,
    accountId: string,
    msgData: WapMessageData,
    ws: WebSocket
) {
    const core = api.runtime;
    const cfg = api.config;

    // 确定消息类型
    const kind: "dm" | "group" = msgData.is_group ? "group" : "dm";
    const chatType = kind === "dm" ? "direct" : "group";

    // 解析路由
    const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "openclaw-channel-wap",
        accountId,
        peer: {
            kind,
            id: msgData.talker,
        },
    });

    const sessionKey = route.sessionKey;
    const bodyText = msgData.content.trim();

    if (!bodyText) return;

    // 记录 channel activity
    core.channel.activity.record({
        channel: "openclaw-channel-wap",
        accountId,
        direction: "inbound",
    });

    // 构建 from 标签
    const fromLabel = kind === "dm"
        ? msgData.sender
        : `${msgData.sender} in ${msgData.talker}`;

    // 格式化入站消息
    const body = core.channel.reply.formatInboundEnvelope({
        channel: "WeChat",
        from: fromLabel,
        timestamp: msgData.timestamp,
        body: bodyText + "\n\n" + wechatContextHint,
        chatType,
        sender: { name: msgData.sender, id: msgData.sender },
    });

    // 构建 context payload
    const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: bodyText,
        CommandBody: bodyText,
        From: kind === "dm" ? `openclaw-channel-wap:${msgData.sender}` : `openclaw-channel-wap:group:${msgData.talker}`,
        To: msgData.talker,
        SessionKey: sessionKey,
        AccountId: route.accountId,
        ChatType: chatType,
        ConversationLabel: fromLabel,
        GroupSubject: kind !== "dm" ? msgData.talker : undefined,
        SenderName: msgData.sender,
        SenderId: msgData.sender,
        Provider: "openclaw-channel-wap" as const,
        Surface: "openclaw-channel-wap" as const,
        MessageSid: String(msgData.msg_id),
        Timestamp: msgData.timestamp,
        WasMentioned: undefined,
        CommandAuthorized: true, // WAP 默认授权（已通过 token 认证）
        OriginatingChannel: "openclaw-channel-wap" as const,
        OriginatingTo: msgData.talker,
    });

    // 获取文本分块限制
    const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "openclaw-channel-wap", accountId, {
        fallbackLimit: 4000,
    });

    // 创建回复分发器
    const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
            humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            deliver: async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
                const replyText = payload.text ?? "";
                if (!replyText) return;

                // 分块发送
                const chunkMode = core.channel.text.resolveChunkMode(cfg, "openclaw-channel-wap", accountId);
                const chunks = core.channel.text.chunkMarkdownTextWithMode(replyText, textLimit, chunkMode);

                for (const chunk of chunks.length > 0 ? chunks : [replyText]) {
                    if (!chunk) continue;

                    // 通过 WebSocket 发送回复
                    const command: WapSendTextCommand = {
                        type: "send_text",
                        data: {
                            talker: msgData.talker,
                            content: chunk,
                        },
                    };

                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(command));
                        api.logger.debug(`WAP reply sent to ${msgData.talker}: ${chunk.substring(0, 50)}...`);
                    } else {
                        api.logger.warn(`WAP WebSocket not open, cannot send reply to ${msgData.talker}`);
                    }
                }
            },
            onError: (err: unknown, info: { kind: string }) => {
                api.logger.error(`WAP ${info.kind} reply failed: ${String(err)}`);
            },
        });

    // 调用 OpenClaw 的核心回复处理
    await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions,
    });

    markDispatchIdle();
}

// 【安全】验证上行消息结构
function validateUpstreamMessage(data: unknown): WapUpstreamMessage | null {
    if (typeof data !== "object" || data === null) return null;

    const obj = data as Record<string, unknown>;

    if (obj.type === "heartbeat") {
        return { type: "heartbeat" };
    }

    if (obj.type === "message") {
        const msgData = obj.data;
        if (typeof msgData !== "object" || msgData === null) return null;

        const d = msgData as Record<string, unknown>;

        // 验证必须字段
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
            },
        };
    }

    return null;
}

function handleDisconnect(clientId: string, api: OpenClawPluginApi) {
    const client = clients.get(clientId);
    clients.delete(clientId);
    api.logger.info(
        `WAP client disconnected: ${clientId}` +
        (client ? ` (was connected for ${Date.now() - client.connectedAt.getTime()}ms)` : "")
    );
}

// 发送消息到指定 accountId 的客户端（而非广播）
export function sendToClient(command: WapSendTextCommand, accountId?: string): boolean {
    let sent = false;
    const targetAccountId = accountId ?? "default";

    for (const [, client] of clients) {
        if (client.accountId === targetAccountId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(command));
            sent = true;
            break; // 只发送给第一个匹配的客户端
        }
    }
    return sent;
}

// 获取当前连接的客户端数量
export function getClientCount(): number {
    return clients.size;
}

// 获取客户端状态（用于调试）
export function getClientStats(): Array<{ clientId: string; accountId: string; ip: string; connectedAt: Date }> {
    return Array.from(clients.entries()).map(([clientId, info]) => ({
        clientId,
        accountId: info.accountId,
        ip: info.ip,
        connectedAt: info.connectedAt,
    }));
}
