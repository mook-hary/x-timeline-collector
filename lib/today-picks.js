/**
 * EP-039 — Today's Picks selection (post-score editorial frame).
 * Does not change editorialScore. Deterministic. No AI / no IO.
 */
const {
  getCategory,
  getImportanceOrNull,
  getSummary,
  getReason,
  getUrl,
  rankEditorialPosts,
} = require("./editorial-score");

/** Soft cap: ~half of picks (5 → 3). */
const CATEGORY_SOFT_CAP_RATIO = 0.6;
/** Near-duplicate similarity thresholds (constants in one place). */
const NEAR_DUP_TITLE_JACCARD = 0.72;
const NEAR_DUP_TITLE_OVERLAP = 0.7;
const NEAR_DUP_SUMMARY_JACCARD = 0.78;
const NEAR_DUP_SUMMARY_OVERLAP = 0.75;
const NEAR_DUP_BOTH_OVERLAP = 0.52;
const NEAR_DUP_ENTITY_TITLE_OVERLAP = 0.35;
const NEAR_DUP_ENTITY_SUMMARY_OVERLAP = 0.35;

const EVENT_MARKERS = [
  "発表",
  "公開",
  "リリース",
  "改定",
  "更新",
  "announce",
  "announcement",
  "release",
  "launch",
  "update",
];
/** Candidate must be at least this fraction of best score to fill soft-cap gaps. */
const QUALITY_FLOOR_RATIO = 0.62;
/** Score gap vs best beyond which soft diversity must not override. */
const QUALITY_FLOOR_GAP = 28;

const STOP_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "not",
  "but",
  "you",
  "your",
  "about",
  "into",
  "http",
  "https",
  "www",
  "com",
  "する",
  "した",
  "して",
  "される",
  "ある",
  "いる",
  "なる",
  "れる",
  "こと",
  "もの",
  "ため",
  "よう",
  "これ",
  "それ",
  "あれ",
  "ここ",
  "そこ",
  "関連",
  "投稿",
  "記事",
  "について",
  "として",
  "という",
  "など",
  "また",
  "そして",
  "または",
]);

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "s",
]);

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function categorySoftCap(limit) {
  const n = Math.max(0, Math.floor(toFiniteNumber(limit, 0)));
  if (n <= 0) return 0;
  return Math.max(1, Math.ceil(n * CATEGORY_SOFT_CAP_RATIO));
}

/**
 * Display text unchanged; comparison-only normalization.
 */
function normalizeArticleText(value) {
  let text = String(value || "");
  try {
    text = text.normalize("NFKC");
  } catch (_error) {
    // keep raw
  }
  text = text.toLowerCase();
  text = text.replace(/https?:\/\/\S+/gi, " ");
  text = text.replace(/www\.\S+/gi, " ");
  // Strip most emoji / symbols while keeping letters and CJK.
  text = text.replace(/[\u{1F300}-\u{1FAFF}]/gu, " ");
  text = text.replace(/[^\p{L}\p{N}\s]+/gu, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function normalizeArticleUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    let host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "twitter.com") host = "x.com";
    const params = new URLSearchParams();
    for (const [key, value] of parsed.searchParams.entries()) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
      params.append(key.toLowerCase(), value);
    }
    const query = params.toString();
    const path = parsed.pathname.replace(/\/+$/, "") || "";
    return `${parsed.protocol}//${host}${path}${query ? `?${query}` : ""}`;
  } catch (_error) {
    return raw
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, "")
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
  }
}

function extractStatusId(url) {
  const m = String(url || "").match(
    /(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i
  );
  return m ? m[1] : "";
}

function getAuthorKey(post) {
  const handle = String(
    post?.authorHandle || post?.enrichment?.authorHandle || ""
  )
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  if (handle) return handle;
  const name = String(post?.authorName || post?.enrichment?.authorName || "")
    .trim()
    .toLowerCase();
  if (name) return name;
  const url = getUrl(post);
  const m = url.match(/(?:x|twitter)\.com\/([^/?#]+)\/status\//i);
  if (m && m[1] && !["i", "intent", "share"].includes(m[1].toLowerCase())) {
    return m[1].toLowerCase();
  }
  return "";
}

function getDomainKey(post) {
  const url = getUrl(post);
  if (!url) return "";
  try {
    let host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "twitter.com") host = "x.com";
    return host;
  } catch (_error) {
    return "";
  }
}

function getTitleText(post) {
  const text = String(post?.text || "").trim();
  if (text) return text;
  const summary = getSummary(post);
  if (summary && summary !== "要約なし") return summary;
  return "";
}

function tokenizeForSimilarity(value) {
  const normalized = normalizeArticleText(value);
  if (!normalized) return new Set();
  const tokens = new Set();

  // Latin words (2+) and any digit runs (distinguish 製品1 vs 製品2).
  for (const m of normalized.matchAll(/[a-z]{2,}|\d+/g)) {
    const t = m[0];
    if (STOP_TOKENS.has(t)) continue;
    tokens.add(t);
  }

  // CJK chunk optionally glued to trailing digits: 固有要約0
  // Include prolonged sound mark (ー) so ツール stays one chunk.
  const cjkParts =
    normalized.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30FC\uFF66-\uFF9D]+(?:\d+)?/gu
    ) || [];
  for (const chunk of cjkParts) {
    if (chunk.length === 1) continue;
    if (chunk.length <= 6 && !STOP_TOKENS.has(chunk)) tokens.add(chunk);
    const pure = chunk.replace(/\d+$/, "");
    for (let i = 0; i < pure.length - 1; i++) {
      const bi = pure.slice(i, i + 2);
      if (STOP_TOKENS.has(bi)) continue;
      tokens.add(bi);
    }
  }

  return tokens;
}

function tokenSetSize(value) {
  return tokenizeForSimilarity(value).size;
}

/** True when overlap is meaningful (not a tiny subset match like {ai}). */
function meaningfulOverlap(a, b, score, threshold) {
  if (score < threshold) return false;
  return Math.min(tokenSetSize(a), tokenSetSize(b)) >= 3;
}

/**
 * When both sides name different products/ids, do not treat as near-dup
 * even if surrounding boilerplate overlaps.
 */
function hasConflictingDistinctors(aText, bText) {
  const left = normalizeArticleText(aText);
  const right = normalizeArticleText(bText);
  if (!left || !right) return false;

  const digitsA = new Set(left.match(/\d+/g) || []);
  const digitsB = new Set(right.match(/\d+/g) || []);
  if (
    digitsA.size > 0 &&
    digitsB.size > 0 &&
    tokenIntersectionSize(digitsA, digitsB) === 0
  ) {
    return true;
  }

  const latinA = latinEntities(left);
  const latinB = latinEntities(right);
  if (
    latinA.size > 0 &&
    latinB.size > 0 &&
    tokenIntersectionSize(latinA, latinB) === 0
  ) {
    return true;
  }

  // Single-letter product markers after 製品/product (e.g. 製品a vs 製品b).
  const markA = new Set(
    [...left.matchAll(/(?:製品|product)\s*([a-z0-9])/g)].map((m) => m[1])
  );
  const markB = new Set(
    [...right.matchAll(/(?:製品|product)\s*([a-z0-9])/g)].map((m) => m[1])
  );
  if (
    markA.size > 0 &&
    markB.size > 0 &&
    tokenIntersectionSize(markA, markB) === 0
  ) {
    return true;
  }

  return false;
}

function tokenIntersectionSize(left, right) {
  let inter = 0;
  for (const t of left) {
    if (right.has(t)) inter += 1;
  }
  return inter;
}

function calculateTextSimilarity(a, b) {
  const left = tokenizeForSimilarity(a);
  const right = tokenizeForSimilarity(b);
  if (left.size === 0 || right.size === 0) return 0;
  const inter = tokenIntersectionSize(left, right);
  const union = left.size + right.size - inter;
  if (union <= 0) return 0;
  return inter / union;
}

/** Overlap coefficient: |A∩B| / min(|A|,|B|). */
function calculateOverlapCoefficient(a, b) {
  const left = tokenizeForSimilarity(a);
  const right = tokenizeForSimilarity(b);
  if (left.size === 0 || right.size === 0) return 0;
  const inter = tokenIntersectionSize(left, right);
  const denom = Math.min(left.size, right.size);
  if (denom <= 0) return 0;
  return inter / denom;
}

function latinEntities(...parts) {
  const out = new Set();
  for (const part of parts) {
    for (const t of tokenizeForSimilarity(part)) {
      if (/^[a-z][a-z0-9]{2,}$/.test(t) && !STOP_TOKENS.has(t)) out.add(t);
    }
  }
  return out;
}

function sharedLatinEntityCount(aParts, bParts) {
  const left = latinEntities(...aParts);
  const right = latinEntities(...bParts);
  return tokenIntersectionSize(left, right);
}

function sharesEventMarker(aText, bText) {
  const left = normalizeArticleText(aText);
  const right = normalizeArticleText(bText);
  if (!left || !right) return false;
  for (const marker of EVENT_MARKERS) {
    if (left.includes(marker) && right.includes(marker)) return true;
  }
  return false;
}

function isExactDuplicate(a, b) {
  const urlA = normalizeArticleUrl(getUrl(a));
  const urlB = normalizeArticleUrl(getUrl(b));
  if (urlA && urlB && urlA === urlB) return true;

  const idA = extractStatusId(getUrl(a));
  const idB = extractStatusId(getUrl(b));
  if (idA && idB && idA === idB) return true;

  const titleA = normalizeArticleText(getTitleText(a));
  const titleB = normalizeArticleText(getTitleText(b));
  if (titleA && titleB && titleA === titleB) return true;

  return false;
}

function isNearDuplicate(a, b) {
  if (isExactDuplicate(a, b)) return true;

  const titleA = getTitleText(a);
  const titleB = getTitleText(b);
  const summaryA = getSummary(a);
  const summaryB = getSummary(b);
  const sameCategory = getCategory(a) === getCategory(b);
  const combinedA = `${titleA} ${summaryA}`;
  const combinedB = `${titleB} ${summaryB}`;
  const conflicting = hasConflictingDistinctors(combinedA, combinedB);

  const titleJac = calculateTextSimilarity(titleA, titleB);
  const titleOv = calculateOverlapCoefficient(titleA, titleB);
  const summaryJac = calculateTextSimilarity(summaryA, summaryB);
  const summaryOv = calculateOverlapCoefficient(summaryA, summaryB);

  if (
    !conflicting &&
    (titleJac >= NEAR_DUP_TITLE_JACCARD ||
      meaningfulOverlap(titleA, titleB, titleOv, NEAR_DUP_TITLE_OVERLAP))
  ) {
    return true;
  }
  if (
    !conflicting &&
    (summaryJac >= NEAR_DUP_SUMMARY_JACCARD ||
      meaningfulOverlap(
        summaryA,
        summaryB,
        summaryOv,
        NEAR_DUP_SUMMARY_OVERLAP
      ))
  ) {
    return true;
  }
  if (
    !conflicting &&
    sameCategory &&
    meaningfulOverlap(titleA, titleB, titleOv, NEAR_DUP_BOTH_OVERLAP) &&
    meaningfulOverlap(summaryA, summaryB, summaryOv, NEAR_DUP_BOTH_OVERLAP)
  ) {
    return true;
  }

  const sharedEntities = sharedLatinEntityCount(
    [titleA, summaryA],
    [titleB, summaryB]
  );
  const eventShared = sharesEventMarker(combinedA, combinedB);

  // Same product/event announcement rewritten by another account.
  if (
    sameCategory &&
    sharedEntities >= 2 &&
    eventShared &&
    (titleOv >= NEAR_DUP_ENTITY_TITLE_OVERLAP ||
      summaryOv >= NEAR_DUP_ENTITY_SUMMARY_OVERLAP)
  ) {
    return true;
  }
  if (
    sameCategory &&
    sharedEntities >= 2 &&
    !conflicting &&
    titleOv >= 0.45 &&
    summaryOv >= 0.4
  ) {
    return true;
  }

  return false;
}

function postedAtMs(post) {
  const raw = post?.postedAt || post?.enrichment?.postedAt || "";
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : 0;
}

function stableId(post, index) {
  const url = normalizeArticleUrl(getUrl(post));
  if (url) return url;
  const status = extractStatusId(getUrl(post));
  if (status) return `status:${status}`;
  return `idx:${index}`;
}

/**
 * Prefer higher score, then importance, summary, url, newer, stable id.
 */
function compareCandidates(a, b) {
  if (b.editorialScore !== a.editorialScore) {
    return b.editorialScore - a.editorialScore;
  }
  const impA = getImportanceOrNull(a.post);
  const impB = getImportanceOrNull(b.post);
  const ia = impA == null ? -1 : impA;
  const ib = impB == null ? -1 : impB;
  if (ib !== ia) return ib - ia;
  const sumA = getSummary(a.post) ? 1 : 0;
  const sumB = getSummary(b.post) ? 1 : 0;
  if (sumB !== sumA) return sumB - sumA;
  const urlA = getUrl(a.post) ? 1 : 0;
  const urlB = getUrl(b.post) ? 1 : 0;
  if (urlB !== urlA) return urlB - urlA;
  const timeA = postedAtMs(a.post);
  const timeB = postedAtMs(b.post);
  if (timeB !== timeA) return timeB - timeA;
  return String(a.stableId).localeCompare(String(b.stableId));
}

function selectRepresentativeArticle(candidates) {
  const list = Array.isArray(candidates) ? [...candidates] : [];
  if (list.length === 0) return null;
  list.sort(compareCandidates);
  return list[0];
}

function meetsQualityFloor(candidateScore, bestScore) {
  if (!(bestScore > 0)) return true;
  if (candidateScore >= bestScore * QUALITY_FLOOR_RATIO) return true;
  if (bestScore - candidateScore <= QUALITY_FLOOR_GAP) return true;
  return false;
}

function countBy(selected, keyFn, key) {
  if (!key) return 0;
  let n = 0;
  for (const item of selected) {
    if (keyFn(item.post) === key) n += 1;
  }
  return n;
}

/**
 * @param {Array<{post:object, editorialScore:number, index:number, stableId:string}>} ranked
 * @param {number} limit
 */
function selectTodayPicksFromRanked(ranked, limit) {
  const cap = Math.max(0, Math.floor(toFiniteNumber(limit, 0)));
  const list = Array.isArray(ranked) ? ranked : [];
  if (cap === 0 || list.length === 0) return [];

  const bestScore = list[0].editorialScore;
  const catCap = categorySoftCap(cap);

  function conflictsDuplicate(candidate, selected) {
    for (const item of selected) {
      if (isExactDuplicate(candidate.post, item.post)) return true;
      if (isNearDuplicate(candidate.post, item.post)) return true;
    }
    return false;
  }

  function tryPass(pass) {
    const selected = [];
    for (const candidate of list) {
      if (selected.length >= cap) break;
      if (conflictsDuplicate(candidate, selected)) continue;

      const category = getCategory(candidate.post);
      const catCount = countBy(selected, getCategory, category);
      const author = getAuthorKey(candidate.post);
      const authorCount = countBy(selected, getAuthorKey, author);
      const domain = getDomainKey(candidate.post);
      const domainCount = countBy(selected, getDomainKey, domain);
      const qualityOk = meetsQualityFloor(candidate.editorialScore, bestScore);

      if (pass === 1) {
        if (!qualityOk) continue;
        if (catCount >= catCap) continue;
        if (author && authorCount >= 1) continue;
        if (domain && domain !== "x.com" && domainCount >= 2) continue;
      } else if (pass === 2) {
        // Relax author/domain; keep soft category unless quality is strong.
        if (!qualityOk) continue;
        if (catCount >= catCap + 1) continue;
      } else {
        // Final fill: allow category repeat only for solid quality.
        if (!qualityOk) continue;
      }

      selected.push({
        ...candidate,
        selectionSignals: [
          "high-editorial-score",
          pass === 1 ? "primary-pass" : pass === 2 ? "soft-relax" : "fill-pass",
          catCount === 0 ? "category-diversity" : "category-repeat",
          "unique-topic",
        ],
      });
    }
    return selected;
  }

  let selected = tryPass(1);
  if (selected.length < cap) {
    const second = tryPass(2);
    if (second.length > selected.length) selected = second;
  }
  if (selected.length < cap) {
    const third = tryPass(3);
    if (third.length > selected.length) selected = third;
  }

  return balancePickOrder(selected);
}

/**
 * Keep score order; lightly break same-category adjacency when possible.
 */
function balancePickOrder(selected) {
  const list = Array.isArray(selected) ? selected.map((x) => ({ ...x })) : [];
  if (list.length < 3) return list;

  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i];
    const b = list[i + 1];
    if (getCategory(a.post) !== getCategory(b.post)) continue;

    let swapAt = -1;
    for (let j = i + 2; j < list.length; j++) {
      if (getCategory(list[j].post) === getCategory(a.post)) continue;
      // Only swap when scores are close (do not bury much stronger items).
      if (a.editorialScore - list[j].editorialScore > QUALITY_FLOOR_GAP) {
        continue;
      }
      swapAt = j;
      break;
    }
    if (swapAt < 0) continue;
    const tmp = list[i + 1];
    list[i + 1] = list[swapAt];
    list[swapAt] = tmp;
  }
  return list;
}

/**
 * Full pipeline: rank → select → map to pick records.
 *
 * @param {object[]} filteredPosts
 * @param {number} topN
 * @param {(post:object)=>object} [contextFn]
 * @returns {object[]}
 */
function selectTodayPicks(filteredPosts, topN, contextFn = null) {
  const limit = Math.max(0, Math.floor(toFiniteNumber(topN, 0)));
  const list = Array.isArray(filteredPosts) ? filteredPosts : [];
  if (limit === 0 || list.length === 0) return [];

  const rankedPosts = rankEditorialPosts(list, (post) => {
    if (typeof contextFn === "function") return contextFn(post) || {};
    return {};
  });

  const ranked = rankedPosts.map((item, index) => ({
    post: item.post,
    editorialScore: item.editorialScore,
    index,
    stableId: stableId(item.post, index),
  }));

  const selected = selectTodayPicksFromRanked(ranked, limit);

  return selected.map((item) => {
    const post = item.post;
    return {
      category: getCategory(post),
      summary: getSummary(post),
      text: String(post.text || "").trim(),
      reason: getReason(post),
      importance: getImportanceOrNull(post),
      url: getUrl(post),
      _editorialScore: item.editorialScore,
      // Dev-only signals; not rendered by Reader.
      _selectionSignals: item.selectionSignals,
    };
  });
}

module.exports = {
  CATEGORY_SOFT_CAP_RATIO,
  NEAR_DUP_TITLE_JACCARD,
  NEAR_DUP_TITLE_OVERLAP,
  NEAR_DUP_SUMMARY_JACCARD,
  NEAR_DUP_SUMMARY_OVERLAP,
  NEAR_DUP_BOTH_OVERLAP,
  QUALITY_FLOOR_RATIO,
  QUALITY_FLOOR_GAP,
  categorySoftCap,
  normalizeArticleText,
  normalizeArticleUrl,
  calculateTextSimilarity,
  calculateOverlapCoefficient,
  isExactDuplicate,
  isNearDuplicate,
  selectRepresentativeArticle,
  selectTodayPicksFromRanked,
  selectTodayPicks,
  balancePickOrder,
  tokenizeForSimilarity,
  getAuthorKey,
  getDomainKey,
  getTitleText,
  extractStatusId,
};
