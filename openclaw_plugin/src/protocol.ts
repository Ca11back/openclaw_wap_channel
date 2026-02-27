// ============================================================
// 上行消息 (Android → Server)
// ============================================================

export interface WapMessageData {
    msg_id: number;
    msg_type: number;
    talker: string; // 会话 ID (wxid 或群 ID)
    sender: string; // 发送者 wxid
    content: string; // 消息内容
    timestamp: number; // 毫秒时间戳
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

export type WapUpstreamMessage = WapMessagePayload | WapHeartbeatPayload | WapResolveTargetResultPayload;

// ============================================================
// 下行指令 (Server → Android)
// ============================================================

export interface WapSendTextCommand {
    type: "send_text";
    data: {
        talker: string;  // Android 端期望 'talker' 字段
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

// 预留接口：图片消息
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

// 预留接口：语音消息
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
    | WapConfigCommand
    | WapSendImageCommand
    | WapSendFileCommand
    | WapSendVoiceCommand;
