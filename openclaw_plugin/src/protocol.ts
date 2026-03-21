// ============================================================
// Shared capability types
// ============================================================

export interface WapClientCapabilities {
  protocol_version: string;
  client_name?: string;
  client_version?: string;
  rpc_methods?: string[];
  command_types?: string[];
  features?: string[];
}

// ============================================================
// Upstream messages (Android -> Server)
// ============================================================

export interface WapMessageData {
  msg_id: number;
  msg_type: number;
  talker: string;
  sender: string;
  sender_display_name?: string;
  sender_group_display_name?: string;
  group_name?: string;
  group_member_count?: number;
  content: string;
  timestamp: number;
  is_private: boolean;
  is_group: boolean;
  is_at_me?: boolean;
  at_user_list?: string[];
}

export interface WapMessagePayload {
  type: "message";
  data: WapMessageData;
}

export interface WapHeartbeatPayload {
  type: "heartbeat";
}

export interface WapCapabilitiesPayload {
  type: "capabilities";
  data: WapClientCapabilities;
}

export interface WapResolveTargetResultPayload {
  type: "resolve_target_result";
  data: {
    request_id: string;
    target: string;
    ok: boolean;
    resolved_talker?: string;
    target_kind?: "direct" | "group" | "unknown";
    error?: string;
  };
}

export interface WapRpcResultPayload {
  type: "rpc_result";
  data: {
    request_id: string;
    method: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  };
}

export type WapUpstreamMessage =
  | WapMessagePayload
  | WapHeartbeatPayload
  | WapCapabilitiesPayload
  | WapResolveTargetResultPayload
  | WapRpcResultPayload;

// ============================================================
// Downstream commands (Server -> Android)
// ============================================================

export interface WapSendTextCommand {
  type: "send_text";
  data: {
    talker: string;
    content: string;
  };
}

export interface WapPongCommand {
  type: "pong";
}

export interface WapResolveTargetCommand {
  type: "resolve_target";
  data: {
    request_id: string;
    target: string;
  };
}

export interface WapRpcRequestCommand {
  type: "rpc_request";
  data: {
    request_id: string;
    method: string;
    params?: Record<string, unknown>;
  };
}

export interface WapConfigCommand {
  type: "config";
  data: {
    allow_from: string[];
    group_policy: "open" | "allowlist" | "disabled";
    group_allow_chats: string[];
    group_allow_from: string[];
    no_mention_context_groups: string[];
    dm_policy: "open" | "pairing" | "allowlist" | "disabled";
    require_mention_in_group: boolean;
    silent_pairing: boolean;
  };
}

export interface WapSendImageCommand {
  type: "send_image";
  data: {
    talker: string;
    image_url?: string;
    image_id?: string;
    account_id?: string;
    caption?: string;
  };
}

export interface WapSendFileCommand {
  type: "send_file";
  data: {
    talker: string;
    file_url?: string;
    file_id?: string;
    account_id?: string;
    file_name?: string;
    caption?: string;
  };
}

export interface WapSendVoiceCommand {
  type: "send_voice";
  data: {
    talker: string;
    voice_url: string;
    duration: number;
  };
}

export type WapDownstreamCommand =
  | WapSendTextCommand
  | WapPongCommand
  | WapResolveTargetCommand
  | WapRpcRequestCommand
  | WapConfigCommand
  | WapSendImageCommand
  | WapSendFileCommand
  | WapSendVoiceCommand;
