# 架构说明

## 📐 系统架构

```
┌─────────────────┐          WebSocket           ┌──────────────────┐
│  微信 (WeChat)  │ ◄────────────────────────► │  OpenClaw 服务器  │
│                 │                              │                  │
│  ┌───────────┐  │   1. 消息转发 (message)      │  ┌────────────┐  │
│  │ WAuxiliary│  │   ──────────────────────►   │  │  Channel   │  │
│  │  Plugin   │  │                              │  │  (本插件)  │  │
│  └───────────┘  │   2. AI回复 (send_text)      │  └────────────┘  │
│                 │   ◄──────────────────────   │         │        │
└─────────────────┘                              │         ▼        │
                                                 │  ┌────────────┐  │
                                                 │  │  核心 AI   │  │
                                                 │  └────────────┘  │
                                                 └──────────────────┘
```

## 🔄 消息流程

### 接收用户消息
1. 用户在微信发送消息
2. WAuxiliary 插件拦截消息
3. 插件检查白名单，通过 WebSocket 转发到服务器
4. OpenClaw Channel 接收并解析消息
5. 转发给 OpenClaw AI 核心处理

### 发送 AI 回复
1. OpenClaw AI 生成回复
2. Channel 通过 WebSocket 发送 `send_text` 指令
3. WAuxiliary 插件接收指令
4. 插件验证白名单和速率限制
5. 调用微信 API 发送消息

## 🔒 安全机制

| 层级 | 措施 | 位置 |
|------|------|------|
| **连接认证** | Bearer Token | 插件 + 服务器 |
| **入站控制** | 白名单（服务端下发） | 插件 |
| **出站控制** | 白名单验证 | 插件 |
| **速率限制** | 30条/分钟 | 插件 |
| **消息重试** | 最多3次，30秒TTL | 插件 |
| **日志脱敏** | URL/Token 掩码 | 插件 |

## 📦 目录结构

```
openclaw_wap_channel/
├── README.md                    # 总体说明
├── LICENSE                      # MIT 许可证
├── .gitignore                   # Git 忽略配置
│
├── wap_plugin/                  # WAuxiliary 插件（Android）
│   ├── README.md                # 插件安装和配置说明
│   ├── main.java                # 插件主代码
│   └── info.prop                # 插件元数据
│
└── openclaw_plugin/             # OpenClaw Channel（npm包）
    ├── README.md                # Channel 使用说明
    ├── package.json             # npm 包配置
    ├── openclaw.plugin.json     # OpenClaw 插件元数据
    ├── index.ts                 # 入口文件
    ├── src/                     # 源代码
    │   ├── channel.ts           # Channel 实现
    │   ├── ws-server.ts         # WebSocket 服务器
    │   └── protocol.ts          # 通信协议定义
    └── test/                    # 测试工具
        ├── standalone-server.ts # 独立服务器测试
        └── mock-client.ts       # 模拟客户端测试
```

## 🚀 部署建议

### 开发环境
- 插件：直接修改 `main.java` 配置后加载到 WAuxiliary
- Channel：使用 `npm run test:server` 单独测试

### 生产环境
- 使用 **WSS**（加密 WebSocket）而非 WS
- 配置强 Token（32+ 字符随机字符串）
- 严格配置白名单（双向）
- 使用反向代理（如 Nginx）处理 SSL
- 定期检查日志中的安全拦截记录

## 📝 协议版本

当前版本：**v1.0.0**

协议兼容性：插件版本和 Channel 版本需保持一致。
