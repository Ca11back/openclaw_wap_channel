# 架构说明

## 系统结构

```text
┌─────────────────┐          WebSocket           ┌──────────────────┐
│  微信 (WeChat)  │ ◄────────────────────────► │  OpenClaw Host    │
│                 │                              │                  │
│  ┌───────────┐  │   1. 入站消息 (message)      │  ┌────────────┐  │
│  │ WAuxiliary│  │   ──────────────────────►   │  │  WAP       │  │
│  │  Plugin   │  │                              │  │  Channel   │  │
│  └───────────┘  │   2. 主动查询 (rpc_*)        │  └────────────┘  │
│                 │   ◄──────────────────────►   │         │        │
│                 │   3. 发送命令 (send_*)       │         ▼        │
│                 │   ◄──────────────────────    │  ┌────────────┐  │
│                 │   4. 发送回执 (command_result)│ │ OpenClaw AI │  │
│                 │   ──────────────────────►    │  │ + actions  │  │
└─────────────────┘                              │  └────────────┘  │
                                                 └──────────────────┘
```

## 设计原则

WAP 主动能力拆成两层：

1. discovery

- Android 侧枚举好友、群聊、候选目标
- Host 侧只做转发和结构化
- discovery 不隐藏不可发送候选

2. send

- Host / agent 只接受 typed canonical target
- Android 下行只接受最终 canonical talker
- 发送阶段不做模糊匹配
- 发送结果必须回传结构化错误

这与 Lark 的方向一致：

- 发现层单独返回候选标识
- 发送层单独消费稳定标识
- 不把“查找、权限、发送”混成一个接口

## Canonical Target

上层统一使用：

- `user:<wxid>`
- `group:<talker@chatroom>`

Android 下行 `send_*` 命令中只使用最终 talker：

- direct: `wxid`
- group: `*@chatroom`

## 核心流程

### 1. 入站消息

1. 用户在微信发送消息
2. WAuxiliary 插件拦截消息并做本地预过滤
3. Android 插件通过 WebSocket 上报 `message`
4. Host channel 组装上下文并调用 OpenClaw reply pipeline

### 2. Discovery

1. agent 或 skill 调用 `wechat_lookup_targets`
2. Host channel 发送 `rpc_request(method=lookup_targets)`
3. Android 插件执行好友 / 群匹配
4. Android 返回 `rpc_result`
5. Host 将候选返回给 agent

### 3. Send

1. agent 使用 message `send` action，目标必须是 typed canonical target
2. Host 在发送前用 `lookup_targets` 做 canonical preflight
3. Host 将 typed canonical target 解包成最终 talker，发送 `send_text` / `send_image` / `send_file`
4. Android 校验 canonical talker、权限、速率限制并实际发送
5. Android 返回 `command_result`

## 协议面

### 上行类型

- `message`
- `capabilities`
- `rpc_result`
- `command_result`

### 下行类型

- `config`
- `ping`
- `rpc_request`
- `send_text`
- `send_image`
- `send_file`

### 能力协商

`capabilities.data` 当前包含：

- `protocol_version`
- `client_name`
- `client_version`
- `rpc_methods`
- `command_types`
- `features`

当前快照：

- `protocol_version = wap-vnext-2026-03-24`
- `client_version = 5.0.0`
- `rpc_methods = ["get_friends", "get_groups", "lookup_targets"]`
- `command_types = ["send_text", "send_image", "send_file"]`

## Discovery 输出模型

`lookup_targets` 返回：

- `query`
- `kind`
- `count`
- `candidates`

每个 candidate 至少包含：

- `canonical_target`
- `talker`
- `target_kind`
- `display_name`
- `matched_by`
- `score`
- `send_status`
- `send_status_reason`

direct candidate 可额外带：

- `remark`
- `nickname`
- `alias`

group candidate 可额外带：

- `group_name`

## 发送失败分类

Android 侧 `command_result` 当前显式回传：

- `invalid_canonical_target`
- `not_friend`
- `blocked_by_allow_from`
- `invalid_group`
- `rate_limited`
- `send_failed`

Host 侧在 preflight 或传输层还会补充：

- `target_not_found`
- `no_connected_client`

## 安全边界

### Android 本地

- `allowFrom` 控制私聊主动发送目标
- `groupPolicy` / `groupAllowChats` / `groups.<talker>.*` 控制入站群聊过滤
- 发送速率限制默认 30 条 / 分钟
- `send_*` 仅接受 canonical talker

### Host 侧

- 配置账户隔离
- message `send` 仅接受 typed canonical target
- 发送前强制 canonical preflight
- discovery tools 与 message action 分离

## 群级覆盖

当前保留以下群级覆盖：

- `groups."*"` 默认配置
- `groups."<talker>"` 精确覆盖
- `enabled`
- `groupPolicy`
- `allowFrom`
- `requireMention`
- `tools`
- `skills`
- `systemPrompt`

边界：

- `enabled` / `groupPolicy` / `allowFrom` / `requireMention` 下发到 Android 端
- `tools` / `skills` / `systemPrompt` 只在 Host 侧生效

## 当前标准对齐

WAP 当前实现按最新 OpenClaw 标准对齐：

- discovery 使用普通 tool
- 主动发送使用 message `send` action
- 不再保留旧 `wechat_send_*` 风格主动发送工具
- 不再保留 `resolve_target` 风格发送前预解析协议

## 版本

- WAP version: `5.0.0`
- Protocol snapshot: `wap-vnext-2026-03-24`
- 要求 Host 与 `wap_plugin` 同步升级
