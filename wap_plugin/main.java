import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.alibaba.fastjson2.JSONArray;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.List;
import java.util.HashSet;
import java.util.Set;
import java.util.Collections;
import java.io.File;
import java.io.FileReader;
import java.io.BufferedReader;

// ============================================================
// 配置区域 - 请根据实际情况修改
// ============================================================

// 服务器 WebSocket 地址
String DEFAULT_SERVER_URL = "ws(s)://xxx.xxx.xxx:xxx/ws";
String SERVER_URL = DEFAULT_SERVER_URL;

// 认证 Token（与服务端 WAP_AUTH_TOKEN 保持一致）
String DEFAULT_AUTH_TOKEN = "xxx";
String AUTH_TOKEN = DEFAULT_AUTH_TOKEN;

// 允许列表（从服务端动态下发，不再本地配置）
Set ALLOW_FROM = Collections.synchronizedSet(new HashSet());
Set GROUP_ALLOW_CHATS = Collections.synchronizedSet(new HashSet());
Set GROUP_ALLOW_FROM = Collections.synchronizedSet(new HashSet());
boolean configReceived = false;  // 是否已收到服务端配置
String groupPolicy = "open";  // 群策略: open/allowlist/disabled
boolean requireMentionInGroup = true;  // 群聊是否必须 @ 才触发

// 心跳间隔（毫秒）
long DEFAULT_HEARTBEAT_INTERVAL = 20000;
long HEARTBEAT_INTERVAL = DEFAULT_HEARTBEAT_INTERVAL;

// 心跳容错配置
int DEFAULT_MAX_MISSED_HEARTBEATS = 2;  // 连续 N 次心跳失败才视为断联（容忍 40 秒网络波动）
int MAX_MISSED_HEARTBEATS = DEFAULT_MAX_MISSED_HEARTBEATS;

// 【安全】发送速率限制（每分钟最多发送的消息数）
int DEFAULT_SEND_RATE_LIMIT = 30;
int SEND_RATE_LIMIT = DEFAULT_SEND_RATE_LIMIT;

// 重连延迟配置（毫秒）
long RECONNECT_DELAY_FIRST = 0;        // 第一次断开后立即重试
long RECONNECT_DELAY_SECOND = 30000;   // 第二次重试延迟 30 秒
long RECONNECT_DELAY_DEFAULT = 60000;  // 之后每次间隔 1 分钟

// 消息重试配置
int DEFAULT_MAX_SEND_RETRIES = 3;              // 最大重试次数
long DEFAULT_RETRY_DELAY_MS = 2000;            // 重试间隔（毫秒）
int DEFAULT_MAX_PENDING_MESSAGES = 5;          // 最大待发送队列长度
long DEFAULT_MESSAGE_TTL_MS = 30000;           // 消息过期时间（30秒），超过则丢弃
int MAX_SEND_RETRIES = DEFAULT_MAX_SEND_RETRIES;
long RETRY_DELAY_MS = DEFAULT_RETRY_DELAY_MS;
int MAX_PENDING_MESSAGES = DEFAULT_MAX_PENDING_MESSAGES;
long MESSAGE_TTL_MS = DEFAULT_MESSAGE_TTL_MS;

// ============================================================
// 运行时变量（请勿修改）
// ============================================================

OkHttpClient client = null;
WebSocket webSocket = null;
Thread heartbeatThread = null;
Thread retrySenderThread = null;
boolean isConnected = false;
boolean shouldReconnect = true;
int reconnectAttempt = 0;
int missedHeartbeats = 0;       // 连续未收到 pong 的次数
boolean awaitingPong = false;   // 是否正在等待 pong 响应

// 【安全】速率限制计数器
long sendRateLimitWindowStart = 0;
int sendCountInWindow = 0;

// 消息重试队列
ConcurrentLinkedQueue pendingMessages = new ConcurrentLinkedQueue();

// ============================================================
// 生命周期方法
// ============================================================

void onLoad() {
    loadLocalConfig();
    log("OpenClaw 消息桥接器加载中...");
    // 【安全】不要在日志中显示完整 URL，可能包含敏感信息
    log("服务器地址: " + maskUrl(SERVER_URL));
    log("allowFrom 配置将从服务端下发");
    initWebSocketClient();
    connectToServer();
}

void loadLocalConfig() {
    try {
        File cfgFile = new File(pluginDir, "config.yml");
        if (!cfgFile.exists() || !cfgFile.isFile()) {
            log("未找到 config.yml，使用内置默认配置");
            return;
        }

        BufferedReader reader = null;
        try {
            reader = new BufferedReader(new FileReader(cfgFile));
            String line;
            while ((line = reader.readLine()) != null) {
                parseConfigLine(line);
            }
        } finally {
            if (reader != null) {
                try { reader.close(); } catch (Exception ignore) {}
            }
        }

        log("已加载本地配置: " + cfgFile.getAbsolutePath());
    } catch (Exception e) {
        log("加载 config.yml 失败，使用内置默认配置: " + e.getMessage());
    }
}

void parseConfigLine(String rawLine) {
    if (rawLine == null) {
        return;
    }
    String line = rawLine.trim();
    if (line.isEmpty() || line.startsWith("#")) {
        return;
    }

    int commentIdx = line.indexOf(" #");
    if (commentIdx >= 0) {
        line = line.substring(0, commentIdx).trim();
    }
    if (line.isEmpty()) {
        return;
    }

    int idx = line.indexOf(":");
    if (idx <= 0) {
        return;
    }

    String key = line.substring(0, idx).trim();
    String value = line.substring(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.substring(1, value.length() - 1);
    }

    if ("server_url".equals(key)) {
        if (value.length() > 0) SERVER_URL = value;
        return;
    }
    if ("auth_token".equals(key)) {
        if (value.length() > 0) AUTH_TOKEN = value;
        return;
    }
    if ("heartbeat_interval_ms".equals(key)) {
        HEARTBEAT_INTERVAL = parseLongOrDefault(value, DEFAULT_HEARTBEAT_INTERVAL);
        return;
    }
    if ("max_missed_heartbeats".equals(key)) {
        MAX_MISSED_HEARTBEATS = (int) parseLongOrDefault(value, DEFAULT_MAX_MISSED_HEARTBEATS);
        return;
    }
    if ("send_rate_limit_per_min".equals(key)) {
        SEND_RATE_LIMIT = (int) parseLongOrDefault(value, DEFAULT_SEND_RATE_LIMIT);
        return;
    }
    if ("max_send_retries".equals(key)) {
        MAX_SEND_RETRIES = (int) parseLongOrDefault(value, DEFAULT_MAX_SEND_RETRIES);
        return;
    }
    if ("retry_delay_ms".equals(key)) {
        RETRY_DELAY_MS = parseLongOrDefault(value, DEFAULT_RETRY_DELAY_MS);
        return;
    }
    if ("max_pending_messages".equals(key)) {
        MAX_PENDING_MESSAGES = (int) parseLongOrDefault(value, DEFAULT_MAX_PENDING_MESSAGES);
        return;
    }
    if ("message_ttl_ms".equals(key)) {
        MESSAGE_TTL_MS = parseLongOrDefault(value, DEFAULT_MESSAGE_TTL_MS);
        return;
    }
}

long parseLongOrDefault(String raw, long def) {
    try {
        if (raw == null) return def;
        String cleaned = raw.trim();
        if (cleaned.isEmpty()) return def;
        return Long.parseLong(cleaned);
    } catch (Exception e) {
        return def;
    }
}

void onUnLoad() {
    log("OpenClaw 消息桥接器卸载中...");
    shouldReconnect = false;

    if (heartbeatThread != null) {
        heartbeatThread.interrupt();
        heartbeatThread = null;
    }

    if (retrySenderThread != null) {
        retrySenderThread.interrupt();
        retrySenderThread = null;
    }

    // 清理待发送队列
    int dropped = pendingMessages.size();
    pendingMessages.clear();
    if (dropped > 0) {
        log("丢弃 " + dropped + " 条待发送消息");
    }

    if (webSocket != null) {
        webSocket.close(1000, "Plugin unloading");
        webSocket = null;
    }

    isConnected = false;
    log("OpenClaw 消息桥接器已卸载");
}

// 【安全】URL 脱敏
String maskUrl(String url) {
    if (url == null) return "null";
    // 只显示协议和主机名，隐藏路径和参数
    int schemeEnd = url.indexOf("://");
    if (schemeEnd < 0) return "***";
    int hostEnd = url.indexOf("/", schemeEnd + 3);
    if (hostEnd < 0) hostEnd = url.indexOf("?", schemeEnd + 3);
    if (hostEnd < 0) hostEnd = url.length();
    return url.substring(0, hostEnd) + "/***";
}

// ============================================================
// WebSocket 连接管理
// ============================================================

void initWebSocketClient() {
    // 注意：不使用 pingInterval，因为 OkHttp 单次 ping 超时就会断联
    // 我们使用自定义心跳机制，支持连续多次失败才断联
    client = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build();
}

void connectToServer() {
    if (webSocket != null) {
        return;
    }

    log("正在连接服务器...");

    Request request = new Request.Builder()
        .url(SERVER_URL)
        .addHeader("Authorization", "Bearer " + AUTH_TOKEN)
        .build();

    webSocket = client.newWebSocket(request, new WebSocketListener() {
        public void onOpen(WebSocket ws, Response response) {
            log("WebSocket 连接成功，等待服务端下发配置...");
            isConnected = true;
            reconnectAttempt = 0;
            missedHeartbeats = 0;
            awaitingPong = false;
            configReceived = false;  // 重置配置状态
            ALLOW_FROM.clear();
            GROUP_ALLOW_CHATS.clear();
            GROUP_ALLOW_FROM.clear();
            groupPolicy = "open";
            startHeartbeat();
            startRetrySender();
        }

        public void onMessage(WebSocket ws, String text) {
            handleServerMessage(text);
        }

        public void onClosing(WebSocket ws, int code, String reason) {
            log("WebSocket 正在关闭: " + reason);
            isConnected = false;
        }

        public void onClosed(WebSocket ws, int code, String reason) {
            log("WebSocket 已关闭: " + reason);
            isConnected = false;
            webSocket = null;
            scheduleReconnect();
        }

        public void onFailure(WebSocket ws, Throwable t, Response response) {
            log("WebSocket 连接失败: " + t.getMessage());
            isConnected = false;
            webSocket = null;
            scheduleReconnect();
        }
    });
}

void scheduleReconnect() {
    if (!shouldReconnect) {
        return;
    }

    reconnectAttempt++;

    // 计算延迟时间
    long delay;
    if (reconnectAttempt == 1) {
        delay = RECONNECT_DELAY_FIRST;
    } else if (reconnectAttempt == 2) {
        delay = RECONNECT_DELAY_SECOND;
    } else {
        delay = RECONNECT_DELAY_DEFAULT;
    }

    log("将在 " + (delay / 1000) + " 秒后进行第 " + reconnectAttempt + " 次重连");

    new Thread(new Runnable() {
        public void run() {
            try {
                if (delay > 0) {
                    Thread.sleep(delay);
                }
                if (shouldReconnect && webSocket == null) {
                    connectToServer();
                }
            } catch (InterruptedException e) {
                // 忽略中断
            }
        }
    }).start();
}

void startHeartbeat() {
    if (heartbeatThread != null) {
        heartbeatThread.interrupt();
    }

    heartbeatThread = new Thread(new Runnable() {
        public void run() {
            while (isConnected && !Thread.currentThread().isInterrupted()) {
                try {
                    Thread.sleep(HEARTBEAT_INTERVAL);
                    if (webSocket != null && isConnected) {
                        // 检查上一次心跳是否收到了 pong
                        if (awaitingPong) {
                            // 上一次心跳没有收到响应
                            missedHeartbeats++;
                            log("心跳超时 (" + missedHeartbeats + "/" + MAX_MISSED_HEARTBEATS + ")");

                            if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
                                // 连续多次心跳失败，视为断联
                                log("连续 " + MAX_MISSED_HEARTBEATS + " 次心跳无响应，主动断开连接");
                                isConnected = false;
                                awaitingPong = false;
                                webSocket.close(1000, "Heartbeat timeout");
                                webSocket = null;
                                scheduleReconnect();
                                break;
                            }
                        }

                        // 发送新的心跳
                        awaitingPong = true;
                        JSONObject heartbeat = new JSONObject();
                        heartbeat.put("type", "heartbeat");
                        webSocket.send(heartbeat.toString());
                    }
                } catch (InterruptedException e) {
                    break;
                } catch (Exception e) {
                    log("心跳发送失败: " + e.getMessage());
                }
            }
        }
    });
    heartbeatThread.setDaemon(true);
    heartbeatThread.start();
}

// ============================================================
// 消息重试发送机制
// ============================================================

// 待发送消息封装（使用 Map 代替类以兼容 BeanShell）
java.util.HashMap createPendingMessage(String payload, String description) {
    java.util.HashMap msg = new java.util.HashMap();
    msg.put("payload", payload);
    msg.put("retryCount", 0);
    msg.put("createdAt", System.currentTimeMillis());
    msg.put("description", description);
    return msg;
}

void startRetrySender() {
    if (retrySenderThread != null) {
        retrySenderThread.interrupt();
    }

    retrySenderThread = new Thread(new Runnable() {
        public void run() {
            while (shouldReconnect && !Thread.currentThread().isInterrupted()) {
                try {
                    // 从队列取出待发送消息
                    java.util.HashMap pending = (java.util.HashMap) pendingMessages.poll();
                    if (pending == null) {
                        // 队列空，等待一段时间
                        Thread.sleep(500);
                        continue;
                    }

                    // 检查消息是否过期
                    long createdAt = ((Long) pending.get("createdAt")).longValue();
                    long age = System.currentTimeMillis() - createdAt;
                    if (age > MESSAGE_TTL_MS) {
                        String description = (String) pending.get("description");
                        log("消息已过期 (" + (age / 1000) + "s)，丢弃: " + description);
                        continue;  // 丢弃，处理下一条
                    }

                    // 检查连接状态
                    if (webSocket == null || !isConnected) {
                        // 连接断开，放回队列等待重连
                        pendingMessages.offer(pending);
                        Thread.sleep(1000);
                        continue;
                    }

                    // 尝试发送
                    boolean success = false;
                    String payload = (String) pending.get("payload");
                    String description = (String) pending.get("description");
                    try {
                        webSocket.send(payload);
                        success = true;
                        log("消息发送成功: " + description);
                    } catch (Exception e) {
                        log("消息发送失败: " + description + " - " + e.getMessage());
                    }

                    if (!success) {
                        int retryCount = ((Integer) pending.get("retryCount")).intValue();
                        retryCount++;
                        pending.put("retryCount", retryCount);
                        if (retryCount < MAX_SEND_RETRIES) {
                            log("消息入队重试 (" + retryCount + "/" + MAX_SEND_RETRIES + "): " + description);
                            pendingMessages.offer(pending);
                            Thread.sleep(RETRY_DELAY_MS);
                        } else {
                            log("消息重试次数已达上限，丢弃: " + description);
                        }
                    }
                } catch (InterruptedException e) {
                    break;
                }
            }
        }
    });
    retrySenderThread.setDaemon(true);
    retrySenderThread.start();
}

// 入队待发送消息
boolean enqueueMessage(String payload, String description) {
    if (pendingMessages.size() >= MAX_PENDING_MESSAGES) {
        log("消息队列已满，丢弃新消息: " + description);
        return false;
    }
    pendingMessages.offer(createPendingMessage(payload, description));
    return true;
}

// ============================================================
// 消息处理
// ============================================================

void onHandleMsg(Object msgInfoBean) {
    // 过滤：自己发送的消息不转发
    if (msgInfoBean.isSend()) {
        return;
    }

    // 暂只支持文本消息
    if (!msgInfoBean.isText()) {
        return;
    }

    // 检查是否已收到服务端配置
    if (!configReceived) {
        return;
    }

    String sender = msgInfoBean.getSendTalker();
    String talker = msgInfoBean.getTalker();
    boolean isMentionedMe = resolveIsMentionedMe(msgInfoBean);

    if (msgInfoBean.isGroupChat()) {
        // 群策略过滤（仿 Discord/TG 的 groupPolicy 层）
        if (!isGroupChatAllowedByPolicy(talker)) {
            return;
        }
        // 群聊可选：仅 @ 我时触发
        if (requireMentionInGroup && !isMentionedMe) {
            return;
        }
        // 群成员 allowlist（可选）
        if (GROUP_ALLOW_FROM.size() > 0 && !GROUP_ALLOW_FROM.contains(normalizeId(sender))) {
            return;
        }
    } else {
        if (ALLOW_FROM.size() > 0 && !ALLOW_FROM.contains(normalizeId(sender))) {
            return;
        }
    }

    // 构建消息 JSON
    try {
        JSONObject msg = new JSONObject();
        msg.put("type", "message");

        JSONObject data = new JSONObject();
        data.put("msg_id", msgInfoBean.getMsgId());
        data.put("msg_type", msgInfoBean.getType());
        data.put("talker", talker);
        data.put("sender", sender);
        data.put("content", msgInfoBean.getContent());
        data.put("timestamp", msgInfoBean.getCreateTime());
        data.put("is_private", msgInfoBean.isPrivateChat());
        data.put("is_group", msgInfoBean.isGroupChat());
        data.put("is_at_me", isMentionedMe);
        List atUsers = msgInfoBean.getAtUserList();
        if (atUsers != null) {
            data.put("at_user_list", atUsers);
        }

        msg.put("data", data);

        // 通过队列发送，支持重试
        String contentPreview = msgInfoBean.getContent();
        if (contentPreview.length() > 30) {
            contentPreview = contentPreview.substring(0, 30) + "...";
        }
        String description = sender + " -> " + contentPreview;

        if (enqueueMessage(msg.toString(), description)) {
            log("消息入队: " + description);
        }
    } catch (Exception e) {
        log("消息处理失败: " + e.getMessage());
    }
}

boolean resolveIsMentionedMe(Object msgInfoBean) {
    try {
        if (!msgInfoBean.isGroupChat()) {
            return false;
        }
        if (msgInfoBean.isAtMe()) {
            return true;
        }

        String loginWxid = getLoginWxid();
        if (loginWxid == null || loginWxid.isEmpty()) {
            return false;
        }

        List atUsers = msgInfoBean.getAtUserList();
        if (atUsers == null || atUsers.isEmpty()) {
            return false;
        }

        for (int i = 0; i < atUsers.size(); i++) {
            Object item = atUsers.get(i);
            if (item != null && loginWxid.equals(String.valueOf(item))) {
                return true;
            }
        }
    } catch (Exception e) {
        log("解析 @我 状态失败: " + e.getMessage());
    }
    return false;
}

String normalizeId(String raw) {
    if (raw == null) {
        return "";
    }
    return raw.trim().toLowerCase();
}

boolean isGroupChatAllowedByPolicy(String talker) {
    String normalizedTalker = normalizeId(talker);
    if ("disabled".equals(groupPolicy)) {
        return false;
    }
    if ("open".equals(groupPolicy)) {
        return true;
    }
    if (!"allowlist".equals(groupPolicy)) {
        return true;
    }
    if (GROUP_ALLOW_CHATS.size() == 0) {
        return false;
    }
    return GROUP_ALLOW_CHATS.contains("*") || GROUP_ALLOW_CHATS.contains(normalizedTalker);
}

// ============================================================
// 处理服务器指令
// ============================================================

void handleServerMessage(String text) {
    try {
        JSONObject msg = JSON.parseObject(text);
        String type = msg.getString("type");

        // 心跳响应
        if ("pong".equals(type)) {
            awaitingPong = false;
            missedHeartbeats = 0;
            return;
        }

        // 服务端下发配置（白名单等）
        if ("config".equals(type)) {
            JSONObject data = msg.getJSONObject("data");
            configReceived = true;
            if (data != null) {
                JSONArray allowFrom = data.getJSONArray("allow_from");
                ALLOW_FROM.clear();
                if (allowFrom != null) {
                    for (int i = 0; i < allowFrom.size(); i++) {
                        String wxid = allowFrom.getString(i);
                        String normalized = normalizeId(wxid);
                        if (!normalized.isEmpty()) {
                            ALLOW_FROM.add(normalized);
                        }
                    }
                }

                String nextGroupPolicy = data.getString("group_policy");
                if ("allowlist".equals(nextGroupPolicy) || "disabled".equals(nextGroupPolicy) || "open".equals(nextGroupPolicy)) {
                    groupPolicy = nextGroupPolicy;
                } else {
                    groupPolicy = "open";
                }

                JSONArray groupAllowChats = data.getJSONArray("group_allow_chats");
                GROUP_ALLOW_CHATS.clear();
                if (groupAllowChats != null) {
                    for (int i = 0; i < groupAllowChats.size(); i++) {
                        String talker = groupAllowChats.getString(i);
                        String normalized = normalizeId(talker);
                        if (!normalized.isEmpty()) {
                            GROUP_ALLOW_CHATS.add(normalized);
                        }
                    }
                }

                JSONArray groupAllowFrom = data.getJSONArray("group_allow_from");
                GROUP_ALLOW_FROM.clear();
                if (groupAllowFrom != null) {
                    for (int i = 0; i < groupAllowFrom.size(); i++) {
                        String wxid = groupAllowFrom.getString(i);
                        String normalized = normalizeId(wxid);
                        if (!normalized.isEmpty()) {
                            GROUP_ALLOW_FROM.add(normalized);
                        }
                    }
                }

                Boolean requireMention = data.getBoolean("require_mention_in_group");
                if (requireMention != null) {
                    requireMentionInGroup = requireMention.booleanValue();
                }

                log("收到服务端配置，group_policy=" + groupPolicy + ", group_allow_chats: " + GROUP_ALLOW_CHATS + ", allow_from: " + ALLOW_FROM + ", group_allow_from: " + GROUP_ALLOW_FROM + ", require_mention_in_group=" + requireMentionInGroup);
            }
            return;
        }

        // 发送文本消息
        if ("send_text".equals(type)) {
            JSONObject data = msg.getJSONObject("data");
            if (data == null) {
                log("send_text 指令缺少 data");
                return;
            }
            String talker = data.getString("talker");
            String content = data.getString("content");

            if (talker == null || content == null) {
                log("send_text 指令缺少必要参数");
                return;
            }

            // 【安全】出站 allowFrom 验证（仅私聊目标生效）
            boolean isGroupTalker = talker.endsWith("@chatroom");
            if (!isGroupTalker && ALLOW_FROM.size() > 0 && !ALLOW_FROM.contains(normalizeId(talker))) {
                log("【安全】拒绝发送消息到非 allowFrom 用户: " + talker);
                return;
            }

            // 【安全】速率限制
            long now = System.currentTimeMillis();
            if (now - sendRateLimitWindowStart > 60000) {
                // 新的一分钟窗口
                sendRateLimitWindowStart = now;
                sendCountInWindow = 0;
            }
            sendCountInWindow++;
            if (sendCountInWindow > SEND_RATE_LIMIT) {
                log("【安全】发送速率超限，本分钟已发送 " + sendCountInWindow + " 条消息");
                return;
            }

            sendText(talker, content);
            String preview = content;
            if (preview.length() > 50) {
                preview = preview.substring(0, 50) + "...";
            }
            log("已发送消息到 " + talker + ": " + preview);
            return;
        }

        // 预留：发送图片消息
        if ("send_image".equals(type)) {
            log("图片消息暂不支持，请等待后续版本");
            return;
        }

        // 预留：发送语音消息
        if ("send_voice".equals(type)) {
            log("语音消息暂不支持，请等待后续版本");
            return;
        }

        log("收到未知指令: " + type);
    } catch (Exception e) {
        log("解析服务器消息失败: " + e.getMessage());
    }
}
