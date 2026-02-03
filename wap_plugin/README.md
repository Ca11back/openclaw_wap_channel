# WAuxiliary 微信消息桥接插件

将指定微信消息通过 WebSocket 转发到服务器，配合 OpenClaw 实现 AI 自动回复。

## ⚙️ 安装步骤

1. 修改 `main.java` 中的配置（见下方）
2. 将整个 `wap_plugin` 目录复制到 WAuxiliary 插件目录
3. 在 WAuxiliary 中启用插件

## 🔧 配置说明

在 `main.java` 顶部修改以下常量：

```java
// WebSocket 服务器地址
String SERVER_URL = "wss://your-server.com:8765";

// 认证 Token（需与服务端一致）
String AUTH_TOKEN = "your-secret-token";

// 白名单配置 - 由服务端动态下发，无需本地配置
// 插件连接成功后，服务器会自动发送白名单配置

// 是否只转发私聊消息
boolean PRIVATE_ONLY = false;

// 速率限制（每分钟最多发送消息数）
int SEND_RATE_LIMIT = 30;
```

## 🔒 安全建议

- ✅ 使用强 Token（建议 32 字符以上随机字符串）
- ✅ 在服务端配置白名单（支持热更新，无需重启插件）
- ✅ 使用 WSS（加密连接）而非 WS
- ✅ 定期检查日志，关注 `【安全】` 标记的拦截记录

**注意**：白名单由服务端统一管理和下发，插件会在连接成功后自动接收最新配置。

## 📡 通信协议

### 上行（插件 → 服务器）

```json
{
  "type": "message",
  "data": {
    "msg_id": 12345678,
    "talker": "wxid_xxx",
    "sender": "wxid_xxx",
    "content": "消息内容",
    "timestamp": 1706600000000,
    "is_private": true
  }
}
```

### 下行（服务器 → 插件）

```json
{
  "type": "send_text",
  "data": {
    "talker": "wxid_xxx",
    "content": "回复内容"
  }
}
```

## 🐛 排查问题

- 查看 WAuxiliary 日志页面
- 检查 WebSocket 连接状态
- 确认 Token 是否匹配
- 验证白名单配置是否正确
