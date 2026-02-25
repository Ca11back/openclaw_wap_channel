# WAuxiliary 微信桥接插件

通过 WebSocket 把微信消息转发到 OpenClaw WAP Channel，并接收 AI 回复。

> 重要：本 README 仅描述客户端插件配置。必须与仓库主 README 和 `openclaw_plugin/` 配套使用：  
> 请先看 [`../README.md`](../README.md)，确认服务端已按 [`../openclaw_plugin/README.md`](../openclaw_plugin/README.md) 正确部署后再配置本文。

## 安装

1. 修改同级 `config.yml`：
   - `server_url`
   - `auth_token`
2. 把 `wap_plugin` 目录复制到 WAuxiliary 插件目录
3. 在 WAuxiliary 中启用插件

## 本地配置

插件会在启动时读取 `pluginDir/config.yml`（同级目录）。  
WAuxiliary 没有内置 YAML 配置 API，这里由插件自行读取并解析键值。

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

- 上面这些是“非服务端下发 + 非重连”配置。
- 重连相关参数仍在 `main.java` 内固定（`RECONNECT_DELAY_*`）。

## 运行机制（3.0）

- 插件连接成功后会接收服务端 `config`：
  - `allow_from`
  - `group_policy`
  - `group_allow_chats`
  - `group_allow_from`
  - `no_mention_context_groups`
  - `dm_policy`
  - `require_mention_in_group`
- 群聊按服务端规则本地过滤：`group_policy` -> `group_allow_chats` -> `group_allow_from` -> `@` 门禁。
- 仅当群在 `no_mention_context_groups` 内时，未@消息才会上报（用于服务端上下文记录，不触发当次回复）。
- pairing 模式支持静默拦截（未授权用户不自动收到回复）。
- 插件默认同时转发私聊与群聊（不再默认仅私聊）。

## 发送目标解析

插件支持以下目标格式（由 WAuxiliary 本地解析）：

- `wxid_xxx`：直接私聊 ID
- `123456789@chatroom`：直接群 ID
- `friend:张三` / `remark:张三` / `nickname:张三`：按好友名称解析
- `group:产品群` / `room:产品群`：按群名解析

若解析结果不唯一（重名），插件会拒绝发送并要求改用 ID。
好友解析优先级：`备注 > 昵称(含alias) > wxid`。

### 私聊发送限制

- 私聊目标必须是当前登录账号的好友（通过 `getFriendList()` 校验）。
- 即使目标字符串看起来像 wxid，只要不在好友列表中，也会拒绝发送。

### 群内 @ 成员模板

当目标是群时，支持在内容里写 `{{at:...}}`，发送前会转为 `[AtWx=...]`：

- `{{at:wxid_xxx}}`：直接 @ 指定 wxid
- `{{at:张三}}`：按群内显示名/昵称解析后 @
- `{{at:remark:张三}}`：按备注/昵称关键字解析后 @

## 上行协议

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

## 下行协议

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

```json
{
  "type": "send_text",
  "data": {
    "talker": "wxid_or_groupid",
    "content": "AI 回复内容"
  }
}
```
