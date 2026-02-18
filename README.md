# OpenClaw WAP Channel

通过 WAuxiliary 将微信消息桥接到 OpenClaw AI 助手的~~完整~~解决方案(目前仅支持文字消息)。

## 📦 组件说明

本仓库包含两个配套组件：

| 组件 | 类型 | 安装方式 | 说明 |
|------|------|----------|------|
| **`wap_plugin/`** | WAuxiliary 插件 | 手动下载安装 | 拦截微信消息并转发到服务器 |
| **`openclaw_plugin/`** | OpenClaw Channel | `openclaw plugins install` | 接收消息并调用 OpenClaw AI |

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
      "whitelist": ["wxid_user1", "wxid_user2"]
    }
  }
}
```

### 2️⃣ 安装客户端（WAuxiliary 插件）

1. 修改 `wap_plugin/main.java` 中的配置：
   - 设置 `SERVER_URL`（服务器地址）
   - 设置 `AUTH_TOKEN`（与服务端保持一致）
2. 将 `wap_plugin` 目录复制到 WAuxiliary 插件目录
3. 在 WAuxiliary 中启用插件

**详细配置说明**：
- 服务端：查看 [`openclaw_plugin/README.md`](./openclaw_plugin/README.md)
- 客户端：查看 [`wap_plugin/README.md`](./wap_plugin/README.md)
- 架构说明：查看 [`ARCHITECTURE.md`](./ARCHITECTURE.md)

## 📡 通信协议

两个组件通过 WebSocket 通信，协议详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 🔒 安全特性

- Token 认证
- 双向白名单（入站/出站）
- 速率限制
- 断线重连

## 📄 许可

MIT License
