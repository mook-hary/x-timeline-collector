/**
 * EP-051 — Editorial similarity (local, deterministic).
 * Character bigram Dice coefficient over title+summary+body+tags.
 * No embeddings / external AI APIs.
 */
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_LIMIT = 10;
const NGRAM_SIZE = 2;

/**
 * Normalize text for comparison.
 * - Unicode NFKC
 * - lowercase
 * - trim / collapse whitespace
 * - strip punctuation/symbols (keep letters, numbers, marks, spaces)
 * @param {unknown} text
 * @returns {string}
 */
function normalizeText(text) {
  if (text == null) return "";
  let value = String(text);
  if (!value) return "";
  value = value.normalize("NFKC").toLowerCase();
  // Keep letters (incl. CJK), numbers, combining marks, whitespace.
  value = value.replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ");
  value = value.replace(/\s+/g, " ").trim();
  return value;
}

/**
 * Build comparable string from an editorial item.
 * @param {object|null|undefined} item
 * @returns {string}
 */
function buildComparableText(item) {
  if (!item || typeof item !== "object") return "";
  const parts = [];
  pushPart(parts, item.title);
  pushPart(parts, item.summary);
  pushPart(parts, item.body);
  if (Array.isArray(item.tags)) {
    for (const tag of item.tags) {
      pushPart(parts, tag);
    }
  }
  return normalizeText(parts.join(" "));
}

function pushPart(parts, value) {
  if (value == null) return;
  const s = String(value).trim();
  if (!s) return;
  parts.push(s);
}

/**
 * Multiset of character n-grams (default bigrams).
 * @param {string} text already normalized
 * @param {number} [n]
 * @returns {Map<string, number>}
 */
function charNgrams(text, n = NGRAM_SIZE) {
  const map = new Map();
  const s = String(text || "");
  if (!s) return map;
  if (s.length < n) {
    map.set(s, 1);
    return map;
  }
  for (let i = 0; i <= s.length - n; i++) {
    const gram = s.slice(i, i + n);
    map.set(gram, (map.get(gram) || 0) + 1);
  }
  return map;
}

function multisetSize(map) {
  let total = 0;
  for (const count of map.values()) total += count;
  return total;
}

function multisetIntersectionSize(a, b) {
  let total = 0;
  for (const [gram, countA] of a) {
    const countB = b.get(gram);
    if (countB) total += Math.min(countA, countB);
  }
  return total;
}

/**
 * Dice coefficient on character n-gram multisets. Result in [0, 1].
 * @param {string} textA normalized
 * @param {string} textB normalized
 * @returns {number}
 */
function diceCoefficient(textA, textB) {
  const a = String(textA || "");
  const b = String(textB || "");
  if (!a || !b) return 0;
  if (a === b) return 1;

  const gramsA = charNgrams(a);
  const gramsB = charNgrams(b);
  const sizeA = multisetSize(gramsA);
  const sizeB = multisetSize(gramsB);
  if (sizeA === 0 || sizeB === 0) return 0;

  const inter = multisetIntersectionSize(gramsA, gramsB);
  return (2 * inter) / (sizeA + sizeB);
}

/**
 * Similarity between two editorial items (0–1).
 * Empty comparable text on either side → 0 (never "similar").
 * @param {object} itemA
 * @param {object} itemB
 * @returns {number}
 */
function calculateSimilarity(itemA, itemB) {
  const a = buildComparableText(itemA);
  const b = buildComparableText(itemB);
  if (!a || !b) return 0;
  const score = diceCoefficient(a, b);
  // Clamp / round lightly for stable floats without changing ordering.
  if (score <= 0) return 0;
  if (score >= 1) return 1;
  return score;
}

/**
 * Find similar items against a candidate list.
 * @param {object} target
 * @param {object[]} items
 * @param {object} [options]
 * @param {number} [options.threshold=0.7]
 * @param {number} [options.limit=10]
 * @param {string} [options.excludeId]
 * @param {string} [options.source]
 * @param {string} [options.type]
 * @returns {{ item: object, similarity: number }[]}
 */
function findSimilarItems(target, items, options = {}) {
  const threshold =
    options.threshold == null ? DEFAULT_THRESHOLD : Number(options.threshold);
  const limit = options.limit == null ? DEFAULT_LIMIT : Number(options.limit);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    const err = new Error("threshold must be a number between 0 and 1");
    err.code = "editorial-similarity-options";
    throw err;
  }
  if (!Number.isFinite(limit) || limit < 0 || !Number.isInteger(limit)) {
    const err = new Error("limit must be a non-negative integer");
    err.code = "editorial-similarity-options";
    throw err;
  }

  const list = Array.isArray(items) ? items : [];
  const excludeId =
    options.excludeId != null && String(options.excludeId).trim()
      ? String(options.excludeId).trim()
      : null;
  const sourceFilter =
    options.source != null && String(options.source).trim()
      ? String(options.source).trim()
      : null;
  const typeFilter =
    options.type != null && String(options.type).trim()
      ? String(options.type).trim()
      : null;

  /** @type {{ item: object, similarity: number }[]} */
  const scored = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    if (excludeId != null && String(item.id) === excludeId) continue;
    if (sourceFilter != null && item.source !== sourceFilter) continue;
    if (typeFilter != null && item.type !== typeFilter) continue;

    const similarity = calculateSimilarity(target, item);
    if (similarity < threshold) continue;
    scored.push({ item, similarity });
  }

  scored.sort((a, b) => {
    if (a.similarity !== b.similarity) {
      return b.similarity - a.similarity;
    }
    return String(a.item.id || "").localeCompare(String(b.item.id || ""));
  });

  if (limit === 0) return [];
  return scored.slice(0, limit);
}

module.exports = {
  DEFAULT_THRESHOLD,
  DEFAULT_LIMIT,
  NGRAM_SIZE,
  normalizeText,
  buildComparableText,
  charNgrams,
  diceCoefficient,
  calculateSimilarity,
  findSimilarItems,
};
