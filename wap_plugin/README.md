# WAuxiliary 微信桥接插件

通过 WebSocket 把微信消息转发到 OpenClaw WAP Channel，并接收 AI 回复。

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
  - `dm_policy`
  - `require_mention_in_group`
- 群聊按服务端规则本地过滤：`group_policy` -> `group_allow_chats` -> `group_allow_from` -> `@` 门禁。
- pairing 模式支持静默拦截（未授权用户不自动收到回复）。
- 插件默认同时转发私聊与群聊（不再默认仅私聊）。

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
