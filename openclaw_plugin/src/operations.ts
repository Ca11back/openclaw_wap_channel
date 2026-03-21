import { DEFAULT_ACCOUNT_ID, normalizeWapMessagingTarget } from "./config.js";
import { callClientRpc, getClientCapabilities, getClientStats, resolveTargetViaClient, sendToClient } from "./ws-server.js";
import type { WapSendTextCommand } from "./protocol.js";

export type WapFriendEntry = {
  wxid: string;
  alias?: string;
  remark?: string;
  nickname?: string;
  displayName: string;
  sendable: boolean;
};

export type WapGroupEntry = {
  talker: string;
  name?: string;
  memberCount?: number;
};

export type WapResolvedTarget = {
  input: string;
  talker: string;
  canonicalTarget: string;
  targetKind: "direct" | "group";
  displayName?: string;
  sendable?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeAccountId(accountId?: string | null): string {
  return (accountId ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
}

function decorateCanonicalTarget(talker: string): string {
  return talker.endsWith("@chatroom") ? `group:${talker}` : `user:${talker}`;
}

function applyQueryAndLimit<T>(
  items: T[],
  options: { query?: string | null; limit?: number | null; keyFn: (item: T) => string[] },
): T[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  const filtered = query
    ? items.filter((item) =>
        options.keyFn(item).some((key) => key.toLowerCase().includes(query)),
      )
    : items;
  const limit = options.limit ?? undefined;
  if (!limit || limit <= 0) {
    return filtered;
  }
  return filtered.slice(0, limit);
}

export async function listWapFriends(params: {
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
}): Promise<{ ok: true; friends: WapFriendEntry[] } | { ok: false; error: string }> {
  const accountId = normalizeAccountId(params.accountId);
  const rpcResult = await callClientRpc({
    method: "get_friends",
    accountId,
  });
  if (!rpcResult.ok) {
    return rpcResult;
  }
  const record = asRecord(rpcResult.result);
  const rawFriends = Array.isArray(record?.friends) ? record.friends : [];
  const friends: WapFriendEntry[] = [];
  for (const rawEntry of rawFriends) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      continue;
    }
    const wxid = asString(entry.wxid) ?? asString(entry.id);
    if (!wxid) {
      continue;
    }
    const remark = asString(entry.remark);
    const nickname = asString(entry.nickname);
    const alias = asString(entry.alias);
    const displayName = remark ?? nickname ?? alias ?? wxid;
    friends.push({
      wxid,
      remark,
      nickname,
      alias,
      displayName,
      sendable: entry.sendable === false ? false : true,
    });
  }
  return {
    ok: true,
    friends: applyQueryAndLimit(friends, {
      query: params.query,
      limit: params.limit,
      keyFn: (entry) => [entry.wxid, entry.displayName, entry.remark ?? "", entry.nickname ?? "", entry.alias ?? ""],
    }),
  };
}

export async function listWapGroups(params: {
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
}): Promise<{ ok: true; groups: WapGroupEntry[] } | { ok: false; error: string }> {
  const accountId = normalizeAccountId(params.accountId);
  const rpcResult = await callClientRpc({
    method: "get_groups",
    accountId,
  });
  if (!rpcResult.ok) {
    return rpcResult;
  }
  const record = asRecord(rpcResult.result);
  const rawGroups = Array.isArray(record?.groups) ? record.groups : [];
  const groups: WapGroupEntry[] = [];
  for (const rawEntry of rawGroups) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      continue;
    }
    const talker = asString(entry.talker) ?? asString(entry.id);
    if (!talker) {
      continue;
    }
    groups.push({
      talker,
      name: asString(entry.name),
      memberCount: asNumber(entry.member_count) ?? asNumber(entry.memberCount),
    });
  }
  return {
    ok: true,
    groups: applyQueryAndLimit(groups, {
      query: params.query,
      limit: params.limit,
      keyFn: (entry) => [entry.talker, entry.name ?? ""],
    }),
  };
}

export async function searchWapTarget(params: {
  target: string;
  accountId?: string | null;
}): Promise<{ ok: true; result: WapResolvedTarget } | { ok: false; error: string }> {
  const accountId = normalizeAccountId(params.accountId);
  const target = normalizeWapMessagingTarget(params.target);
  if (!target) {
    return { ok: false, error: "Missing WeChat target" };
  }
  const rpcResult = await callClientRpc({
    method: "search_target",
    accountId,
    rpcParams: { target },
  });
  if (rpcResult.ok) {
    const record = asRecord(rpcResult.result);
    const talker = asString(record?.talker) ?? asString(record?.resolved_talker);
    const targetKindRaw = asString(record?.target_kind) ?? "unknown";
    const targetKind = targetKindRaw === "group" ? "group" : targetKindRaw === "direct" ? "direct" : null;
    if (talker && targetKind) {
      return {
        ok: true,
        result: {
          input: target,
          talker,
          targetKind,
          canonicalTarget: decorateCanonicalTarget(talker),
          displayName: asString(record?.display_name),
          sendable: typeof record?.sendable === "boolean" ? record.sendable : undefined,
        },
      };
    }
  }

  const fallback = await resolveTargetViaClient({
    target,
    accountId,
  });
  if (!fallback.ok) {
    return fallback;
  }
  const targetKind =
    fallback.kind === "group" || fallback.talker.endsWith("@chatroom") ? "group" : "direct";
  return {
    ok: true,
    result: {
      input: target,
      talker: fallback.talker,
      targetKind,
      canonicalTarget: decorateCanonicalTarget(fallback.talker),
    },
  };
}

export async function sendWapText(params: {
  target: string;
  content: string;
  accountId?: string | null;
}): Promise<
  | {
      ok: true;
      accountId: string;
      talker: string;
      canonicalTarget: string;
      targetKind: "direct" | "group";
      displayName?: string;
    }
  | { ok: false; error: string }
> {
  const accountId = normalizeAccountId(params.accountId);
  const content = params.content.trim();
  if (!content) {
    return { ok: false, error: "Missing WeChat message content" };
  }
  const resolved = await searchWapTarget({
    target: params.target,
    accountId,
  });
  if (!resolved.ok) {
    return resolved;
  }
  if (resolved.result.sendable === false) {
    return {
      ok: false,
      error: `Resolved target is currently not sendable: ${resolved.result.canonicalTarget}`,
    };
  }
  const command: WapSendTextCommand = {
    type: "send_text",
    data: {
      talker: resolved.result.talker,
      content,
    },
  };
  const sent = sendToClient(command, accountId);
  if (!sent) {
    return { ok: false, error: `No connected WAP clients for account ${accountId}` };
  }
  return {
    ok: true,
    accountId,
    talker: resolved.result.talker,
    canonicalTarget: resolved.result.canonicalTarget,
    targetKind: resolved.result.targetKind,
    displayName: resolved.result.displayName,
  };
}

export function buildWapClientDiagnostics(accountId?: string | null) {
  const normalizedAccountId = accountId ? normalizeAccountId(accountId) : null;
  const clients = getClientStats()
    .filter((client) => !normalizedAccountId || client.accountId === normalizedAccountId)
    .map((client) => ({
      clientId: client.clientId,
      accountId: client.accountId,
      ip: client.ip,
      connectedAt: client.connectedAt.toISOString(),
      lastCapabilityAt: client.lastCapabilityAt,
      capabilities: client.capabilities,
    }));
  return {
    accountId: normalizedAccountId ?? DEFAULT_ACCOUNT_ID,
    connectedClients: clients.length,
    capabilities: getClientCapabilities(normalizedAccountId ?? undefined),
    clients,
  };
}
