/**
 * X-VISION-INTEGRATE-001 — factual Vision context for AI Analyze / Enrich.
 *
 * Uses post.vision from X-VISION-ANALYZE-001.
 * Only status=ok semantic fields are evidence.
 * Does not score, classify, or invent visualValue.
 */

const { normalizeText, hashStable } = require("./ai-contract");

const VISION_CONTEXT_INSTRUCTIONS = `The input may include visionContext from a prior Vision stage.

Rules for visionContext:
- visualObservations are factual support produced by Vision from the supplied media
- visibleText is text actually readable in the media; use it only as visible text
- uncertainties are NOT facts; do not treat them as certain or fill them in
- Do not invent information beyond the original post text and supplied visual evidence
- Do not identify people, locations, events, or organizations unless they are written in the post text or visibleText
- Do not use authorName / authorHandle to identify anyone in the media
- Video/GIF visualObservations describe a poster/frame only, not the full video
- If the original post text is empty or very short, judge from the visual evidence rather than treating the post as empty
- Do not add a visual quality score, media bonus, or extra importance for having images`;

function hasUsableVisionContext(post) {
  return Boolean(
    post &&
      typeof post === "object" &&
      post.vision &&
      typeof post.vision === "object" &&
      post.vision.status === "ok"
  );
}

function nullableNormalized(value) {
  if (value == null) return null;
  const text = normalizeText(value);
  return text || null;
}

/**
 * Semantic Vision evidence only. Null for skipped / failed / absent / empty.
 */
function getVisionFactualContext(post) {
  if (!hasUsableVisionContext(post)) return null;
  const observations = normalizeText(post.vision.observations);
  if (!observations) return null;
  return {
    observations,
    visibleText: nullableNormalized(post.vision.visibleText),
    uncertainties: nullableNormalized(post.vision.uncertainties),
  };
}

function computeVisionFingerprint(post) {
  const ctx = getVisionFactualContext(post);
  if (!ctx) return null;
  return hashStable({
    observations: ctx.observations,
    visibleText: ctx.visibleText,
    uncertainties: ctx.uncertainties,
  });
}

function attachVisionFingerprint(base, post) {
  const payload = base && typeof base === "object" ? { ...base } : {};
  const visionFingerprint = computeVisionFingerprint(post);
  if (visionFingerprint != null) {
    payload.visionFingerprint = visionFingerprint;
  }
  return payload;
}

function attachVisionContextToPayload(payload, post) {
  const next = payload && typeof payload === "object" ? { ...payload } : {};
  const ctx = getVisionFactualContext(post);
  if (!ctx) return next;
  next.visionContext = {
    visualObservations: ctx.observations,
    visibleText: ctx.visibleText,
    uncertainties: ctx.uncertainties,
  };
  return next;
}

function resolveVisionAwarePromptVersion(baseVersion, post) {
  const base = String(baseVersion || "1");
  if (!getVisionFactualContext(post)) return base;
  return `${base}.vision`;
}

function withVisionInstructions(systemPrompt, post) {
  const base = String(systemPrompt || "");
  if (!getVisionFactualContext(post)) return base;
  return `${base}\n\n${VISION_CONTEXT_INSTRUCTIONS}`;
}

module.exports = {
  VISION_CONTEXT_INSTRUCTIONS,
  hasUsableVisionContext,
  getVisionFactualContext,
  computeVisionFingerprint,
  attachVisionFingerprint,
  attachVisionContextToPayload,
  resolveVisionAwarePromptVersion,
  withVisionInstructions,
};
