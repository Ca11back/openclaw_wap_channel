# OpenClaw WAP Channel

通过 WAuxiliary 将微信消息接入 OpenClaw，并按当前 OpenClaw 标准提供消息搜索与主动发送能力。

## v5 设计

- 当前版本为 **v5.0.0**
- 协议快照为 `wap-vnext-2026-03-24`
- 不兼容旧版 `wap_plugin`
- 不再保留旧接口：
  - `search_target`
  - `resolve_target`
  - `resolve_target_result`
  - `wechat_search_target`
  - `wechat_send_text`
  - `wechat_send_image`
  - `wechat_send_file`
- 主动查询与主动发送按两层拆分：
  - discovery: `wechat_lookup_targets`
  - send: OpenClaw 标准 message `send` action

## 组件

| 组件 | 类型 | 说明 |
|---|---|---|
| `openclaw_plugin/` | OpenClaw channel plugin | 接收入站消息、注册 discovery 工具、暴露 `search`/`send` action、转发主动发送 |
| `wap_plugin/` | WAuxiliary Android 插件 | 上报消息、枚举好友/群、执行 `lookup_targets`、实际发送消息 |

## 快速开始

### 1. 安装服务端插件

```bash
openclaw plugins install openclaw-channel-wap
```

### 2. 配置服务端

`~/.openclaw/openclaw.json` 示例：

```json
{
  "channels": {
    "openclaw-channel-wap": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 8765,
      "authToken": "global-token",
      "allowFrom": ["wxid_owner"],
      "groupPolicy": "open",
      "groupAllowChats": ["*"],
      "groupAllowFrom": ["wxid_owner"],
      "noMentionContextGroups": [],
      "noMentionContextHistoryLimit": 8,
      "dmPolicy": "pairing",
      "requireMentionInGroup": true,
      "silentPairing": true,
      "accounts": {
        "phone-a": {
          "enabled": true,
          "authToken": "token-for-phone-a",
          "allowFrom": ["wxid_owner_a"],
          "groupPolicy": "allowlist",
          "groupAllowChats": ["123456789@chatroom"],
          "groupAllowFrom": ["wxid_owner_a"],
          "noMentionContextGroups": ["123456789@chatroom"],
          "noMentionContextHistoryLimit": 8,
          "dmPolicy": "pairing",
          "requireMentionInGroup": true,
          "silentPairing": true,
          "groups": {
            "*": {
              "requireMention": true,
              "tools": {
                "allow": ["wechat_lookup_targets", "wechat_capabilities"]
              }
            },
            "123456789@chatroom": {
              "enabled": true,
              "groupPolicy": "allowlist",
              "allowFrom": ["wxid_owner_a", "wxid_operator_a"],
              "requireMention": false,
              "skills": ["product-search", "release-checklist"],
              "systemPrompt": "这是产品群，优先给出结论和下一步。"
            }
          }
        }
      }
    }
  }
}
```

### 3. 配置 Android 插件

编辑 `wap_plugin/config.yml`：

```yaml
server_url: "ws(s)://xxx.xxx.xxx:xxx/ws"
auth_token: "xxx"
heartbeat_interval_ms: 20000
max_missed_heartbeats: 2
send_rate_limit_per_min: 30
max_send_retries: 3
retry_delay_ms: 2000
max_pending_messages: 5
message_ttl_ms: 30000
```

将 `wap_plugin/` 复制到 WAuxiliary 插件目录并启用。

## Discovery 与 Send

### Discovery tools

当前注册的主动工具：

- `wechat_get_friends`
- `wechat_get_groups`
- `wechat_lookup_targets`
- `wechat_capabilities`

`wechat_lookup_targets` 用于“先找，再选，再发”。它返回候选列表，而不是单个解析结果。

返回候选字段包括：

- `canonicalTarget`
- `targetKind`
- `talker`
- `displayName`
- `remark`
- `nickname`
- `alias`
- `groupName`
- `matchedBy`
- `score`
- `sendStatus`
- `sendStatusReason`

### Message actions

当前 channel message tool 支持：

- `search`
- `send`

主动发送不再走 `wechat_send_*` 工具，而是走 OpenClaw 标准 message `send` action。

## Canonical Target

Host / agent 统一使用 typed canonical target：

- `user:<wxid>`
- `group:<talker@chatroom>`

发送链路规则：

- lookup 返回 typed canonical target
- message `send` 只接受 typed canonical target
- Android 下行 `send_*` 命令只接受最终 canonical talker：
  - 私聊：`wxid`
  - 群聊：`*@chatroom`
- 发送阶段不再做昵称/备注模糊解析

## `sendStatus` 语义

`wechat_lookup_targets` 会区分“查得到”和“发得出去”：

- `sendable`
- `not_friend`
- `blocked_by_allow_from`
- `invalid_group`
- `unknown`

discovery 不会因为目标不可发送就把候选吞掉。

## 协议

### 上行 `capabilities`

客户端在连接并收到 `config` 后主动上报：

```json
{
  "type": "capabilities",
  "data": {
    "protocol_version": "wap-vnext-2026-03-24",
    "client_name": "openclaw-channel-wap",
    "client_version": "5.0.0",
    "rpc_methods": ["get_friends", "get_groups", "lookup_targets"],
    "command_types": ["send_text", "send_image", "send_file"],
    "features": ["capabilities", "rpc", "lookup_targets", "command_result", "group_mentions", "local_media_cache", "quote_reply", "quote_inbound"]
  }
}
```

### 下行 `rpc_request`

查询目标候选：

```json
{
  "type": "rpc_request",
  "data": {
    "request_id": "9e40b4fe-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "method": "lookup_targets",
    "params": {
      "query": "Brown",
      "kind": "all",
      "limit": 10
    }
  }
}
```

### 上行 `rpc_result`

`lookup_targets` 返回候选列表：

```json
{
  "type": "rpc_result",
  "data": {
    "request_id": "9e40b4fe-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "method": "lookup_targets",
    "ok": true,
    "result": {
      "query": "Brown",
      "kind": "all",
      "count": 2,
      "candidates": [
        {
          "canonical_target": "user:wxid_brown",
          "talker": "wxid_brown",
          "target_kind": "direct",
          "display_name": "Brown",
          "remark": "Brown",
          "matched_by": "remark_exact",
          "score": 120,
          "send_status": "sendable"
        },
        {
          "canonical_target": "user:wxid_brown_ops",
          "talker": "wxid_brown_ops",
          "target_kind": "direct",
          "display_name": "Brown Ops",
          "nickname": "Brown",
          "matched_by": "nickname_exact",
          "score": 110,
          "send_status": "blocked_by_allow_from",
          "send_status_reason": "target is not in allowFrom"
        }
      ]
    }
  }
}
```

### 下行 `send_text`

```json
{
  "type": "send_text",
  "data": {
    "request_id": "a9f6c2f3-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "talker": "wxid_xxx",
    "content": "早上好",
    "reply_to_msg_id": 12345678
  }
}
```

说明：

- `talker` 必须是最终 canonical talker，不是备注、昵称或关键字
- `reply_to_msg_id` 存在时，Android 端优先尝试引用回复

### 上行 `command_result`

```json
{
  "type": "command_result",
  "data": {
    "request_id": "a9f6c2f3-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "command_type": "send_text",
    "ok": false,
    "error_code": "blocked_by_allow_from",
    "error": "target is not in allowFrom"
  }
}
```

成功时返回 `result`，失败时返回：

- `invalid_canonical_target`
- `not_friend`
- `blocked_by_allow_from`
- `invalid_group`
- `rate_limited`
- `send_failed`

## 群内 @ 模板

当目标为群时，文本与 caption 支持 `{{at:...}}`，发送前会转换成 `[AtWx=...]`：

- `{{at:wxid_xxx}}`
- `{{at:张三}}`
- `{{at:remark:张三}}`

## 诊断命令

当前还会注册：

- `/wap doctor`
- `/wap capabilities`
- `/wap help`
- `openclaw wap-diagnose`

## 校验

服务端最小校验命令：

```bash
cd openclaw-channel-wap/openclaw_plugin
pnpm exec tsc --noEmit
```
