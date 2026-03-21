import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildWapClientDiagnostics, listWapFriends, listWapGroups, searchWapTarget, sendWapMedia, sendWapText } from "./operations.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

type SearchTargetParams = {
  target: string;
  accountId?: string;
};

type SendTextParams = {
  target: string;
  content: string;
  accountId?: string;
};

type SendImageParams = {
  target: string;
  source?: string;
  imageUrl?: string;
  caption?: string;
  accountId?: string;
};

type SendFileParams = {
  target: string;
  source?: string;
  fileUrl?: string;
  fileName?: string;
  caption?: string;
  accountId?: string;
};

type ListParams = {
  accountId?: string;
  query?: string;
  limit?: number;
};

function jsonResult(details: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function registerWapTools(api: OpenClawPluginApi) {
  api.registerTool(
    {
      name: "wechat_get_friends",
      label: "WeChat: Get Friends",
      description: "List friends available from the connected WA plugin.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string", description: "Optional WAP account id." },
          query: { type: "string", description: "Optional fuzzy filter on wxid/remark/nickname/alias." },
          limit: { type: "number", description: "Optional maximum number of records to return." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        const p = (params ?? {}) as ListParams;
        const result = await listWapFriends({
          accountId: normalizeOptionalString(p.accountId),
          query: normalizeOptionalString(p.query),
          limit: normalizeOptionalNumber(p.limit),
        });
        return jsonResult(result.ok ? { ok: true, count: result.friends.length, friends: result.friends } : result);
      },
    },
    { name: "wechat_get_friends" },
  );

  api.registerTool(
    {
      name: "wechat_get_groups",
      label: "WeChat: Get Groups",
      description: "List groups available from the connected WA plugin.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string", description: "Optional WAP account id." },
          query: { type: "string", description: "Optional fuzzy filter on talker/name." },
          limit: { type: "number", description: "Optional maximum number of records to return." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        const p = (params ?? {}) as ListParams;
        const result = await listWapGroups({
          accountId: normalizeOptionalString(p.accountId),
          query: normalizeOptionalString(p.query),
          limit: normalizeOptionalNumber(p.limit),
        });
        return jsonResult(result.ok ? { ok: true, count: result.groups.length, groups: result.groups } : result);
      },
    },
    { name: "wechat_get_groups" },
  );

  api.registerTool(
    {
      name: "wechat_search_target",
      label: "WeChat: Search Target",
      description:
        "Resolve a WeChat target into a canonical direct wxid or group talker. Accepts keyword forms such as friend:/group:/remark:/nickname: and raw canonical ids.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["target"],
        properties: {
          target: { type: "string", description: "Target keyword or canonical id." },
          accountId: { type: "string", description: "Optional WAP account id." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        const p = (params ?? {}) as SearchTargetParams;
        const target = normalizeOptionalString(p.target);
        if (!target) {
          return jsonResult({ ok: false, error: "Missing target" });
        }
        const result = await searchWapTarget({
          target,
          accountId: normalizeOptionalString(p.accountId),
        });
        return jsonResult(result.ok ? { ok: true, ...result.result } : result);
      },
    },
    { name: "wechat_search_target" },
  );

  api.registerTool(
    {
      name: "wechat_send_text",
      label: "WeChat: Send Text",
      description:
        "Send a text message through the connected WA plugin. Accepts keyword targets and canonical ids; the target will be resolved before sending.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["target", "content"],
        properties: {
          target: { type: "string", description: "Target keyword or canonical id." },
          content: { type: "string", description: "Text content to send." },
          accountId: { type: "string", description: "Optional WAP account id." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        const p = (params ?? {}) as SendTextParams;
        const target = normalizeOptionalString(p.target);
        const content = normalizeOptionalString(p.content);
        if (!target || !content) {
          return jsonResult({ ok: false, error: "Missing target/content" });
        }
        const result = await sendWapText({
          target,
          content,
          accountId: normalizeOptionalString(p.accountId),
        });
        return jsonResult(result);
      },
    },
    { name: "wechat_send_text" },
  );

  api.registerTool(
    {
      name: "wechat_send_image",
      label: "WeChat: Send Image",
      description:
        "Send an image through the connected WA plugin. Supports remote HTTP(S) URLs and local file paths accessible to the host.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["target"],
        properties: {
          target: { type: "string", description: "Target keyword or canonical id." },
          source: { type: "string", description: "Image source URL or local file path." },
          imageUrl: { type: "string", description: "Alias of source for image URL/path input." },
          caption: { type: "string", description: "Optional caption sent with the image." },
          accountId: { type: "string", description: "Optional WAP account id." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        const p = (params ?? {}) as SendImageParams;
        const target = normalizeOptionalString(p.target);
        const source = normalizeOptionalString(p.source) ?? normalizeOptionalString(p.imageUrl);
        if (!target || !source) {
          return jsonResult({ ok: false, error: "Missing target/source" });
        }
        const result = await sendWapMedia({
          target,
          source,
          kind: "image",
          caption: normalizeOptionalString(p.caption),
          accountId: normalizeOptionalString(p.accountId),
        });
        return jsonResult(result);
      },
    },
    { name: "wechat_send_image" },
  );

  api.registerTool(
    {
      name: "wechat_send_file",
      label: "WeChat: Send File",
      description:
        "Send a file through the connected WA plugin. Supports remote HTTP(S) URLs and local file paths accessible to the host.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["target"],
        properties: {
          target: { type: "string", description: "Target keyword or canonical id." },
          source: { type: "string", description: "File source URL or local file path." },
          fileUrl: { type: "string", description: "Alias of source for file URL/path input." },
          fileName: { type: "string", description: "Optional file name override for downloads/attachments." },
          caption: { type: "string", description: "Optional caption sent after the file." },
          accountId: { type: "string", description: "Optional WAP account id." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        const p = (params ?? {}) as SendFileParams;
        const target = normalizeOptionalString(p.target);
        const source = normalizeOptionalString(p.source) ?? normalizeOptionalString(p.fileUrl);
        if (!target || !source) {
          return jsonResult({ ok: false, error: "Missing target/source" });
        }
        const result = await sendWapMedia({
          target,
          source,
          kind: "file",
          fileName: normalizeOptionalString(p.fileName),
          caption: normalizeOptionalString(p.caption),
          accountId: normalizeOptionalString(p.accountId),
        });
        return jsonResult(result);
      },
    },
    { name: "wechat_send_file" },
  );

  api.registerTool(
    {
      name: "wechat_capabilities",
      label: "WeChat: Capabilities",
      description: "Inspect currently connected WAP clients and their advertised capabilities.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string", description: "Optional WAP account id." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        const p = (params ?? {}) as { accountId?: string };
        return jsonResult(buildWapClientDiagnostics(normalizeOptionalString(p.accountId)));
      },
    },
    { name: "wechat_capabilities" },
  );
}
