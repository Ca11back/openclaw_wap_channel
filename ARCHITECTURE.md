# 架构说明

## 📐 系统架构

```
┌─────────────────┐          WebSocket           ┌──────────────────┐
│  微信 (WeChat)  │ ◄────────────────────────► │  OpenClaw 服务器  │
│                 │                              │                  │
│  ┌───────────┐  │   1. 入站消息 (message)      │  ┌────────────┐  │
│  │ WAuxiliary│  │   ──────────────────────►   │  │  Channel   │  │
│  │  Plugin   │  │                              │  │  (本插件)  │  │
│  └───────────┘  │   2. 回复命令 (send_*)       │  └────────────┘  │
│                 │   ◄──────────────────────    │         │        │
│                 │   3. 能力上报 (capabilities) │         ▼        │
│                 │   ──────────────────────►    │  ┌────────────┐  │
│                 │   4. 主动查询 (rpc_*)        │  │  核心 AI   │  │
│                 │   ◄──────────────────────►   │  │ + WeChat工具│  │
└─────────────────┘                              │  └────────────┘  │
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
2. Channel 通过 WebSocket 发送 `resolve_target` 预解析目标
3. WAuxiliary 返回 `resolve_target_result`（最终 wxid / 群 talker）
4. Channel 使用解析后的目标发送 `send_text` / `send_image` / `send_file`
5. WAuxiliary 插件接收指令并调用微信 API 发送消息

### 主动工具调用
1. OpenClaw Agent/skill 调用 `wechat_*` 工具
2. Host 侧插件通过 `rpc_request` 查询好友、群聊或目标解析
3. WAuxiliary 返回 `rpc_result`
4. Host 侧根据返回结果选择继续发送 `send_text` 或返回结构化结果给工具调用方

## 🤝 能力握手

客户端连接并收到 `config` 后，会主动发送 `capabilities`：

- `protocol_version`
- `client_name`
- `client_version`
- `rpc_methods`
- `command_types`
- `features`

Host 侧会缓存这些能力，用于：

- 工具/命令诊断输出
- 后续能力判定
- 为未来的能力协商和渐进扩展打基础

## 🔒 安全机制

| 层级 | 措施 | 位置 |
|------|------|------|
| **连接认证** | Bearer Token | 插件 + 服务器 |
| **入站控制** | allowFrom / groupAllowFrom（服务端下发） | 插件 |
| **出站控制** | 私聊 allowFrom 验证 | 插件 |
| **群聊门禁** | groupPolicy/groupAllowChats/groupAllowFrom/requireMentionInGroup | 插件 + 服务端 |
| **DM 策略** | pairing / allowlist / open / disabled | 服务端 |
| **静默配对** | 未授权只登记 pairing 请求，不自动回消息 | 服务端 |
| **速率限制** | 30条/分钟 | 插件 |
| **消息重试** | 最多3次，30秒TTL | 插件 |
| **日志脱敏** | URL/Token 掩码 | 插件 |

## 📦 目录结构

```
openclaw-channel-wap/
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
    │   ├── commands.ts          # /wap 与 CLI 诊断命令
    │   ├── operations.ts        # 主动工具与目录复用的高层操作
    │   ├── tools.ts             # wechat_* 工具注册
    │   ├── ws-server.ts         # WebSocket 服务器与 RPC/能力缓存
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

当前版本：**v4.0.0**

协议兼容性：当前按 v4 处理，不要求兼容旧版 `wap_plugin`。

补充说明：上行 `message` 在基础字段之外，支持附带以下可选元数据字段，均由 WAuxiliary 插件端本地查询后自动补充：

- `sender_display_name`：发送者展示名（优先好友备注 / 昵称）
- `sender_group_display_name`：发送者在当前群内的显示名 / 群名片
- `group_name`：群名称
- `group_member_count`：群成员数量

以上字段均为向后兼容的可选扩展；旧版插件可以不发送，服务端会自动回退到 `sender` / `talker`。

新增协议族：

- `capabilities`
- `rpc_request`
- `rpc_result`

当前主动 RPC 方法：

- `get_friends`
- `get_groups`
- `search_target`
