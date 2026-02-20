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

export type WapUpstreamMessage = WapMessagePayload | WapHeartbeatPayload;

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

export interface WapConfigCommand {
    type: "config";
    data: {
        allow_from: string[];
        group_allow_from: string[];
        dm_policy: "open" | "pairing" | "allowlist" | "disabled";
        require_mention_in_group: boolean;
        silent_pairing: boolean;
        whitelist?: string[];
    };
}

// 预留接口：图片消息
export interface WapSendImageCommand {
    type: "send_image";
    data: {
        talker: string;
        image_url: string;
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
    | WapConfigCommand
    | WapSendImageCommand
    | WapSendVoiceCommand;
