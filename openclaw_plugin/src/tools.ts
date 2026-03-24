import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildWapClientDiagnostics, listWapFriends, listWapGroups, lookupWapTargets, type WapLookupKind } from "./operations.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

type LookupParams = {
  query: string;
  kind?: WapLookupKind;
  accountId?: string;
  limit?: number;
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

function normalizeLookupKind(value: unknown): WapLookupKind {
  return value === "user" || value === "group" ? value : "all";
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
      name: "wechat_lookup_targets",
      label: "WeChat: Lookup Targets",
      description:
        "Find candidate WeChat recipients and return canonical targets with sendability metadata. Use this before active WeChat sending.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "Query string used to match users or groups." },
          kind: { type: "string", enum: ["user", "group", "all"], description: "Optional lookup scope." },
          accountId: { type: "string", description: "Optional WAP account id." },
          limit: { type: "number", description: "Optional maximum number of candidates to return." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        const p = (params ?? {}) as LookupParams;
        const query = normalizeOptionalString(p.query);
        if (!query) {
          return jsonResult({ ok: false, error: "Missing query" });
        }
        const result = await lookupWapTargets({
          query,
          kind: normalizeLookupKind(p.kind),
          accountId: normalizeOptionalString(p.accountId),
          limit: normalizeOptionalNumber(p.limit),
        });
        return jsonResult(result.ok ? { ok: true, query: result.query, candidates: result.candidates } : result);
      },
    },
    { name: "wechat_lookup_targets" },
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
