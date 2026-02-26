# OpenClaw WAP Channel

通过 WAuxiliary 将微信消息桥接到 OpenClaw AI 助手的完整方案（当前仅支持文本消息）。

## 组件说明

本仓库包含两个必须配套使用的组件：

| 组件 | 类型 | 安装方式 | 说明 |
|------|------|----------|------|
| `openclaw_plugin/` | OpenClaw Channel（服务端） | `openclaw plugins install` | 接收消息、执行策略、调用 OpenClaw AI |
| `wap_plugin/` | WAuxiliary 插件（客户端） | 手动安装 | 接收服务端策略并在本地过滤/发送微信消息 |

## 快速开始

### 1. 安装服务端（OpenClaw Channel）

```bash
openclaw plugins install openclaw-channel-wap
```

### 2. 配置服务端（`~/.openclaw/openclaw.json`）

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
          "silentPairing": true
        }
      }
    }
  }
}
```

### 3. 安装并配置客户端（WAuxiliary 插件）

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

然后将 `wap_plugin` 目录复制到 WAuxiliary 插件目录并启用。

## 服务端配置字段

| 字段 | 说明 |
|---|---|
| `host` | WebSocket 监听地址（默认 `127.0.0.1`） |
| `port` | WebSocket 服务端口（全局） |
| `authToken` | 全局连接 token（可被账户级覆盖） |
| `allowFrom` | 私聊允许列表 |
| `groupPolicy` | 群策略：`open/allowlist/disabled` |
| `groupAllowChats` | `groupPolicy=allowlist` 时允许触发的群 talker 列表（支持 `*`） |
| `groupAllowFrom` | 群聊发送者允许列表 |
| `noMentionContextGroups` | 允许“未@仅记录上下文”的群列表（需手动配置，支持 `*`） |
| `noMentionContextHistoryLimit` | 每个群保留的未@上下文条数（默认 8） |
| `dmPolicy` | `pairing/allowlist/open/disabled` |
| `requireMentionInGroup` | 群聊是否必须 @ 机器人 |
| `silentPairing` | pairing 模式下是否静默拦截（不自动回配对码） |
| `accounts.<id>.*` | 账户级配置（覆盖全局字段） |

## 客户端行为与过滤原则

- 客户端连接后接收服务端下发配置：`allow_from/group_policy/group_allow_chats/group_allow_from/no_mention_context_groups/dm_policy/require_mention_in_group/silent_pairing`。
- 群聊按本地顺序过滤：`group_policy` -> `group_allow_chats` -> `group_allow_from` -> `@` 门禁。
- 默认维持“群内必须 @ 才触发回复”；只有命中 `no_mention_context_groups` 的群，未@消息才会上报用于上下文记录（不触发当次回复）。
- pairing 模式支持静默拦截。

## 发送目标与解析规则

支持的目标格式：

- 直接 ID：`wxid_xxx` / `123456789@chatroom`
- 好友名称：`friend:张三`（也支持 `remark:` / `nickname:` / `name:`）
- 群名称：`group:产品讨论群`（也支持 `room:`）

解析与发送原则：

- 名称解析在 WAuxiliary 客户端执行。
- 重名冲突会拒绝发送并要求改用 ID。
- 私聊解析优先级：`备注 > 昵称(含 alias) > wxid`。
- 私聊目标必须是好友；若目标 wxid 不在好友列表，直接视为发送失败。

## 群内 @ 模板

当目标为群时，消息内容支持 `{{at:...}}`，发送前会转为 `[AtWx=...]`：

- `{{at:wxid_xxx}}`：按 wxid @
- `{{at:张三}}`：按群内显示名/昵称解析 @
- `{{at:remark:张三}}`：按备注/昵称关键字解析 @

## 协议

上行 `message` 示例：

```json
{
  "type": "message",
  "data": {
    "msg_id": 12345678,
    "msg_type": 1,
    "talker": "wxid_or_groupid",
    "sender": "wxid_xxx",
    "content": "消息内容",
    "timestamp": 1706600000000,
    "is_private": true,
    "is_group": false,
    "is_at_me": false,
    "at_user_list": []
  }
}
```

下行 `config` 示例：

```json
{
  "type": "config",
  "data": {
    "allow_from": ["wxid_owner"],
    "group_policy": "allowlist",
    "group_allow_chats": ["123456789@chatroom"],
    "group_allow_from": ["wxid_owner"],
    "no_mention_context_groups": ["123456789@chatroom"],
    "dm_policy": "pairing",
    "require_mention_in_group": true,
    "silent_pairing": true
  }
}
```

下行 `send_text` 示例：

```json
{
  "type": "send_text",
  "data": {
    "talker": "wxid_or_groupid",
    "content": "AI 回复内容"
  }
}
```

下行 `send_image` 示例：

```json
{
  "type": "send_image",
  "data": {
    "talker": "wxid_or_groupid",
    "image_url": "https://example.com/a.jpg",
    "caption": "可选图片说明"
  }
}
```

下行 `send_file` 示例（当前 WAux 客户端会降级为“标题+链接”文本发送）：

```json
{
  "type": "send_file",
  "data": {
    "talker": "wxid_or_groupid",
    "file_url": "https://example.com/demo.pdf",
    "file_name": "demo.pdf",
    "caption": "可选文件说明"
  }
}
```

## 目录文档说明

- `openclaw_plugin/README.md`：服务端子模块简述（详细以本主 README 为准）
- `wap_plugin/README.md`：客户端子模块简述（详细以本主 README 为准）
- `ARCHITECTURE.md`：架构与协议补充说明

## 开发验证

```bash
cd openclaw_plugin
pnpm install
pnpm exec tsc --noEmit
```

## 许可

MIT License
