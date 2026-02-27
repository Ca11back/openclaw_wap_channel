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
import java.io.InputStream;
import java.io.FileOutputStream;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

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
Set NO_MENTION_CONTEXT_GROUPS = Collections.synchronizedSet(new HashSet());
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

// 调试：仅打印 msgInfoBean，不做消息转发
boolean DEFAULT_DEBUG_DUMP_ONLY = false;
boolean DEBUG_DUMP_ONLY = DEFAULT_DEBUG_DUMP_ONLY;

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
    log("debug_dump_only=" + DEBUG_DUMP_ONLY);
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
    if ("debug_dump_only".equals(key)) {
        DEBUG_DUMP_ONLY = "true".equalsIgnoreCase(value) || "1".equals(value);
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
            NO_MENTION_CONTEXT_GROUPS.clear();
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

boolean sendMessageDirectly(String payload, String description) {
    if (webSocket == null || !isConnected) {
        return false;
    }
    try {
        webSocket.send(payload);
        log("消息发送成功: " + description);
        return true;
    } catch (Exception e) {
        log("消息直发失败，转入队列: " + description + " - " + e.getMessage());
        return false;
    }
}

// ============================================================
// 消息处理
// ============================================================

void onHandleMsg(Object msgInfoBean) {
    // 过滤：自己发送的消息不转发
    if (msgInfoBean.isSend()) {
        return;
    }

    // 仅上报文本消息，其他类型忽略
    boolean isTextMessage = msgInfoBean.isText();
    if (!isTextMessage) {
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
        // 群聊可选：仅 @ 我时触发；部分群可配置为未@也上报用于上下文
        if (requireMentionInGroup && !isMentionedMe && !isNoMentionContextGroupEnabled(talker)) {
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

    // 调试模式：完整打印 msgInfoBean 后立即结束，不进行后续转发
    if (DEBUG_DUMP_ONLY) {
        dumpMsgInfoBean(msgInfoBean);
        return;
    }

    // 构建消息 JSON
    try {
        String content = buildInboundContent(msgInfoBean, isTextMessage);
        if (content == null || content.trim().isEmpty()) {
            return;
        }
        JSONObject msg = new JSONObject();
        msg.put("type", "message");

        JSONObject data = new JSONObject();
        data.put("msg_id", msgInfoBean.getMsgId());
        data.put("msg_type", msgInfoBean.getType());
        data.put("talker", talker);
        data.put("sender", sender);
        data.put("content", content);
        data.put("timestamp", msgInfoBean.getCreateTime());
        data.put("is_private", msgInfoBean.isPrivateChat());
        data.put("is_group", msgInfoBean.isGroupChat());
        data.put("is_at_me", isMentionedMe);
        List atUsers = msgInfoBean.getAtUserList();
        if (atUsers != null) {
            data.put("at_user_list", atUsers);
        }

        msg.put("data", data);

        // 连接正常时优先直发；失败或未连接时再入队重试
        String contentPreview = content;
        if (contentPreview.length() > 30) {
            contentPreview = contentPreview.substring(0, 30) + "...";
        }
        String description = sender + " -> " + contentPreview;

        String payload = msg.toString();
        if (!sendMessageDirectly(payload, description)) {
            if (enqueueMessage(payload, description)) {
                log("消息入队: " + description);
            }
        }
    } catch (Exception e) {
        log("消息处理失败: " + e.getMessage());
    }
}

void dumpMsgInfoBean(Object msgInfoBean) {
    if (msgInfoBean == null) {
        log("msgInfoBean = null");
        return;
    }
    try {
        log("===== msgInfoBean dump begin =====");
        log("class=" + msgInfoBean.getClass().getName());
        try {
            log("toString=" + String.valueOf(msgInfoBean));
        } catch (Exception ignore) {}

        java.lang.reflect.Method[] methods = msgInfoBean.getClass().getMethods();
        // 按方法名排序，输出稳定
        for (int i = 0; i < methods.length - 1; i++) {
            for (int j = i + 1; j < methods.length; j++) {
                String ni = methods[i].getName();
                String nj = methods[j].getName();
                if (ni != null && nj != null && ni.compareTo(nj) > 0) {
                    java.lang.reflect.Method tmp = methods[i];
                    methods[i] = methods[j];
                    methods[j] = tmp;
                }
            }
        }

        for (int i = 0; i < methods.length; i++) {
            java.lang.reflect.Method m = methods[i];
            if (m == null) continue;
            if (m.getParameterTypes() != null && m.getParameterTypes().length > 0) continue;
            String name = m.getName();
            if (name == null) continue;
            if (!(name.startsWith("get") || name.startsWith("is"))) continue;
            try {
                Object value = m.invoke(msgInfoBean, new Object[0]);
                log("msgInfoBean." + name + "() = " + String.valueOf(value));
            } catch (Exception e) {
                log("msgInfoBean." + name + "() <error> " + e.getMessage());
            }
        }
        log("===== msgInfoBean dump end =====");
    } catch (Exception e) {
        log("dumpMsgInfoBean failed: " + e.getMessage());
    }
}

String buildInboundContent(Object msgInfoBean, boolean isTextMessage) {
    if (isTextMessage) {
        String text = msgInfoBean.getContent();
        return text == null ? "" : text;
    }
    return "";
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

String normalizeNameKey(String raw) {
    if (raw == null) {
        return "";
    }
    return raw.trim().toLowerCase();
}

boolean startsWithIgnoreCase(String raw, String prefix) {
    if (raw == null || prefix == null) {
        return false;
    }
    return raw.regionMatches(true, 0, prefix, 0, prefix.length());
}

String stripPrefixIgnoreCase(String raw, String prefix) {
    if (!startsWithIgnoreCase(raw, prefix)) {
        return raw;
    }
    return raw.substring(prefix.length()).trim();
}

boolean looksLikeGroupTalker(String raw) {
    return raw != null && raw.endsWith("@chatroom");
}

boolean looksLikeWxid(String raw) {
    if (raw == null) {
        return false;
    }
    String value = raw.trim();
    if (value.isEmpty()) {
        return false;
    }
    if (value.startsWith("wxid_")) {
        return true;
    }
    return value.matches("^[A-Za-z][A-Za-z0-9._-]{2,}$");
}

boolean looksLikeExplicitWxid(String raw) {
    if (raw == null) {
        return false;
    }
    String value = raw.trim();
    if (value.isEmpty()) {
        return false;
    }
    return value.startsWith("wxid_");
}

String normalizeTargetText(String raw) {
    if (raw == null) {
        return "";
    }
    String value = raw.trim();
    if (startsWithIgnoreCase(value, "wechat:")) return stripPrefixIgnoreCase(value, "wechat:");
    if (startsWithIgnoreCase(value, "wx:")) return stripPrefixIgnoreCase(value, "wx:");
    if (startsWithIgnoreCase(value, "wap:")) return stripPrefixIgnoreCase(value, "wap:");
    return value;
}

String getFriendWxidByKeyword(String keywordRaw) {
    String keyword = normalizeTargetText(keywordRaw).trim();
    if (keyword.isEmpty()) {
        return null;
    }
    // friend:/remark:/nickname: 语义上优先解析联系人，只有显式 wxid_ 才直接放行
    if (looksLikeExplicitWxid(keyword)) {
        return keyword;
    }

    List friends = null;
    try {
        friends = getFriendList();
    } catch (Exception e) {
        log("获取好友列表失败: " + e.getMessage());
        return null;
    }
    if (friends == null || friends.isEmpty()) {
        return null;
    }

    String exactKey = normalizeNameKey(keyword);
    String fuzzyKey = exactKey;
    List remarkExactMatches = new java.util.ArrayList();
    List nicknameExactMatches = new java.util.ArrayList();
    List idExactMatches = new java.util.ArrayList();
    List remarkFuzzyMatches = new java.util.ArrayList();
    List nicknameFuzzyMatches = new java.util.ArrayList();
    List idFuzzyMatches = new java.util.ArrayList();

    for (int i = 0; i < friends.size(); i++) {
        Object item = friends.get(i);
        if (item == null) {
            continue;
        }
        String wxid = nullSafeInvokeString(item, "getWxid");
        String remark = nullSafeInvokeString(item, "getRemark");
        String nickname = nullSafeInvokeString(item, "getNickname");
        String alias = nullSafeInvokeString(item, "getAlias");

        String wxidKey = normalizeNameKey(wxid);
        String remarkKey = normalizeNameKey(remark);
        String nicknameKey = normalizeNameKey(nickname);
        String aliasKey = normalizeNameKey(alias);

        if (!remarkKey.isEmpty() && remarkKey.equals(exactKey)) {
            remarkExactMatches.add(wxid);
            continue;
        }
        if ((!nicknameKey.isEmpty() && nicknameKey.equals(exactKey)) || (!aliasKey.isEmpty() && aliasKey.equals(exactKey))) {
            nicknameExactMatches.add(wxid);
            continue;
        }
        if (!wxidKey.isEmpty() && wxidKey.equals(exactKey)) {
            idExactMatches.add(wxid);
            continue;
        }

        if (!remarkKey.isEmpty() && remarkKey.indexOf(fuzzyKey) >= 0) {
            remarkFuzzyMatches.add(wxid);
            continue;
        }
        if ((!nicknameKey.isEmpty() && nicknameKey.indexOf(fuzzyKey) >= 0) || (!aliasKey.isEmpty() && aliasKey.indexOf(fuzzyKey) >= 0)) {
            nicknameFuzzyMatches.add(wxid);
            continue;
        }
        if (!wxidKey.isEmpty() && wxidKey.indexOf(fuzzyKey) >= 0) {
            idFuzzyMatches.add(wxid);
        }
    }

    String resolved = pickSingleFriendMatch(remarkExactMatches, "备注精确匹配", keyword);
    if (resolved != null) return resolved;
    resolved = pickSingleFriendMatch(nicknameExactMatches, "昵称精确匹配", keyword);
    if (resolved != null) return resolved;
    resolved = pickSingleFriendMatch(idExactMatches, "ID精确匹配", keyword);
    if (resolved != null) return resolved;
    resolved = pickSingleFriendMatch(remarkFuzzyMatches, "备注模糊匹配", keyword);
    if (resolved != null) return resolved;
    resolved = pickSingleFriendMatch(nicknameFuzzyMatches, "昵称模糊匹配", keyword);
    if (resolved != null) return resolved;
    resolved = pickSingleFriendMatch(idFuzzyMatches, "ID模糊匹配", keyword);
    if (resolved != null) return resolved;
    return null;
}

String pickSingleFriendMatch(List matches, String stage, String keyword) {
    if (matches == null || matches.size() == 0) {
        return null;
    }
    if (matches.size() == 1) {
        return String.valueOf(matches.get(0));
    }
    log("好友目标解析失败：" + stage + "存在多个结果，请改用 wxid。keyword=" + keyword + ", matches=" + matches.size());
    return null;
}

String getGroupTalkerByKeyword(String keywordRaw) {
    String keyword = normalizeTargetText(keywordRaw).trim();
    if (keyword.isEmpty()) {
        return null;
    }
    if (looksLikeGroupTalker(keyword)) {
        return keyword;
    }

    List groups = null;
    try {
        groups = getGroupList();
    } catch (Exception e) {
        log("获取群列表失败: " + e.getMessage());
        return null;
    }
    if (groups == null || groups.isEmpty()) {
        return null;
    }

    String exactKey = normalizeNameKey(keyword);
    List exactMatches = new java.util.ArrayList();
    List fuzzyMatches = new java.util.ArrayList();

    for (int i = 0; i < groups.size(); i++) {
        Object item = groups.get(i);
        if (item == null) {
            continue;
        }
        String roomId = nullSafeInvokeString(item, "getRoomId");
        String groupName = nullSafeInvokeString(item, "getName");
        String roomIdKey = normalizeNameKey(roomId);
        String groupNameKey = normalizeNameKey(groupName);

        if ((!roomIdKey.isEmpty() && roomIdKey.equals(exactKey)) || (!groupNameKey.isEmpty() && groupNameKey.equals(exactKey))) {
            exactMatches.add(roomId);
            continue;
        }
        if (!groupNameKey.isEmpty() && groupNameKey.indexOf(exactKey) >= 0) {
            fuzzyMatches.add(roomId);
        }
    }

    if (exactMatches.size() == 1) {
        return String.valueOf(exactMatches.get(0));
    }
    if (exactMatches.size() > 1) {
        log("群目标解析失败：存在多个精确匹配，请改用 roomId。keyword=" + keyword + ", matches=" + exactMatches.size());
        return null;
    }
    if (fuzzyMatches.size() == 1) {
        return String.valueOf(fuzzyMatches.get(0));
    }
    if (fuzzyMatches.size() > 1) {
        log("群目标解析失败：存在多个模糊匹配，请改用 roomId。keyword=" + keyword + ", matches=" + fuzzyMatches.size());
        return null;
    }
    return null;
}

String nullSafeInvokeString(Object target, String methodName) {
    try {
        if (target == null || methodName == null || methodName.isEmpty()) {
            return "";
        }
        java.lang.reflect.Method m = target.getClass().getMethod(methodName, new Class[0]);
        Object value = m.invoke(target, new Object[0]);
        if (value == null) {
            return "";
        }
        return String.valueOf(value).trim();
    } catch (Exception e) {
        return "";
    }
}

boolean isFriendWxid(String wxid) {
    if (wxid == null || wxid.trim().isEmpty()) {
        return false;
    }
    List friends = null;
    try {
        friends = getFriendList();
    } catch (Exception e) {
        log("获取好友列表失败: " + e.getMessage());
        return false;
    }
    if (friends == null || friends.isEmpty()) {
        return false;
    }

    String target = normalizeNameKey(wxid);
    for (int i = 0; i < friends.size(); i++) {
        Object item = friends.get(i);
        if (item == null) continue;
        String friendWxid = normalizeNameKey(nullSafeInvokeString(item, "getWxid"));
        if (!friendWxid.isEmpty() && friendWxid.equals(target)) {
            return true;
        }
    }
    return false;
}

String resolveOutboundTalker(String rawTalker) {
    String talker = normalizeTargetText(rawTalker).trim();
    if (talker.isEmpty()) {
        return null;
    }

    if (startsWithIgnoreCase(talker, "group:") || startsWithIgnoreCase(talker, "room:") || startsWithIgnoreCase(talker, "chatroom:")) {
        String keyword = talker.substring(talker.indexOf(":") + 1).trim();
        return getGroupTalkerByKeyword(keyword);
    }
    if (startsWithIgnoreCase(talker, "friend:") || startsWithIgnoreCase(talker, "user:") || startsWithIgnoreCase(talker, "contact:") || startsWithIgnoreCase(talker, "remark:") || startsWithIgnoreCase(talker, "nickname:") || startsWithIgnoreCase(talker, "name:")) {
        String keyword = talker.substring(talker.indexOf(":") + 1).trim();
        return getFriendWxidByKeyword(keyword);
    }
    if (startsWithIgnoreCase(talker, "id:") || startsWithIgnoreCase(talker, "wxid:")) {
        return talker.substring(talker.indexOf(":") + 1).trim();
    }

    if (looksLikeGroupTalker(talker)) {
        return talker;
    }

    // 无前缀时先做名称解析，再回退到 raw wxid
    String groupMatch = getGroupTalkerByKeyword(talker);
    String friendMatch = getFriendWxidByKeyword(talker);
    if (groupMatch != null && friendMatch != null) {
        log("目标解析失败：关键字同时命中好友与群，请添加前缀 group:/friend: keyword=" + talker);
        return null;
    }
    if (groupMatch != null) {
        return groupMatch;
    }
    if (friendMatch != null) {
        return friendMatch;
    }
    if (looksLikeWxid(talker)) {
        return talker;
    }
    return null;
}

String resolveGroupMemberWxid(String groupTalker, String memberKeyRaw) {
    String memberKey = normalizeTargetText(memberKeyRaw).trim();
    if (memberKey.isEmpty()) {
        return null;
    }
    if (startsWithIgnoreCase(memberKey, "wxid:") || startsWithIgnoreCase(memberKey, "id:")) {
        memberKey = memberKey.substring(memberKey.indexOf(":") + 1).trim();
    }
    // 群 @ 模板中也仅显式 wxid_ 直接放行，避免昵称误判为 wxid
    if (looksLikeExplicitWxid(memberKey)) {
        return memberKey;
    }

    List members = null;
    try {
        members = getGroupMemberList(groupTalker);
    } catch (Exception e) {
        log("获取群成员失败: " + e.getMessage());
        return null;
    }
    if (members == null || members.isEmpty()) {
        return null;
    }

    String key = normalizeNameKey(memberKey);
    List exactMatches = new java.util.ArrayList();
    List fuzzyMatches = new java.util.ArrayList();
    for (int i = 0; i < members.size(); i++) {
        Object item = members.get(i);
        if (item == null) continue;
        String wxid = String.valueOf(item).trim();
        if (wxid.isEmpty()) continue;
        String wxidKey = normalizeNameKey(wxid);
        String groupName = normalizeNameKey(getFriendName(wxid, groupTalker));
        String globalName = normalizeNameKey(getFriendName(wxid));

        if (wxidKey.equals(key) || (!groupName.isEmpty() && groupName.equals(key)) || (!globalName.isEmpty() && globalName.equals(key))) {
            exactMatches.add(wxid);
            continue;
        }
        if ((!groupName.isEmpty() && groupName.indexOf(key) >= 0) || (!globalName.isEmpty() && globalName.indexOf(key) >= 0)) {
            fuzzyMatches.add(wxid);
        }
    }

    if (exactMatches.size() == 1) return String.valueOf(exactMatches.get(0));
    if (exactMatches.size() > 1) {
        log("群成员解析失败：存在多个精确匹配，请改用 wxid。member=" + memberKey + ", matches=" + exactMatches.size());
        return null;
    }
    if (fuzzyMatches.size() == 1) return String.valueOf(fuzzyMatches.get(0));
    if (fuzzyMatches.size() > 1) {
        log("群成员解析失败：存在多个模糊匹配，请改用 wxid。member=" + memberKey + ", matches=" + fuzzyMatches.size());
        return null;
    }
    return null;
}

String renderGroupMentionTemplates(String groupTalker, String content) {
    if (content == null || content.indexOf("{{at:") < 0) {
        return content;
    }
    String result = content;
    int guard = 0;
    while (guard < 32) {
        guard++;
        int start = result.indexOf("{{at:");
        if (start < 0) break;
        int end = result.indexOf("}}", start);
        if (end < 0) break;
        String token = result.substring(start + 5, end).trim();
        String resolvedWxid = resolveGroupMemberWxid(groupTalker, token);
        String replacement = resolvedWxid != null ? "[AtWx=" + resolvedWxid + "]" : result.substring(start, end + 2);
        result = result.substring(0, start) + replacement + result.substring(end + 2);
    }
    return result;
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

boolean isNoMentionContextGroupEnabled(String talker) {
    String normalizedTalker = normalizeId(talker);
    if (NO_MENTION_CONTEXT_GROUPS.size() == 0) {
        return false;
    }
    return NO_MENTION_CONTEXT_GROUPS.contains("*") || NO_MENTION_CONTEXT_GROUPS.contains(normalizedTalker);
}

boolean checkAndIncreaseSendRateLimit() {
    long now = System.currentTimeMillis();
    if (now - sendRateLimitWindowStart > 60000) {
        sendRateLimitWindowStart = now;
        sendCountInWindow = 0;
    }
    sendCountInWindow++;
    if (sendCountInWindow > SEND_RATE_LIMIT) {
        log("【安全】发送速率超限，本分钟已发送 " + sendCountInWindow + " 条消息");
        return false;
    }
    return true;
}

String resolveAndValidateOutboundTalker(String rawTalker, String commandType) {
    String resolvedTalker = resolveOutboundTalker(rawTalker);
    if (resolvedTalker == null || resolvedTalker.isEmpty()) {
        log(commandType + " 目标解析失败，无法发送: " + rawTalker);
        return null;
    }

    boolean isGroupTalker = resolvedTalker.endsWith("@chatroom");
    if (!isGroupTalker && !isFriendWxid(resolvedTalker)) {
        log("【安全】拒绝发送私聊：目标不是当前账号好友: " + resolvedTalker);
        return null;
    }
    if (!isGroupTalker && ALLOW_FROM.size() > 0 && !ALLOW_FROM.contains(normalizeId(resolvedTalker))) {
        log("【安全】拒绝发送消息到非 allowFrom 用户: " + resolvedTalker);
        return null;
    }
    return resolvedTalker;
}

String validateCanonicalOutboundTalker(String rawTalker, String commandType) {
    String talker = normalizeTargetText(rawTalker).trim();
    if (talker.isEmpty()) {
        log(commandType + " 缺少目标 talker");
        return null;
    }
    // send_* 仅接受解析后的 canonical talker，禁止在发送阶段做昵称/备注匹配
    if (startsWithIgnoreCase(talker, "group:") ||
        startsWithIgnoreCase(talker, "room:") ||
        startsWithIgnoreCase(talker, "chatroom:") ||
        startsWithIgnoreCase(talker, "friend:") ||
        startsWithIgnoreCase(talker, "user:") ||
        startsWithIgnoreCase(talker, "contact:") ||
        startsWithIgnoreCase(talker, "remark:") ||
        startsWithIgnoreCase(talker, "nickname:") ||
        startsWithIgnoreCase(talker, "name:") ||
        startsWithIgnoreCase(talker, "id:") ||
        startsWithIgnoreCase(talker, "wxid:")) {
        log(commandType + " 仅接受 canonical talker（wxid 或 @chatroom），当前为待解析目标: " + rawTalker);
        return null;
    }

    boolean isGroupTalker = looksLikeGroupTalker(talker);
    if (!isGroupTalker && !isFriendWxid(talker)) {
        log("【安全】拒绝发送私聊：目标不是当前账号好友或非 canonical wxid: " + talker);
        return null;
    }
    if (!isGroupTalker && ALLOW_FROM.size() > 0 && !ALLOW_FROM.contains(normalizeId(talker))) {
        log("【安全】拒绝发送消息到非 allowFrom 用户: " + talker);
        return null;
    }
    return talker;
}

boolean isHttpUrl(String rawUrl) {
    if (rawUrl == null) {
        return false;
    }
    String url = rawUrl.trim().toLowerCase();
    return url.startsWith("http://") || url.startsWith("https://");
}

String extractFileNameFromUrl(String rawUrl) {
    if (rawUrl == null) {
        return "wap_media.bin";
    }
    String url = rawUrl.trim();
    int hashIdx = url.indexOf('#');
    if (hashIdx >= 0) {
        url = url.substring(0, hashIdx);
    }
    int queryIdx = url.indexOf('?');
    if (queryIdx >= 0) {
        url = url.substring(0, queryIdx);
    }
    int slashIdx = url.lastIndexOf('/');
    String name = slashIdx >= 0 ? url.substring(slashIdx + 1) : url;
    if (name == null || name.trim().isEmpty()) {
        return "wap_media.bin";
    }
    return name.trim();
}

String sanitizeFileName(String rawName, String fallback) {
    String name = rawName;
    if (name == null || name.trim().isEmpty()) {
        name = fallback;
    }
    if (name == null || name.trim().isEmpty()) {
        name = "wap_media.bin";
    }
    name = name.trim().replace("\\", "_").replace("/", "_");
    name = name.replace(":", "_").replace("*", "_").replace("?", "_");
    name = name.replace("\"", "_").replace("<", "_").replace(">", "_").replace("|", "_");
    if (name.length() > 96) {
        name = name.substring(name.length() - 96);
    }
    return name;
}

String resolveServerHttpOrigin() {
    try {
        URL wsUrl = new URL(SERVER_URL);
        String protocol = wsUrl.getProtocol();
        String httpProtocol = "wss".equalsIgnoreCase(protocol) ? "https" : "http";
        String host = wsUrl.getHost();
        int port = wsUrl.getPort();
        if (host == null || host.trim().isEmpty()) {
            return null;
        }
        StringBuilder origin = new StringBuilder();
        origin.append(httpProtocol).append("://").append(host.trim());
        if (port > 0) {
            origin.append(":").append(port);
        }
        return origin.toString();
    } catch (Exception e) {
        log("解析 server_url 失败: " + e.getMessage());
        return null;
    }
}

String resolveServerPathPrefix() {
    try {
        URL wsUrl = new URL(SERVER_URL);
        String rawPath = wsUrl.getPath();
        if (rawPath == null || rawPath.trim().isEmpty() || "/".equals(rawPath.trim())) {
            return "";
        }
        String pathValue = rawPath.trim();
        if (pathValue.endsWith("/ws")) {
            pathValue = pathValue.substring(0, pathValue.length() - 3);
        }
        if (!pathValue.startsWith("/")) {
            pathValue = "/" + pathValue;
        }
        while (pathValue.endsWith("/") && pathValue.length() > 1) {
            pathValue = pathValue.substring(0, pathValue.length() - 1);
        }
        if ("/".equals(pathValue)) {
            return "";
        }
        return pathValue;
    } catch (Exception e) {
        log("解析 server_url 路径失败: " + e.getMessage());
        return "";
    }
}

String buildTempFileUrl(String fileId, String accountId) {
    if (fileId == null || fileId.trim().isEmpty()) {
        return null;
    }
    String origin = resolveServerHttpOrigin();
    if (origin == null || origin.trim().isEmpty()) {
        return null;
    }
    try {
        String pathPrefix = resolveServerPathPrefix();
        String encodedId = URLEncoder.encode(fileId.trim(), StandardCharsets.UTF_8.name());
        String safeAccountId = (accountId == null || accountId.trim().isEmpty()) ? "default" : accountId.trim();
        String encodedAccountId = URLEncoder.encode(safeAccountId, StandardCharsets.UTF_8.name());
        return origin + pathPrefix + "/wap/files/" + encodedId + "?accountId=" + encodedAccountId;
    } catch (Exception e) {
        log("构建临时文件 URL 失败: " + e.getMessage());
        return null;
    }
}

File downloadRemoteFile(String url, String desiredName) {
    InputStream in = null;
    FileOutputStream out = null;
    try {
        File pendingDir = getPendingFilesDir();
        if (pendingDir == null) {
            return null;
        }
        String safeName = sanitizeFileName(desiredName, extractFileNameFromUrl(url));
        String localName = System.currentTimeMillis() + "_" + safeName;
        File outFile = new File(pendingDir, localName);

        URL remote = new URL(url);
        URLConnection conn = remote.openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(60000);
        conn.setRequestProperty("User-Agent", "openclaw-wap/1.0");
        if (AUTH_TOKEN != null && !AUTH_TOKEN.trim().isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + AUTH_TOKEN.trim());
        }
        conn.connect();

        in = conn.getInputStream();
        out = new FileOutputStream(outFile);
        byte[] buf = new byte[8192];
        int readLen;
        while ((readLen = in.read(buf)) != -1) {
            out.write(buf, 0, readLen);
        }
        out.flush();
        return outFile;
    } catch (Exception e) {
        log("下载媒体失败: " + e.getMessage());
        return null;
    } finally {
        try { if (in != null) in.close(); } catch (Exception ignore) {}
        try { if (out != null) out.close(); } catch (Exception ignore) {}
    }
}

File getPendingFilesDir() {
    try {
        File filesDir = new File(pluginDir, "files");
        if (!filesDir.exists()) {
            if (!filesDir.mkdirs()) {
                log("创建 files 缓存目录失败: " + filesDir.getAbsolutePath());
                return null;
            }
        }
        if (!filesDir.isDirectory()) {
            log("files 路径不是目录: " + filesDir.getAbsolutePath());
            return null;
        }
        return filesDir;
    } catch (Exception e) {
        log("初始化 files 缓存目录失败: " + e.getMessage());
        return null;
    }
}

// ============================================================
// 处理服务器指令
// ============================================================

void sendResolveTargetResult(String requestId, String target, String resolvedTalker, String targetKind, String errorMessage) {
    try {
        if (webSocket == null || !isConnected) {
            return;
        }
        JSONObject payload = new JSONObject();
        payload.put("type", "resolve_target_result");

        JSONObject data = new JSONObject();
        data.put("request_id", requestId == null ? "" : requestId);
        data.put("target", target == null ? "" : target);

        boolean ok = resolvedTalker != null && !resolvedTalker.trim().isEmpty() && (errorMessage == null || errorMessage.trim().isEmpty());
        data.put("ok", ok);
        data.put("target_kind", targetKind == null || targetKind.trim().isEmpty() ? "unknown" : targetKind);
        if (ok) {
            data.put("resolved_talker", resolvedTalker);
            log("resolve_target_result 回传: request_id=" + requestId + ", target=" + target + ", resolved_talker=" + resolvedTalker + ", kind=" + targetKind + ", ok=true");
        } else {
            data.put("error", errorMessage == null || errorMessage.trim().isEmpty() ? "target resolve failed" : errorMessage);
            log("resolve_target_result 回传: request_id=" + requestId + ", target=" + target + ", kind=" + targetKind + ", ok=false, error=" + data.getString("error"));
        }
        payload.put("data", data);
        webSocket.send(payload.toString());
    } catch (Exception e) {
        log("resolve_target_result 回传失败: " + e.getMessage());
    }
}

void handleServerMessage(String text) {
    try {
        JSONObject msg = JSON.parseObject(text);
        String type = msg.getString("type");
        if ("resolve_target".equals(type) || "send_text".equals(type) || "send_image".equals(type) || "send_file".equals(type)) {
            log("收到服务端指令 type=" + type);
        }

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

                JSONArray noMentionContextGroups = data.getJSONArray("no_mention_context_groups");
                NO_MENTION_CONTEXT_GROUPS.clear();
                if (noMentionContextGroups != null) {
                    for (int i = 0; i < noMentionContextGroups.size(); i++) {
                        String talker = noMentionContextGroups.getString(i);
                        String normalized = normalizeId(talker);
                        if (!normalized.isEmpty()) {
                            NO_MENTION_CONTEXT_GROUPS.add(normalized);
                        }
                    }
                }

                Boolean requireMention = data.getBoolean("require_mention_in_group");
                if (requireMention != null) {
                    requireMentionInGroup = requireMention.booleanValue();
                }

                log("收到服务端配置，group_policy=" + groupPolicy + ", group_allow_chats: " + GROUP_ALLOW_CHATS + ", no_mention_context_groups: " + NO_MENTION_CONTEXT_GROUPS + ", allow_from: " + ALLOW_FROM + ", group_allow_from: " + GROUP_ALLOW_FROM + ", require_mention_in_group=" + requireMentionInGroup);
            }
            return;
        }

        // 仅解析目标，不发送消息（供服务端在发送前构造稳定 session）
        if ("resolve_target".equals(type)) {
            JSONObject data = msg.getJSONObject("data");
            if (data == null) {
                log("resolve_target 指令缺少 data");
                return;
            }
            String requestId = data.getString("request_id");
            String target = data.getString("target");
            log("resolve_target 开始 request_id=" + requestId + ", target=" + target);
            if (requestId == null || requestId.trim().isEmpty()) {
                log("resolve_target 指令缺少 request_id");
                return;
            }
            if (target == null || target.trim().isEmpty()) {
                sendResolveTargetResult(requestId, target, null, "unknown", "target is required");
                return;
            }
            String resolvedTalker = resolveAndValidateOutboundTalker(target, "resolve_target");
            if (resolvedTalker == null) {
                sendResolveTargetResult(requestId, target, null, "unknown", "target resolve failed");
                return;
            }
            String targetKind = resolvedTalker.endsWith("@chatroom") ? "group" : "direct";
            sendResolveTargetResult(requestId, target, resolvedTalker, targetKind, null);
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

            String canonicalTalker = validateCanonicalOutboundTalker(talker, "send_text");
            if (canonicalTalker == null) {
                return;
            }
            if (!checkAndIncreaseSendRateLimit()) {
                return;
            }

            boolean isGroupTalker = canonicalTalker.endsWith("@chatroom");
            String outboundContent = isGroupTalker
                ? renderGroupMentionTemplates(canonicalTalker, content)
                : content;
            sendText(canonicalTalker, outboundContent);
            String preview = outboundContent;
            if (preview.length() > 30) {
                preview = preview.substring(0, 30) + "...";
            }
            log("已发送消息到 " + canonicalTalker + ": " + preview);
            return;
        }

        if ("send_image".equals(type)) {
            JSONObject data = msg.getJSONObject("data");
            if (data == null) {
                log("send_image 指令缺少 data");
                return;
            }
            String talker = data.getString("talker");
            String imageUrl = data.getString("image_url");
            String imageId = data.getString("image_id");
            String accountId = data.getString("account_id");
            String caption = data.getString("caption");
            if ((imageUrl == null || imageUrl.trim().isEmpty()) && imageId != null && !imageId.trim().isEmpty()) {
                imageUrl = buildTempFileUrl(imageId, accountId);
            }
            if (talker == null || imageUrl == null || imageUrl.trim().isEmpty()) {
                log("send_image 指令缺少必要参数");
                return;
            }
            if (!isHttpUrl(imageUrl)) {
                log("send_image 仅支持 http(s) URL: " + imageUrl);
                return;
            }
            String canonicalTalker = validateCanonicalOutboundTalker(talker, "send_image");
            if (canonicalTalker == null) {
                return;
            }
            if (!checkAndIncreaseSendRateLimit()) {
                return;
            }
            File imageFile = downloadRemoteFile(imageUrl, "wap_image.jpg");
            if (imageFile == null || !imageFile.exists()) {
                log("send_image 下载失败: " + imageUrl);
                return;
            }
            sendImage(canonicalTalker, imageFile.getAbsolutePath());
            if (caption != null && !caption.trim().isEmpty()) {
                String outboundCaption = canonicalTalker.endsWith("@chatroom")
                    ? renderGroupMentionTemplates(canonicalTalker, caption)
                    : caption;
                sendText(canonicalTalker, outboundCaption);
            }
            log("已发送图片到 " + canonicalTalker + ": " + imageFile.getName());
            return;
        }

        if ("send_file".equals(type)) {
            JSONObject data = msg.getJSONObject("data");
            if (data == null) {
                log("send_file 指令缺少 data");
                return;
            }
            String talker = data.getString("talker");
            String fileUrl = data.getString("file_url");
            String fileId = data.getString("file_id");
            String accountId = data.getString("account_id");
            String fileName = data.getString("file_name");
            String caption = data.getString("caption");
            if ((fileUrl == null || fileUrl.trim().isEmpty()) && fileId != null && !fileId.trim().isEmpty()) {
                fileUrl = buildTempFileUrl(fileId, accountId);
            }
            if (talker == null || fileUrl == null || fileUrl.trim().isEmpty()) {
                log("send_file 指令缺少必要参数");
                return;
            }
            if (!isHttpUrl(fileUrl)) {
                log("send_file 仅支持 http(s) URL: " + fileUrl);
                return;
            }
            String canonicalTalker = validateCanonicalOutboundTalker(talker, "send_file");
            if (canonicalTalker == null) {
                return;
            }
            if (!checkAndIncreaseSendRateLimit()) {
                return;
            }
            String title = sanitizeFileName(fileName, extractFileNameFromUrl(fileUrl));
            File localFile = downloadRemoteFile(fileUrl, title);
            if (localFile == null || !localFile.exists()) {
                log("send_file 下载/落地失败: " + fileUrl);
                return;
            }
            shareFile(canonicalTalker, title, localFile.getAbsolutePath(), "");
            if (caption != null && !caption.trim().isEmpty()) {
                String outboundCaption = canonicalTalker.endsWith("@chatroom")
                    ? renderGroupMentionTemplates(canonicalTalker, caption)
                    : caption;
                sendText(canonicalTalker, outboundCaption);
            }
            log("已发送文件到 " + canonicalTalker + ": " + localFile.getName());
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
