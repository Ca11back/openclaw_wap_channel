# OpenClaw WAP Channel

通过 WAuxiliary 将微信消息桥接到 OpenClaw AI 助手的完整方案（当前：`openclaw_plugin 3.0.7`、`wap_plugin 3.0.3`，当前仅支持文本消息）。

## 📦 组件说明

本仓库包含两个配套组件：

| 组件 | 类型 | 安装方式 | 说明 |
|------|------|----------|------|
| **`openclaw_plugin/`** | OpenClaw Channel（服务端） | `openclaw plugins install` | 接收消息、执行策略、调用 OpenClaw AI |
| **`wap_plugin/`** | WAuxiliary 插件（客户端） | 手动安装 | 接收服务端策略并在本地过滤/发送微信消息 |

## 🚀 快速开始

### 1️⃣ 安装服务端（OpenClaw Channel）

```bash
openclaw plugins install openclaw-channel-wap
```

配置服务端（编辑 `~/.openclaw/openclaw.json`）：

```json
{
  "channels": {
    "openclaw-channel-wap": {
      "enabled": true,
      "port": 8765,
      "authToken": "your-secret-token-32chars",
      "allowFrom": ["wxid_owner"],
      "groupPolicy": "open",
      "groupAllowChats": ["*"],
      "groupAllowFrom": ["wxid_owner"],
      "dmPolicy": "pairing",
      "requireMentionInGroup": true,
      "silentPairing": true
    }
  }
}
```

### 2️⃣ 安装客户端（WAuxiliary 插件）

1. 修改 `wap_plugin/config.yml`：
   - `server_url`（服务器地址）
   - `auth_token`（与服务端保持一致）
2. 将 `wap_plugin` 目录复制到 WAuxiliary 插件目录
3. 在 WAuxiliary 中启用插件

## 📚 文档入口（建议按此顺序）

1. 本文（主 README）：安装顺序、整体约束、版本配套关系
2. [`openclaw_plugin/README.md`](./openclaw_plugin/README.md)：服务端配置、策略字段
3. [`wap_plugin/README.md`](./wap_plugin/README.md)：客户端本地配置、目标解析与发送细节
4. [`ARCHITECTURE.md`](./ARCHITECTURE.md)：架构与协议说明

## 📡 通信协议

两个组件通过 WebSocket 通信，协议详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 🔒 安全特性

- Token 认证
- 多账号配置
- DM 策略（pairing / allowlist / open / disabled）
- 群策略（groupPolicy / groupAllowChats / groupAllowFrom / requireMentionInGroup）
- 静默 pairing（未授权用户不自动回复）
- 速率限制
- 断线重连

## 📄 许可

MIT License
