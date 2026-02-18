# OpenClaw WAP Channel

OpenClaw AI 助手的微信消息通道插件，接收来自 WAuxiliary 插件的消息并调用 AI 处理。

> ⚠️ **重要提示**  
> 本插件需要配合 **WAuxiliary 微信插件**一起使用才能工作。  
> 📦 **完整使用说明**请查看：[https://github.com/Ca11back/openclaw-channel-wap](https://github.com/Ca11back/openclaw-channel-wap)

---

## 📦 安装

```bash
openclaw plugins install openclaw-channel-wap
```

## ⚙️ 配置

编辑 OpenClaw 配置文件 `~/.openclaw/openclaw.json`，添加 WAP channel 配置：

```json
{
  "channels": {
    "openclaw-channel-wap": {
      "enabled": true,
      "port": 8765,
      "authToken": "your-secret-token-here",
      "whitelist": [
        "wxid_example1",
        "wxid_example2"
      ]
    }
  }
}
```

### 配置说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | boolean | 是 | 是否启用此 channel |
| `port` | number | 是 | WebSocket 服务器端口 |
| `authToken` | string | 是 | 认证 Token（需与 WAP 插件配置一致） |
| `whitelist` | string[] | 否 | 白名单用户列表（为空则不限制） |

## 🚀 使用

安装并配置后，插件会：

1. 启动 WebSocket 服务器监听指定端口
2. 验证来自 WAP 插件的连接 Token
3. 接收微信消息并转发给 OpenClaw AI
4. 将 AI 回复通过 WebSocket 发送回插件

## 📡 协议

### 接收消息（from WAP plugin）

```json
{
  "type": "message",
  "data": {
    "msg_id": 12345678,
    "talker": "wxid_xxx",
    "content": "用户消息",
    "timestamp": 1706600000000,
    "is_private": true
  }
}
```

### 发送回复（to WAP plugin）

```json
{
  "type": "send_text",
  "data": {
    "talker": "wxid_xxx",
    "content": "AI 回复内容"
  }
}
```

## 🔧 开发与测试

```bash
# 安装依赖
npm install

# 运行测试服务器
npm run test:server

# 运行模拟客户端
npm run test:client
```

## 📝 许可

MIT License
