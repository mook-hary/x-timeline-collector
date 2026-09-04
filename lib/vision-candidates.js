/**
 * X-VISION-CANDIDATES-001 — deterministic V1 Vision routing.
 *
 * Decides only whether a collected X post should later be sent to Vision.
 * Does not call Vision, fetch images, score posts, or mutate inputs.
 *
 * V1 rule:
 *   usable media count > 0
 *   AND Unicode text length <= threshold
 *
 * Default threshold: 40 (VISION_TEXT_THRESHOLD, integer >= 0).
 */

const { canonicalizeMediaList } = require("./tweet-media");

const DEFAULT_VISION_TEXT_THRESHOLD = 40;
const VISION_TEXT_THRESHOLD_ENV = "VISION_TEXT_THRESHOLD";

const VISION_CANDIDATE_REASONS = Object.freeze({
  SHORT_TEXT_WITH_MEDIA: "short_text_with_media",
  NO_USABLE_MEDIA: "no_usable_media",
  TEXT_OVER_THRESHOLD: "text_over_threshold",
});

function unicodeTextLength(value) {
  return [...String(value ?? "")].length;
}

function resolveVisionTextThreshold(options = {}, env = process.env) {
  if (options && Object.prototype.hasOwnProperty.call(options, "threshold")) {
    return requireValidThreshold(options.threshold, "options.threshold");
  }
  const raw = env && env[VISION_TEXT_THRESHOLD_ENV];
  if (raw == null || raw === "") {
    return DEFAULT_VISION_TEXT_THRESHOLD;
  }
  const parsed = parseThreshold(raw);
  if (parsed == null) {
    return DEFAULT_VISION_TEXT_THRESHOLD;
  }
  return parsed;
}

function parseThreshold(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) return null;
    return value;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function requireValidThreshold(value, label) {
  const parsed = parseThreshold(value);
  if (parsed == null) {
    const err = new Error(
      `${label} must be an integer >= 0 (got ${JSON.stringify(value)})`
    );
    err.code = "VISION_TEXT_THRESHOLD_INVALID";
    throw err;
  }
  return parsed;
}

/**
 * Usable Vision image source under the existing media contract.
 * image: sanitized url or previewUrl
 * video/gif: sanitized previewUrl (poster)
 * unknown / no safe URL: not usable
 */
function isUsableVisionMedia(item) {
  const list = canonicalizeMediaList(item ? [item] : []);
  const media = list[0];
  if (!media) return false;
  if (media.type === "image") {
    return Boolean(media.url || media.previewUrl);
  }
  if (media.type === "video" || media.type === "gif") {
    return Boolean(media.previewUrl);
  }
  return false;
}

function usableVisionMedia(post) {
  const list = canonicalizeMediaList(post && post.media);
  return list.filter(isUsableVisionMedia);
}

function evaluateVisionCandidate(post, options = {}) {
  const threshold = resolveVisionTextThreshold(options, options.env);
  const text = post && typeof post === "object" ? post.text : "";
  const textLength = unicodeTextLength(text);
  const usable = usableVisionMedia(post && typeof post === "object" ? post : null);
  const mediaCount = usable.length;

  if (mediaCount === 0) {
    return {
      candidate: false,
      reason: VISION_CANDIDATE_REASONS.NO_USABLE_MEDIA,
      textLength,
      mediaCount,
      threshold,
    };
  }

  if (textLength > threshold) {
    return {
      candidate: false,
      reason: VISION_CANDIDATE_REASONS.TEXT_OVER_THRESHOLD,
      textLength,
      mediaCount,
      threshold,
    };
  }

  return {
    candidate: true,
    reason: VISION_CANDIDATE_REASONS.SHORT_TEXT_WITH_MEDIA,
    textLength,
    mediaCount,
    threshold,
  };
}

function buildVisionCandidates(posts, options = {}) {
  const list = Array.isArray(posts) ? posts : [];
  return list.map((post) => ({
    post,
    ...evaluateVisionCandidate(post, options),
  }));
}

module.exports = {
  DEFAULT_VISION_TEXT_THRESHOLD,
  VISION_TEXT_THRESHOLD_ENV,
  VISION_CANDIDATE_REASONS,
  unicodeTextLength,
  resolveVisionTextThreshold,
  isUsableVisionMedia,
  usableVisionMedia,
  evaluateVisionCandidate,
  buildVisionCandidates,
};
