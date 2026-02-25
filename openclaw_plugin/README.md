# OpenClaw WAP Channel

OpenClaw 的微信消息通道插件，通过 WAuxiliary 插件接入微信消息。

> 重要：本 README 仅描述服务端 Channel 配置。必须与仓库主 README 和 `wap_plugin/` 配套使用：  
> 先看 [`../README.md`](../README.md)，再按本文配置服务端，最后按 [`../wap_plugin/README.md`](../wap_plugin/README.md) 配置客户端。

## 安装

```bash
openclaw plugins install openclaw-channel-wap
```

## 配置

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "openclaw-channel-wap": {
      "enabled": true,
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

## 字段说明

| 字段 | 说明 |
|---|---|
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

## 发送目标（对齐 TG/Discord 使用体验）

- 直接 ID：`wxid_xxx` / `123456789@chatroom`
- 按群名：`group:产品讨论群`
- 按好友备注/昵称：`friend:张三`（也支持 `remark:` / `nickname:` / `name:`）

> 名称解析发生在 WAuxiliary 客户端（`wap_plugin`）侧；若同名冲突会拒绝发送并要求改用 ID。

## 协议变化（3.0）

- 上行消息新增 `is_at_me`、`at_user_list`。
- 下行 `config` 支持 `allow_from/group_policy/group_allow_chats/group_allow_from/no_mention_context_groups/dm_policy/require_mention_in_group/silent_pairing`。
- 默认 `dmPolicy=pairing`，并支持静默 pairing（不回消息，仅登记请求）。

## 开发

```bash
pnpm install
pnpm exec tsc --noEmit
```
