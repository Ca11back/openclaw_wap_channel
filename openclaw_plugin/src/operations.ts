import {
  DEFAULT_ACCOUNT_ID,
  decorateWapCanonicalTarget,
  normalizeWapMessagingTarget,
  parseWapCanonicalTarget,
} from "./config.js";
import { buildWapMediaCommand, callClientRpc, getClientCapabilities, getClientStats, sendCommandToClient } from "./ws-server.js";
import type { WapSendFileCommand, WapSendImageCommand, WapSendTextCommand } from "./protocol.js";

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

export type WapLookupKind = "user" | "group" | "all";
export type WapTargetKind = "direct" | "group";
export type WapSendStatus = "sendable" | "not_friend" | "blocked_by_allow_from" | "invalid_group" | "unknown";
export type WapSendFailureCode =
  | "invalid_canonical_target"
  | "target_not_found"
  | "not_friend"
  | "blocked_by_allow_from"
  | "invalid_group"
  | "no_connected_client"
  | "rate_limited"
  | "send_failed";

export type WapLookupTargetCandidate = {
  canonicalTarget: string;
  targetKind: WapTargetKind;
  talker: string;
  displayName: string;
  remark?: string;
  nickname?: string;
  alias?: string;
  groupName?: string;
  matchedBy: string;
  score: number;
  sendStatus: WapSendStatus;
  sendStatusReason?: string;
};

export type WapCanonicalTarget = {
  canonicalTarget: string;
  talker: string;
  targetKind: WapTargetKind;
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

function applyQueryAndLimit<T>(
  items: T[],
  options: { query?: string | null; limit?: number | null; keyFn: (item: T) => string[] },
): T[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  const filtered = query
    ? items.filter((item) => options.keyFn(item).some((key) => key.toLowerCase().includes(query)))
    : items;
  const limit = options.limit ?? undefined;
  if (!limit || limit <= 0) {
    return filtered;
  }
  return filtered.slice(0, limit);
}

function parseTargetKind(value: unknown, talker?: string): WapTargetKind | null {
  if (value === "group" || value === "direct") {
    return value;
  }
  if (typeof talker === "string" && talker.endsWith("@chatroom")) {
    return "group";
  }
  if (typeof talker === "string" && talker.trim()) {
    return "direct";
  }
  return null;
}

function parseSendStatus(value: unknown): WapSendStatus {
  if (
    value === "sendable" ||
    value === "not_friend" ||
    value === "blocked_by_allow_from" ||
    value === "invalid_group"
  ) {
    return value;
  }
  return "unknown";
}

function parseLookupCandidate(rawEntry: unknown): WapLookupTargetCandidate | null {
  const entry = asRecord(rawEntry);
  if (!entry) {
    return null;
  }
  const talker = asString(entry.talker) ?? asString(entry.resolved_talker);
  const canonicalTarget =
    asString(entry.canonical_target) ??
    asString(entry.canonicalTarget) ??
    (talker ? decorateWapCanonicalTarget(talker) : undefined);
  const parsedCanonical = canonicalTarget ? parseWapCanonicalTarget(canonicalTarget) : null;
  if (!parsedCanonical) {
    return null;
  }
  const targetKind = parseTargetKind(
    asString(entry.target_kind) ?? asString(entry.targetKind),
    parsedCanonical.talker,
  );
  if (!targetKind) {
    return null;
  }
  const remark = asString(entry.remark);
  const nickname = asString(entry.nickname);
  const alias = asString(entry.alias);
  const groupName = asString(entry.group_name) ?? asString(entry.groupName);
  const displayName =
    asString(entry.display_name) ??
    asString(entry.displayName) ??
    groupName ??
    remark ??
    nickname ??
    alias ??
    parsedCanonical.talker;
  return {
    canonicalTarget: parsedCanonical.canonicalTarget,
    targetKind,
    talker: parsedCanonical.talker,
    displayName,
    remark,
    nickname,
    alias,
    groupName,
    matchedBy: asString(entry.matched_by) ?? asString(entry.matchedBy) ?? "unknown",
    score: asNumber(entry.score) ?? 0,
    sendStatus: parseSendStatus(asString(entry.send_status) ?? asString(entry.sendStatus)),
    sendStatusReason: asString(entry.send_status_reason) ?? asString(entry.sendStatusReason),
  };
}

function findLookupCandidateByCanonicalTarget(
  candidates: WapLookupTargetCandidate[],
  canonicalTarget: string,
): WapLookupTargetCandidate | null {
  const loweredCanonical = canonicalTarget.toLowerCase();
  for (const candidate of candidates) {
    if (candidate.canonicalTarget.toLowerCase() === loweredCanonical) {
      return candidate;
    }
  }
  return null;
}

function mapTransportErrorToSendFailure(error: string): { code: WapSendFailureCode; error: string } {
  if (/No connected WAP clients/i.test(error)) {
    return {
      code: "no_connected_client",
      error,
    };
  }
  return {
    code: "send_failed",
    error,
  };
}

function mapSendStatusToFailure(candidate: WapLookupTargetCandidate): { code: WapSendFailureCode; error: string } | null {
  switch (candidate.sendStatus) {
    case "sendable":
      return null;
    case "not_friend":
      return {
        code: "not_friend",
        error:
          candidate.sendStatusReason ??
          `Resolved WeChat target is not a friend of the connected account: ${candidate.canonicalTarget}`,
      };
    case "blocked_by_allow_from":
      return {
        code: "blocked_by_allow_from",
        error:
          candidate.sendStatusReason ??
          `Resolved WeChat target is blocked by allowFrom: ${candidate.canonicalTarget}`,
      };
    case "invalid_group":
      return {
        code: "invalid_group",
        error:
          candidate.sendStatusReason ??
          `Resolved WeChat group target is invalid or unavailable: ${candidate.canonicalTarget}`,
      };
    default:
      return {
        code: "send_failed",
        error:
          candidate.sendStatusReason ??
          `Resolved WeChat target is not sendable: ${candidate.canonicalTarget}`,
      };
  }
}

function mapCommandFailure(
  result: { ok: false; error: string; errorCode?: string },
): { code: WapSendFailureCode; error: string } {
  switch (result.errorCode) {
    case "invalid_canonical_target":
    case "target_not_found":
    case "not_friend":
    case "blocked_by_allow_from":
    case "invalid_group":
    case "no_connected_client":
    case "rate_limited":
    case "send_failed":
      return {
        code: result.errorCode,
        error: result.error,
      };
    default:
      return mapTransportErrorToSendFailure(result.error);
  }
}

async function preflightCanonicalTarget(params: {
  target: string;
  accountId?: string | null;
}): Promise<
  | { ok: true; target: WapCanonicalTarget; candidate: WapLookupTargetCandidate }
  | { ok: false; code: WapSendFailureCode; error: string }
> {
  const parsed = parseWapCanonicalTarget(params.target);
  if (!parsed) {
    return {
      ok: false,
      code: "invalid_canonical_target",
      error: "Invalid WeChat target. Expected canonical target: <user:wxid> or <group:talker@chatroom>.",
    };
  }
  const lookup = await lookupWapTargets({
    query: parsed.canonicalTarget,
    accountId: params.accountId,
    kind: parsed.targetKind === "group" ? "group" : "user",
    limit: 50,
  });
  if (!lookup.ok) {
    const failure = mapTransportErrorToSendFailure(lookup.error);
    return {
      ok: false,
      ...failure,
    };
  }
  const candidate = findLookupCandidateByCanonicalTarget(lookup.candidates, parsed.canonicalTarget);
  if (!candidate) {
    return {
      ok: false,
      code: "target_not_found",
      error: `WeChat target not found: ${parsed.canonicalTarget}`,
    };
  }
  const sendabilityFailure = mapSendStatusToFailure(candidate);
  if (sendabilityFailure) {
    return {
      ok: false,
      ...sendabilityFailure,
    };
  }
  return {
    ok: true,
    target: parsed,
    candidate,
  };
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
    const sendStatus = parseSendStatus(asString(entry.send_status) ?? asString(entry.sendStatus));
    friends.push({
      wxid,
      remark,
      nickname,
      alias,
      displayName,
      sendable: sendStatus === "sendable" || entry.sendable === true,
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

export async function lookupWapTargets(params: {
  query: string;
  accountId?: string | null;
  kind?: WapLookupKind | null;
  limit?: number | null;
}): Promise<{ ok: true; query: string; candidates: WapLookupTargetCandidate[] } | { ok: false; error: string }> {
  const accountId = normalizeAccountId(params.accountId);
  const query = normalizeWapMessagingTarget(params.query);
  if (!query) {
    return { ok: false, error: "Missing WeChat lookup query" };
  }
  const kind = params.kind === "user" || params.kind === "group" ? params.kind : "all";
  const rpcResult = await callClientRpc({
    method: "lookup_targets",
    accountId,
    rpcParams: {
      query,
      kind,
      ...(typeof params.limit === "number" && Number.isFinite(params.limit) ? { limit: params.limit } : {}),
    },
  });
  if (!rpcResult.ok) {
    return rpcResult;
  }
  const record = asRecord(rpcResult.result);
  const rawCandidates = Array.isArray(record?.candidates) ? record.candidates : [];
  const candidates = rawCandidates
    .map((entry) => parseLookupCandidate(entry))
    .filter((entry): entry is WapLookupTargetCandidate => entry !== null);
  const limit = params.limit ?? undefined;
  return {
    ok: true,
    query,
    candidates: limit && limit > 0 ? candidates.slice(0, limit) : candidates,
  };
}

export async function sendWapTextToCanonicalTarget(params: {
  target: string;
  content: string;
  accountId?: string | null;
  replyToMessageId?: number | null;
}): Promise<
  | {
      ok: true;
      accountId: string;
      talker: string;
      canonicalTarget: string;
      targetKind: WapTargetKind;
      displayName: string;
    }
  | { ok: false; code: WapSendFailureCode; error: string }
> {
  const accountId = normalizeAccountId(params.accountId);
  const content = params.content.trim();
  if (!content) {
    return {
      ok: false,
      code: "send_failed",
      error: "Missing WeChat message content",
    };
  }
  const preflight = await preflightCanonicalTarget({
    target: params.target,
    accountId,
  });
  if (!preflight.ok) {
    return preflight;
  }
  const command: WapSendTextCommand = {
    type: "send_text",
    data: {
      talker: preflight.target.talker,
      content,
      ...(params.replyToMessageId && params.replyToMessageId > 0 ? { reply_to_msg_id: params.replyToMessageId } : {}),
    },
  };
  const result = await sendCommandToClient({
    command,
    accountId,
  });
  if (!result.ok) {
    return {
      ok: false,
      ...mapCommandFailure(result),
    };
  }
  return {
    ok: true,
    accountId,
    talker: preflight.target.talker,
    canonicalTarget: preflight.target.canonicalTarget,
    targetKind: preflight.target.targetKind,
    displayName: preflight.candidate.displayName,
  };
}

export async function sendWapMediaToCanonicalTarget(params: {
  target: string;
  source: string;
  kind: "image" | "file";
  accountId?: string | null;
  caption?: string | null;
  fileName?: string | null;
}): Promise<
  | {
      ok: true;
      accountId: string;
      talker: string;
      canonicalTarget: string;
      targetKind: WapTargetKind;
      commandType: "send_image" | "send_file";
      displayName: string;
    }
  | { ok: false; code: WapSendFailureCode; error: string }
> {
  const accountId = normalizeAccountId(params.accountId);
  const source = params.source.trim();
  if (!source) {
    return {
      ok: false,
      code: "send_failed",
      error: `Missing WeChat ${params.kind} source`,
    };
  }
  const preflight = await preflightCanonicalTarget({
    target: params.target,
    accountId,
  });
  if (!preflight.ok) {
    return preflight;
  }
  const command = await buildWapMediaCommand({
    source,
    talker: preflight.target.talker,
    accountId,
    caption: params.caption?.trim() || undefined,
    kind: params.kind,
    fileNameOverride: params.fileName?.trim() || undefined,
  });
  if (!command || (command.type !== "send_image" && command.type !== "send_file")) {
    return {
      ok: false,
      code: "send_failed",
      error: `Failed to prepare WeChat ${params.kind} payload from source: ${source}`,
    };
  }
  const result = await sendCommandToClient({
    command: command.type === "send_image"
      ? (command as WapSendImageCommand)
      : (command as WapSendFileCommand),
    accountId,
  });
  if (!result.ok) {
    return {
      ok: false,
      ...mapCommandFailure(result),
    };
  }
  return {
    ok: true,
    accountId,
    talker: preflight.target.talker,
    canonicalTarget: preflight.target.canonicalTarget,
    targetKind: preflight.target.targetKind,
    commandType: command.type,
    displayName: preflight.candidate.displayName,
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
