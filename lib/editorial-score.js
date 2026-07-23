/**
 * EP-027 — Deterministic editorialScore for "what to read today".
 * Pure functions only. No OpenAI. No Reader/UI/digest ranking side effects.
 */

const AD_CATEGORY = "広告・PR";
const OTHER_CATEGORY = "その他";

/** High-signal categories (aligned with digest interest, not a re-ranker). */
const CATEGORY_BONUS = Object.freeze({
  AI: 12,
  "アニメ・漫画": 12,
  "ゲーム・ゲーム開発": 10,
  "イラスト・美術": 10,
  "プログラミング・IT": 10,
  "合気道・武道": 10,
  "仕事・キャリア": 10,
  "政治・社会": 8,
  "ニュース・報道": 8,
  "生活・健康": 6,
  "エンタメ・イベント": 4,
  "日常・雑談": 2,
});

const AD_PENALTY = 40;
const OTHER_PENALTY = 10;
const MISSING_URL_PENALTY = 6;
const VALID_URL_BONUS = 5;
const DIGEST_TOP_BONUS = 20;

/**
 * @param {object} post
 * @returns {string}
 */
function getCategory(post) {
  if (post == null || typeof post !== "object") return OTHER_CATEGORY;
  if (post.category) return String(post.category);
  if (post.finalAnalysis?.category) return String(post.finalAnalysis.category);
  if (post.analysis?.category) return String(post.analysis.category);
  return OTHER_CATEGORY;
}

/**
 * @param {object} post
 * @returns {number|null} null when importance is absent / not a finite number
 */
function getImportanceOrNull(post) {
  if (post == null || typeof post !== "object") return null;
  const raw =
    post.importance != null
      ? post.importance
      : post.enrichment?.importance;
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.min(5, Math.max(0, value));
}

function getSummary(post) {
  if (post == null || typeof post !== "object") return "";
  const summary =
    post.summary != null ? post.summary : post.enrichment?.summary;
  return String(summary || "").trim();
}

function getReason(post) {
  if (post == null || typeof post !== "object") return "";
  const reason =
    post.reason != null ? post.reason : post.enrichment?.reason;
  return String(reason || "").trim();
}

function getTags(post) {
  if (post == null || typeof post !== "object") return [];
  const fromPost = Array.isArray(post.tags) ? post.tags : [];
  const fromFinal = Array.isArray(post.finalAnalysis?.tags)
    ? post.finalAnalysis.tags
    : [];
  const fromEnrich = Array.isArray(post.enrichment?.tags)
    ? post.enrichment.tags
    : [];
  const seen = new Set();
  const out = [];
  for (const tag of [...fromPost, ...fromFinal, ...fromEnrich]) {
    const cleaned = String(tag || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function getUrl(post) {
  if (post == null || typeof post !== "object") return "";
  return String(post.url || "").trim();
}

function isValidHttpUrl(url) {
  return /^https?:\/\/\S+/i.test(String(url || "").trim());
}

function isPlaceholderSummary(summary) {
  const value = String(summary || "").trim();
  if (!value) return true;
  return value === "要約なし";
}

/**
 * Optional digest-selection context (existing data only).
 * @typedef {{
 *   digestSelected?: boolean,
 *   personalScore?: number,
 * }} EditorialScoreContext
 */

/**
 * Deterministic editorial score for a single post.
 * Works without importance. Does not mutate input.
 *
 * @param {object} post
 * @param {EditorialScoreContext} [context]
 * @returns {number}
 */
function scoreEditorialPost(post, context = {}) {
  let score = 0;

  const importance = getImportanceOrNull(post);
  if (importance != null) {
    // Present importance still helps, but absence is allowed.
    score += importance * 10;
  } else {
    // Mild base so non-enriched posts remain comparable.
    score += 5;
  }

  const summary = getSummary(post);
  if (!isPlaceholderSummary(summary)) {
    score += 18;
    const len = summary.length;
    if (len >= 20) score += 6;
    if (len >= 40) score += 6;
    if (len >= 70) score += 4;
  }

  const reason = getReason(post);
  if (reason) {
    score += 8;
    if (reason.length >= 20) score += 4;
  }

  const tags = getTags(post);
  score += Math.min(10, tags.length * 2);

  const category = getCategory(post);
  if (category === AD_CATEGORY) {
    score -= AD_PENALTY;
  } else if (category === OTHER_CATEGORY) {
    score -= OTHER_PENALTY;
  } else if (Object.prototype.hasOwnProperty.call(CATEGORY_BONUS, category)) {
    score += CATEGORY_BONUS[category];
  } else {
    // Unknown categories: slight caution, not as harsh as その他.
    score -= 4;
  }

  const url = getUrl(post);
  if (isValidHttpUrl(url)) {
    score += VALID_URL_BONUS;
  } else {
    score -= MISSING_URL_PENALTY;
  }

  const digestSelected =
    context.digestSelected === true ||
    post?.digestSelected === true ||
    post?._digestSelected === true;
  if (digestSelected) {
    score += DIGEST_TOP_BONUS;
  }

  const personalScoreRaw =
    context.personalScore != null
      ? context.personalScore
      : post?.personalScore;
  const personalScore = Number(personalScoreRaw);
  if (Number.isFinite(personalScore) && personalScore > 0) {
    // Cap so personalScore does not dominate editorialScore.
    score += Math.min(15, Math.round(personalScore * 0.25));
  }

  return score;
}

/**
 * Drop duplicate URLs (and empty-URL collisions by index order).
 * Keeps the first occurrence in input order.
 * Posts without URL are kept (each unique empty slot by index).
 *
 * @param {object[]} posts
 * @returns {object[]}
 */
function excludeDuplicateEditorialPosts(posts) {
  const list = Array.isArray(posts) ? posts : [];
  const seen = new Set();
  const out = [];
  for (const post of list) {
    const url = getUrl(post);
    if (url) {
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(post);
  }
  return out;
}

/**
 * Score + dedupe + stable sort (desc score, then input index).
 * Pure: does not mutate posts.
 *
 * @param {object[]} posts
 * @param {EditorialScoreContext|((post: object, index: number) => EditorialScoreContext)} [contextOrFn]
 * @returns {{ post: object, editorialScore: number, index: number }[]}
 */
function rankEditorialPosts(posts, contextOrFn = {}) {
  const deduped = excludeDuplicateEditorialPosts(posts);
  const scored = deduped.map((post, index) => {
    const context =
      typeof contextOrFn === "function"
        ? contextOrFn(post, index) || {}
        : contextOrFn;
    return {
      post,
      index,
      editorialScore: scoreEditorialPost(post, context),
    };
  });
  return scored.sort((a, b) => {
    if (a.editorialScore !== b.editorialScore) {
      return b.editorialScore - a.editorialScore;
    }
    return a.index - b.index;
  });
}

module.exports = {
  AD_CATEGORY,
  OTHER_CATEGORY,
  AD_PENALTY,
  OTHER_PENALTY,
  DIGEST_TOP_BONUS,
  CATEGORY_BONUS,
  scoreEditorialPost,
  excludeDuplicateEditorialPosts,
  rankEditorialPosts,
  getCategory,
  getImportanceOrNull,
  getSummary,
  getReason,
  getTags,
  getUrl,
};
