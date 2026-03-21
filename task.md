# WAP vNext Execution Notebook

## Purpose

This file is the authoritative task log, TODO list, implementation notebook, and handoff document for the WAP vNext rewrite/refactor.

When continuing work later with reduced chat context, start here first.

## Hard Constraints

- Only modify files inside `openclaw-channel-wap/`
- Do not sync remote by default
- Do not stop to ask unless there is a real design fork, approval need, or major deviation
- Destructive refactor is allowed
- Backward compatibility with old WAP protocol / old `wap_plugin` behavior is not required
- Reference implementation is only `../openclaw-lark/`

## User Intent Snapshot

The user wants `openclaw-channel-wap` to be upgraded from a mostly passive WeChat relay into a richer OpenClaw channel that aligns with the official Feishu plugin architecture where it makes sense, especially:

- active tool invocation
- skill-driven usage
- stronger plugin structure
- better diagnostics and status
- cleaner future extensibility

The user explicitly agreed with this direction:

- Waxposed MCP is likely just a wrapper over existing WA plugin interfaces
- production/runtime design should prefer direct WA plugin interfaces or a WAP-native protocol
- MCP can remain a reference or debug probe surface, but should not be the primary architecture

## Current Working Direction

Primary runtime direction:

- host-side OpenClaw plugin registers first-class WeChat tools
- Android plugin exposes WAP-native capability/RPC operations over the existing host link
- the protocol can be redesigned freely
- Waxposed MCP is reference/debug input, not the main runtime contract

## Environment Snapshot

- Workspace root: `/home/ca11back/Downloads/conver/wap`
- Repo root: `/home/ca11back/Downloads/conver/wap/openclaw-channel-wap`
- Host reference repo: `/home/ca11back/Downloads/conver/wap/openclaw-lark`
- Android plugin target directory:
  `/sdcard/Android/media/com.tencent.mm/WAuxiliary/Plugin/openclaw-channel-wap`
- Current ADB device:
  `192.168.6.163:5555`

## Previously Verified Facts

### Waxposed MCP

Verified by live probing earlier in this session:

- Android endpoint: `localhost:8848/sse`
- Local debug bridge:
  `adb forward tcp:18848 tcp:8848`
- server info:
  - name: `Wa Mcp`
  - version: `1.0.0`
  - protocol: `2025-03-26`
- current exposed MCP tools:
  - `get_friends`
  - `get_groups`
  - `send_text`
- `resources/list` and `prompts/list` were not supported

Interpretation:

- MCP proves active WeChat operations are feasible
- but the surface is narrower than the long-term WAP feature set
- therefore it is not a good primary architecture target

## Baseline Findings

### Current WAP strengths

- inbound DM/group delivery into OpenClaw works
- pairing and allowlist logic exist
- mention gating exists
- outbound text/media works
- target resolution exists
- local file relay exists

### Current WAP weaknesses

- no plugin-registered tools
- no built-in commands
- no directory layer
- no explicit capability handshake
- no rich status/probe model
- no group-level skills/tools/systemPrompt configuration
- host responsibilities are concentrated in a few large files

### Feishu patterns worth adopting

- modular tool registration from plugin entrypoint
- directory as a first-class feature
- built-in commands and diagnostics
- richer status model
- cleaner channel/plugin layering
- per-group skill/tool controls

### Feishu patterns not worth copying literally

- reactions
- threads as strict parity target
- doc/wiki/drive/task/calendar feature families
- card-centric UX

## Desired End State

At the end of this task, WAP vNext should have:

1. a clearer host-side architecture
2. a WAP-native capability/RPC layer to Android
3. first-class WeChat tools that agents/skills can call
4. search/directory behavior that is not bolted onto one ad hoc action path
5. basic diagnostics/status surfaces
6. updated docs reflecting the new design

## Target First-Class Tools

First wave:

- `wechat_get_friends`
- `wechat_get_groups`
- `wechat_search_target`
- `wechat_send_text`

Second wave if practical in this rollout:

- `wechat_send_image`
- `wechat_send_file`

## Proposed Capability/RPC Surface

Host to Android:

- `rpc_request`
  - `request_id`
  - `method`
  - `params`

Android to host:

- `rpc_result`
  - `request_id`
  - `ok`
  - `result`
  - `error`

Client self-description:

- `capabilities`
  - version/protocol version
  - supported methods
  - optional metadata

Initial RPC methods:

- `search_target`
- `get_friends`
- `get_groups`
- `send_text`

Possible later RPC methods:

- `send_image`
- `send_file`

## Implementation Plan

### Phase 1: Execution notebook and host architecture groundwork

Goals:

- create authoritative `task.md`
- split host responsibilities into reusable modules
- add capability storage and generic RPC plumbing on the host

Success criteria:

- codebase compiles
- no behavior regression for existing message flow
- generic host-side RPC path exists

### Phase 2: Android-side RPC/capability implementation

Goals:

- implement `capabilities` message
- implement `rpc_request` / `rpc_result`
- support `search_target`, `get_friends`, `get_groups`, `send_text`

Success criteria:

- host can query Android for friends/groups/search
- host tool calls can be fulfilled over the WAP-native link

### Phase 3: Tool registration and active invocation

Goals:

- register `wechat_*` tools from plugin entrypoint
- implement tool executors on host
- reuse channel outbound logic where it makes sense

Success criteria:

- OpenClaw can actively call WeChat tools without needing inbound message trigger

### Phase 4: Diagnostics, commands, and status

Goals:

- add `/wap` command surface
- add diagnostic/status output
- expose known client capabilities and connection state

Success criteria:

- user/operator can inspect readiness and supported methods from OpenClaw side

### Phase 5: Docs and cleanup

Goals:

- update `README.md`
- update `ARCHITECTURE.md`
- update plugin docs and examples
- ensure `task.md` reflects final structure and any residual TODOs

Success criteria:

- docs match shipped behavior

## Commit Strategy

- commit after each stable phase
- keep commit scope focused
- expected commit buckets:
  - host groundwork
  - Android protocol support
  - tools and diagnostics
  - docs and cleanup

## Live TODO

- [x] Create host-side generic RPC/capability layer
- [x] Create host-side tool registration module
- [x] Add host-side capability/status inspection helpers
- [x] Add Android capability advertisement
- [x] Add Android `rpc_request` / `rpc_result`
- [x] Implement Android `get_friends`
- [x] Implement Android `get_groups`
- [x] Implement Android `search_target`
- [x] Implement Android `send_text`
- [x] Register `wechat_get_friends`
- [x] Register `wechat_get_groups`
- [x] Register `wechat_search_target`
- [x] Register `wechat_send_text`
- [x] Add `/wap` diagnostics commands
- [x] Update root docs
- [x] Run `pnpm exec tsc --noEmit`
- [ ] Consider active `wechat_send_image`
- [ ] Consider active `wechat_send_file`
- [ ] Consider richer per-group skills/tools/systemPrompt config model
- [ ] Record remaining follow-up work here

## Progress Log

### 2026-03-21

- Task formally started
- User clarified that MCP should be treated as likely redundant for production because it wraps existing WA plugin interfaces
- Agreed architecture direction: direct WAP-native capability/RPC path, not MCP-first
- Need to keep all edits inside `openclaw-channel-wap/`
- Added repo-local `task.md` as the authoritative notebook
- Implemented host-side capability/RPC handling in `openclaw_plugin/src/ws-server.ts`
- Added reusable host operations in `openclaw_plugin/src/operations.ts`
- Registered active WeChat tools in `openclaw_plugin/src/tools.ts`
- Registered `/wap` and `wap-diagnose` diagnostics in `openclaw_plugin/src/commands.ts`
- Enabled channel-level prompt hints, directory hooks, and security warnings
- Implemented Android-side `capabilities`, `rpc_request`, and `rpc_result` support in `wap_plugin/main.java`
- Implemented Android RPC methods: `get_friends`, `get_groups`, `search_target`
- Bumped protocol/package/client version markers to `4.0.0`
- Updated `README.md` and `ARCHITECTURE.md`
- Verified host-side compile with `pnpm exec tsc --noEmit`

## Remaining Follow-up

- Active image/file tools are not registered yet; current active send surface is text-first
- Group-level `skills` / `tools` / `systemPrompt` parity with Feishu is still a future refactor, not part of this completed slice
- Java-side behavior was updated by code inspection and protocol symmetry, but no Android runtime validation was run in this session

## Resume Checklist

When resuming later:

1. read this file fully
2. run `git -C openclaw-channel-wap status --short`
3. open:
   - `openclaw_plugin/index.ts`
   - `openclaw_plugin/src/channel.ts`
   - `openclaw_plugin/src/ws-server.ts`
   - `openclaw_plugin/src/protocol.ts`
   - `wap_plugin/main.java`
4. continue with the first unchecked item in `Live TODO`
