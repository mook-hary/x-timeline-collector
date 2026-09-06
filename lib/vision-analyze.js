/**
 * X-VISION-ANALYZE-001 — isolated Vision analysis stage.
 *
 * Reuses X-VISION-CANDIDATES-001. Does not score, classify, enrich,
 * or write Vision into Analyze / News Feed.
 *
 * Role V1: content understanding only. Grounded visual observations.
 */

const {
  normalizeText,
  hashStable,
  matchesExecutionContract,
  buildCacheKey,
} = require("./ai-contract");
const {
  evaluateVisionCandidate,
  usableVisionMedia,
} = require("./vision-candidates");

const VISION_PROMPT_VERSION = "1";
const VISION_SCHEMA_VERSION = "1";
const VISION_SCHEMA_VERSION_NUMBER = 1;
const DEFAULT_VISION_MODEL = "gpt-5-mini";
const MAX_CONSECUTIVE_FAILURES = 3;

const VISION_ERROR = Object.freeze({
  IMAGE_UNAVAILABLE: "image_unavailable",
  INVALID_OUTPUT: "invalid_output",
  MODEL_FAILURE: "model_failure",
});

const VISION_GROUNDING_PROMPT = `You analyze supplied media for content understanding only.

Describe ONLY what is visibly supported by the supplied media.

Do NOT infer:
- a person's identity
- location
- event name
- organization identity unless visibly written
- poster/account identity
- relationship between people
- intent
- hidden context
- political affiliation
- sensitive attributes

Do not use the X post author as evidence for image identity.

Visible text: return only text that can actually be read in the media.
If no text is readable, visibleText must be null.

If uncertain, put it in uncertainties rather than guessing. Do not guess.

observations: visible facts only, concise, approximately 1–3 sentences.

The post text, if provided, is context for the media relationship only.
It must not authorize unsupported visual claims.
Keep visual observations grounded in the image, not in the text.

Return only the specified JSON.`;

const VIDEO_POSTER_NOTE =
  "This is only a poster/frame from a video or GIF.\nDo not infer what happens in the full video.";

const VISION_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["observations", "visibleText", "uncertainties"],
  properties: {
    observations: {
      type: "string",
      description: "Visible facts only, concise, about 1–3 sentences",
    },
    visibleText: {
      type: ["string", "null"],
      description: "Text actually readable in the media, or null",
    },
    uncertainties: {
      type: ["string", "null"],
      description: "Ambiguity or unreadable content only, or null",
    },
  },
};

function emptyVisionResult() {
  return {
    schemaVersion: VISION_SCHEMA_VERSION_NUMBER,
    status: "skipped",
    skipReason: null,
    observations: null,
    visibleText: null,
    uncertainties: null,
    mediaCountAnalyzed: 0,
    mediaIdentities: [],
    model: null,
    promptVersion: VISION_PROMPT_VERSION,
    analyzedAt: null,
  };
}

function skippedVision(skipReason) {
  return {
    ...emptyVisionResult(),
    status: "skipped",
    skipReason: skipReason == null ? null : String(skipReason),
  };
}

function failedVision(model) {
  return {
    ...emptyVisionResult(),
    status: "failed",
    skipReason: null,
    model: model || null,
  };
}

function cloneMediaIdentities(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => ({
    hostname: String(item.hostname || ""),
    pathname: String(item.pathname || ""),
    format: String(item.format || ""),
  }));
}

function buildVisionMediaIdentity(url) {
  if (url == null || url === "") return null;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (_error) {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const format = parsed.searchParams.get("format");
  return {
    hostname: String(parsed.hostname || "").toLowerCase(),
    pathname: parsed.pathname || "",
    format: format == null ? "" : String(format),
  };
}

function resolveUsableMediaUrl(media) {
  if (!media || typeof media !== "object") return null;
  if (media.type === "image") {
    return media.url || media.previewUrl || null;
  }
  if (media.type === "video" || media.type === "gif") {
    return media.previewUrl || null;
  }
  return null;
}

function collectUsableVisionInputs(post) {
  const usable = usableVisionMedia(post);
  const inputs = [];
  for (const media of usable) {
    const url = resolveUsableMediaUrl(media);
    if (!url) continue;
    const identity = buildVisionMediaIdentity(url);
    if (!identity) continue;
    inputs.push({
      type: media.type,
      url,
      identity,
      isPoster: media.type === "video" || media.type === "gif",
    });
  }
  return inputs;
}

function computeVisionInputFingerprint(post, mediaInputs) {
  const identities = (mediaInputs || []).map((item) => ({
    hostname: item.identity.hostname,
    pathname: item.identity.pathname,
    format: item.identity.format,
  }));
  return hashStable({
    text: normalizeText(post && post.text),
    mediaIdentities: identities,
  });
}

function buildVisionExecutionContract(post, mediaInputs, model) {
  return {
    inputFingerprint: computeVisionInputFingerprint(post, mediaInputs),
    model: model || DEFAULT_VISION_MODEL,
    promptVersion: VISION_PROMPT_VERSION,
    schemaVersion: VISION_SCHEMA_VERSION,
  };
}

function buildVisionUserText(post, mediaInputs) {
  const text = post && post.text != null ? String(post.text) : "";
  const lines = [
    "POST TEXT (context only — not visual evidence).",
    "Do not treat this text as proof of identity, location, event, or organization.",
    "Do not use poster/account identity to identify anyone in the media.",
    "---",
    text,
    "---",
    "MEDIA (canonical order):",
  ];
  const hasPoster = (mediaInputs || []).some((item) => item.isPoster);
  if (hasPoster) {
    lines.push(VIDEO_POSTER_NOTE);
  }
  (mediaInputs || []).forEach((item, index) => {
    const kind = item.isPoster
      ? `${item.type} poster/frame only`
      : item.type;
    lines.push(`${index + 1}. ${kind}`);
  });
  return lines.join("\n");
}

function buildVisionRequestInput(post, mediaInputs) {
  const content = [
    {
      type: "input_text",
      text: buildVisionUserText(post, mediaInputs),
    },
  ];
  for (const item of mediaInputs || []) {
    content.push({
      type: "input_image",
      image_url: item.url,
    });
  }
  return [
    {
      role: "user",
      content,
    },
  ];
}

function nullableText(value) {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeVisionModelOutput(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const err = new Error("Vision response is not an object");
    err.code = VISION_ERROR.INVALID_OUTPUT;
    throw err;
  }
  if (typeof parsed.observations !== "string" || !parsed.observations.trim()) {
    const err = new Error("Vision observations missing");
    err.code = VISION_ERROR.INVALID_OUTPUT;
    throw err;
  }
  const visibleText = nullableText(parsed.visibleText);
  const uncertainties = nullableText(parsed.uncertainties);
  if (visibleText === undefined || uncertainties === undefined) {
    const err = new Error("Vision visibleText/uncertainties have invalid type");
    err.code = VISION_ERROR.INVALID_OUTPUT;
    throw err;
  }
  return {
    observations: parsed.observations.trim(),
    visibleText,
    uncertainties,
  };
}

function classifyVisionError(error) {
  if (error && error.code && Object.values(VISION_ERROR).includes(error.code)) {
    return error.code;
  }
  const message = error && error.message ? String(error.message) : String(error);
  if (/image|media|download|fetch|unavailable|timeout/i.test(message)) {
    return VISION_ERROR.IMAGE_UNAVAILABLE;
  }
  return VISION_ERROR.MODEL_FAILURE;
}

function isValidOkVisionResult(result) {
  return Boolean(
    result &&
      typeof result === "object" &&
      result.status === "ok" &&
      result.schemaVersion === VISION_SCHEMA_VERSION_NUMBER &&
      typeof result.observations === "string" &&
      result.observations &&
      (result.visibleText == null || typeof result.visibleText === "string") &&
      (result.uncertainties == null || typeof result.uncertainties === "string") &&
      Array.isArray(result.mediaIdentities) &&
      typeof result.model === "string" &&
      result.model &&
      result.promptVersion === VISION_PROMPT_VERSION
  );
}

function getVisionCacheResult(value) {
  if (value && value.result && typeof value.result === "object") {
    return value.result;
  }
  return null;
}

function findMatchingVisionCacheEntry(cache, contract) {
  const cacheKey = buildCacheKey(contract);
  const entry = cache && cache[cacheKey];
  if (!entry) return { cacheKey, entry: null };
  if (!matchesExecutionContract(entry, contract)) {
    return { cacheKey, entry: null };
  }
  const result = getVisionCacheResult(entry);
  if (!isValidOkVisionResult(result)) {
    return { cacheKey, entry: null };
  }
  return { cacheKey, entry };
}

function writeVisionCacheEntry(cache, cacheKey, contract, result, cachedAt) {
  cache[cacheKey] = {
    inputFingerprint: contract.inputFingerprint,
    model: contract.model,
    promptVersion: contract.promptVersion,
    schemaVersion: contract.schemaVersion,
    result: {
      schemaVersion: result.schemaVersion,
      status: "ok",
      skipReason: null,
      observations: result.observations,
      visibleText: result.visibleText,
      uncertainties: result.uncertainties,
      mediaCountAnalyzed: result.mediaCountAnalyzed,
      mediaIdentities: cloneMediaIdentities(result.mediaIdentities),
      model: result.model,
      promptVersion: result.promptVersion,
      analyzedAt: result.analyzedAt,
    },
    cachedAt,
    createdAt: cachedAt,
    lastUsedAt: cachedAt,
    useCount: 1,
  };
}

function touchVisionCacheEntry(cache, cacheKey, usedAt) {
  const entry = cache[cacheKey];
  if (!entry) return;
  entry.lastUsedAt = usedAt;
  entry.useCount = (Number(entry.useCount) || 0) + 1;
}

function clonePostWithVision(post, vision) {
  return {
    ...(post && typeof post === "object" ? post : {}),
    vision,
  };
}

function candidateRow(post, decision, mediaInputs) {
  const url = post && post.url ? String(post.url) : "";
  const statusMatch = url.match(/status\/(\d+)/);
  return {
    id: statusMatch ? statusMatch[1] : url || "(no-id)",
    author:
      (post && (post.authorHandle || post.authorName)) ||
      "@unknown",
    textLength: decision.textLength,
    mediaCount: mediaInputs.length,
    mediaTypes: mediaInputs.map((item) => item.type),
  };
}

function attachOkVision(model, mediaInputs, normalized, analyzedAt) {
  return {
    schemaVersion: VISION_SCHEMA_VERSION_NUMBER,
    status: "ok",
    skipReason: null,
    observations: normalized.observations,
    visibleText: normalized.visibleText,
    uncertainties: normalized.uncertainties,
    mediaCountAnalyzed: mediaInputs.length,
    mediaIdentities: cloneMediaIdentities(mediaInputs.map((item) => item.identity)),
    model,
    promptVersion: VISION_PROMPT_VERSION,
    analyzedAt,
  };
}

/**
 * Analyze posts. Never mutates source posts. Never filters/sorts/dedupes.
 * Non-candidates: skipped, no API. Candidates: one request with all usable media.
 */
async function analyzeVisionPosts(posts, options = {}) {
  const list = Array.isArray(posts) ? posts : [];
  const dryRun = Boolean(options.dryRun);
  const model = options.model || DEFAULT_VISION_MODEL;
  const cache = options.cache && typeof options.cache === "object" ? options.cache : {};
  const requestFn = typeof options.requestFn === "function" ? options.requestFn : null;
  const nowFn =
    typeof options.now === "function" ? options.now : () => new Date().toISOString();
  const maxConsecutiveFailures =
    Number.isInteger(options.maxConsecutiveFailures) &&
    options.maxConsecutiveFailures >= 1
      ? options.maxConsecutiveFailures
      : MAX_CONSECUTIVE_FAILURES;
  const candidateOptions = options.candidateOptions || {};

  const out = [];
  const requests = [];
  const candidates = [];
  const internalErrors = [];
  let apiRequestCount = 0;
  let cacheHitCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let okCount = 0;
  let consecutiveFailures = 0;
  let aborted = false;
  let usableMediaInputCount = 0;

  for (const post of list) {
    const decision = evaluateVisionCandidate(post, candidateOptions);
    const mediaInputs = collectUsableVisionInputs(post);
    usableMediaInputCount += mediaInputs.length;

    if (!decision.candidate) {
      skippedCount += 1;
      out.push(clonePostWithVision(post, skippedVision(decision.reason)));
      continue;
    }

    candidates.push(candidateRow(post, decision, mediaInputs));

    if (dryRun) {
      out.push(clonePostWithVision(post, skippedVision("dry_run")));
      continue;
    }

    if (mediaInputs.length === 0) {
      skippedCount += 1;
      out.push(clonePostWithVision(post, skippedVision("no_usable_media")));
      continue;
    }

    const contract = buildVisionExecutionContract(post, mediaInputs, model);
    const { cacheKey, entry: cached } = findMatchingVisionCacheEntry(cache, contract);
    if (cached) {
      const usedAt = nowFn();
      touchVisionCacheEntry(cache, cacheKey, usedAt);
      const result = getVisionCacheResult(cached);
      cacheHitCount += 1;
      okCount += 1;
      consecutiveFailures = 0;
      out.push(clonePostWithVision(post, { ...result }));
      continue;
    }

    if (aborted || !requestFn) {
      failedCount += 1;
      if (!requestFn && !aborted) {
        internalErrors.push({
          category: VISION_ERROR.MODEL_FAILURE,
          message: "Vision request function is not configured",
        });
      }
      out.push(clonePostWithVision(post, failedVision(model)));
      continue;
    }

    const request = {
      model,
      instructions: VISION_GROUNDING_PROMPT,
      input: buildVisionRequestInput(post, mediaInputs),
      schema: VISION_RESPONSE_SCHEMA,
      mediaUrls: mediaInputs.map((item) => item.url),
      mediaIdentities: cloneMediaIdentities(mediaInputs.map((item) => item.identity)),
    };
    requests.push(request);
    apiRequestCount += 1;

    try {
      const raw = await requestFn(request);
      const normalized = normalizeVisionModelOutput(raw);
      const analyzedAt = nowFn();
      const vision = attachOkVision(model, mediaInputs, normalized, analyzedAt);
      writeVisionCacheEntry(cache, cacheKey, contract, vision, analyzedAt);
      okCount += 1;
      consecutiveFailures = 0;
      out.push(clonePostWithVision(post, vision));
    } catch (error) {
      failedCount += 1;
      consecutiveFailures += 1;
      const category = classifyVisionError(error);
      internalErrors.push({
        category,
        message: error && error.message ? String(error.message) : String(error),
      });
      out.push(clonePostWithVision(post, failedVision(model)));
      if (consecutiveFailures >= maxConsecutiveFailures) {
        aborted = true;
      }
    }
  }

  return {
    posts: out,
    cache,
    requests,
    internalErrors,
    aborted,
    summary: {
      inputCount: list.length,
      outputCount: out.length,
      candidates: candidates.length,
      skipped: skippedCount,
      ok: okCount,
      failed: failedCount,
      usableMediaInputs: usableMediaInputCount,
      expectedVisionRequests: dryRun ? candidates.length : undefined,
      apiRequests: apiRequestCount,
      cacheHits: cacheHitCount,
      dryRun,
      model,
      candidateRows: candidates,
    },
  };
}

function buildDailyVisionArtifact(input, posts, extra = {}) {
  if (Array.isArray(input)) return posts;
  return {
    ...input,
    itemCount: posts.length,
    posts,
    visionStage: {
      schemaVersion: VISION_SCHEMA_VERSION_NUMBER,
      promptVersion: VISION_PROMPT_VERSION,
      ...extra,
    },
  };
}

module.exports = {
  VISION_PROMPT_VERSION,
  VISION_SCHEMA_VERSION,
  VISION_SCHEMA_VERSION_NUMBER,
  DEFAULT_VISION_MODEL,
  MAX_CONSECUTIVE_FAILURES,
  VISION_ERROR,
  VISION_GROUNDING_PROMPT,
  VIDEO_POSTER_NOTE,
  VISION_RESPONSE_SCHEMA,
  emptyVisionResult,
  skippedVision,
  failedVision,
  buildVisionMediaIdentity,
  collectUsableVisionInputs,
  computeVisionInputFingerprint,
  buildVisionExecutionContract,
  buildVisionUserText,
  buildVisionRequestInput,
  normalizeVisionModelOutput,
  classifyVisionError,
  findMatchingVisionCacheEntry,
  writeVisionCacheEntry,
  analyzeVisionPosts,
  buildDailyVisionArtifact,
  evaluateVisionCandidate,
};
