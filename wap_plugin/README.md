# WAuxiliary 微信桥接插件

通过 WebSocket 把微信消息转发到 OpenClaw WAP Channel，并接收 AI 回复。

## 安装

1. 修改 `main.java` 顶部常量：
   - `SERVER_URL`
   - `AUTH_TOKEN`
2. 把 `wap_plugin` 目录复制到 WAuxiliary 插件目录
3. 在 WAuxiliary 中启用插件

## 运行机制（3.0）

- 插件连接成功后会接收服务端 `config`：
  - `allow_from`
  - `group_allow_from`
  - `dm_policy`
  - `require_mention_in_group`
- 群聊支持 `@` 门禁（服务端可要求必须 @ 才触发）。
- pairing 模式支持静默拦截（未授权用户不自动收到回复）。

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
