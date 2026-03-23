type MediaDetails = {
  mediaUrl?: unknown;
  mediaUrls?: unknown;
};

type MediaPayloadLike = {
  mediaUrl?: unknown;
  mediaUrls?: unknown;
  details?: {
    media?: MediaDetails | null;
  } | null;
} | null | undefined;

function normalizeSingleMedia(raw: unknown): string[] {
  return typeof raw === "string" && raw.trim() ? [raw.trim()] : [];
}

function normalizeMediaList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry): entry is string => Boolean(entry));
}

export function resolveReplyMediaUrls(payload: MediaPayloadLike): string[] {
  const structuredMedia =
    payload?.details?.media && typeof payload.details.media === "object"
      ? payload.details.media
      : undefined;
  const mediaList = [
    ...normalizeMediaList(structuredMedia?.mediaUrls),
    ...normalizeSingleMedia(structuredMedia?.mediaUrl),
  ];
  if (mediaList.length > 0) {
    return mediaList;
  }
  return [
    ...normalizeMediaList(payload?.mediaUrls),
    ...normalizeSingleMedia(payload?.mediaUrl),
  ];
}
