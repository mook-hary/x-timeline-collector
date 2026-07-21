const { parsePostedAtMs, isPostedAtInLocalRange } = require("./date-range");

const DEFAULT_TOPIC_CAP = 1;

const DEFAULT_DIGEST_CONFIG = {
  categoryWeights: {
    AI: 5,
    "アニメ・漫画": 5,
    "イラスト・美術": 4,
    "ゲーム・ゲーム開発": 5,
    "プログラミング・IT": 4,
    "合気道・武道": 4,
    "仕事・キャリア": 4,
    "政治・社会": 3,
    "ニュース・報道": 3,
    "生活・健康": 3,
    "エンタメ・イベント": 2,
    "広告・PR": 0,
    "日常・雑談": 1,
    その他: 1,
  },
  topMinimumImportance: 3,
  topExcludedCategories: ["広告・PR"],
  maxPostsPerCategoryInTop: 3,
  maxPostsPerAuthorInTop: 2,
  categoryDisplayLimit: 3,
  topicCap: DEFAULT_TOPIC_CAP,
};

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"']+/gi;

/** Canonical category for digest with migration-safe fallback. */
function getDigestCategory(post) {
  if (post.finalAnalysis?.category) return post.finalAnalysis.category;
  if (post.analysis?.category) return post.analysis.category;
  return "その他";
}

function getImportance(post) {
  const value = Number(post.enrichment?.importance);
  if (!Number.isFinite(value)) return 0;
  return Math.min(5, Math.max(0, value));
}

function getCategoryWeight(category, config) {
  if (Object.prototype.hasOwnProperty.call(config.categoryWeights, category)) {
    return Number(config.categoryWeights[category]) || 0;
  }
  return 1;
}

function getPersonalScore(post, config) {
  const importance = getImportance(post);
  const categoryWeight = getCategoryWeight(getDigestCategory(post), config);
  return importance * 10 + categoryWeight * 3;
}

function getAuthorKey(post) {
  const handle = String(post.authorHandle || "").trim();
  if (handle) return `handle:${handle.toLowerCase()}`;
  const name = String(post.authorName || "").trim();
  if (name) return `name:${name.toLowerCase()}`;
  return null;
}

function cleanTag(tag) {
  let value = String(tag || "").trim().replace(/\s+/g, " ");
  value = value.replace(/^["'「」『』\[\]()（）]+/, "");
  value = value.replace(/["'「」『』\[\]()（）]+$/, "");
  value = value.trim().replace(/\s+/g, " ");
  return value;
}

/** Display tags: finalAnalysis then enrichment (existing digest display order). */
function mergeDisplayTags(post) {
  const tags = [
    ...(Array.isArray(post.finalAnalysis?.tags) ? post.finalAnalysis.tags : []),
    ...(Array.isArray(post.enrichment?.tags) ? post.enrichment.tags : []),
  ]
    .map(cleanTag)
    .filter(Boolean);

  const seen = new Set();
  const unique = [];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(tag);
  }
  return unique.slice(0, 8);
}

function stripUrls(text) {
  return String(text || "")
    .replace(URL_IN_TEXT_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasLetterOrNumber(text) {
  return /[\p{L}\p{N}]/u.test(String(text || ""));
}

function isSymbolOnly(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  return !hasLetterOrNumber(value);
}

function isTooGenericTopicToken(token) {
  const value = String(token || "").trim();
  if (!value) return true;
  if (isSymbolOnly(value)) return true;
  const lower = value.toLowerCase();
  // Short ASCII tokens are too generic; single CJK characters can be meaningful.
  if (/^[a-z0-9]+$/i.test(lower) && lower.length <= 2) return true;
  return false;
}

function normalizeTopicToken(token) {
  return stripUrls(cleanTag(token)).toLowerCase();
}

/** Human tags for topic keys: enrichment first, then finalAnalysis. */
function getTopicTags(post) {
  const raw = [
    ...(Array.isArray(post.enrichment?.tags) ? post.enrichment.tags : []),
    ...(Array.isArray(post.finalAnalysis?.tags) ? post.finalAnalysis.tags : []),
  ];
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    const normalized = normalizeTopicToken(item);
    if (!normalized || isTooGenericTopicToken(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  tags.sort((a, b) => a.localeCompare(b, "ja"));
  return tags;
}

function extractLinkedResourceKey(text) {
  const matches = String(text || "").match(URL_IN_TEXT_RE) || [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[),.;]+$/g, "");
    let parsed;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (!host || host === "x.com" || host === "twitter.com" || host === "t.co") {
      continue;
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    const key = `link:${host}${path}`.slice(0, 120);
    if (key.length > 6) return key;
  }
  return null;
}

function textTopicKey(text) {
  let value = stripUrls(text);
  if (!value) return null;
  value = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (!value || isSymbolOnly(value)) return null;

  const spacedTokens = value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && !isTooGenericTopicToken(token));

  if (spacedTokens.length >= 2) {
    const picked = spacedTokens.slice(0, 6).sort((a, b) => a.localeCompare(b, "ja"));
    return `text:${picked.join("|")}`.slice(0, 160);
  }

  if (spacedTokens.length === 1 && [...spacedTokens[0]].length >= 4) {
    return `text:${spacedTokens[0]}`.slice(0, 160);
  }

  // Japanese / continuous text without useful whitespace splits
  const compact = value.replace(/\s+/g, "");
  if ([...compact].length >= 8) {
    return `text:${[...compact].slice(0, 40).join("")}`;
  }

  return null;
}

/**
 * Lightweight topic key for digest diversity. Not a persistent identity.
 * @returns {string|null}
 */
function buildTopicKey(post) {
  const tags = getTopicTags(post);
  if (tags.length > 0) {
    return `tags:${tags.join("|")}`.slice(0, 160);
  }

  const summaryKey = textTopicKey(post.enrichment?.summary);
  if (summaryKey) return summaryKey;

  const bodyKey = textTopicKey(post.text);
  if (bodyKey) return bodyKey;

  const linked = extractLinkedResourceKey(
    `${post.enrichment?.summary || ""}\n${post.text || ""}`
  );
  if (linked) return linked;

  return null;
}

function mergeDigestConfig(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const categoryWeights =
    data.categoryWeights && typeof data.categoryWeights === "object" && !Array.isArray(data.categoryWeights)
      ? { ...DEFAULT_DIGEST_CONFIG.categoryWeights, ...data.categoryWeights }
      : { ...DEFAULT_DIGEST_CONFIG.categoryWeights };

  const topExcludedCategories = Array.isArray(data.topExcludedCategories)
    ? data.topExcludedCategories.map(String)
    : [...DEFAULT_DIGEST_CONFIG.topExcludedCategories];

  const topicCapRaw = data.topicCap;
  const topicCap =
    topicCapRaw == null || topicCapRaw === ""
      ? DEFAULT_DIGEST_CONFIG.topicCap
      : Number(topicCapRaw);

  return {
    categoryWeights,
    topMinimumImportance: Number.isFinite(Number(data.topMinimumImportance))
      ? Number(data.topMinimumImportance)
      : DEFAULT_DIGEST_CONFIG.topMinimumImportance,
    topExcludedCategories,
    maxPostsPerCategoryInTop: Number.isFinite(Number(data.maxPostsPerCategoryInTop))
      ? Number(data.maxPostsPerCategoryInTop)
      : DEFAULT_DIGEST_CONFIG.maxPostsPerCategoryInTop,
    maxPostsPerAuthorInTop: Number.isFinite(Number(data.maxPostsPerAuthorInTop))
      ? Number(data.maxPostsPerAuthorInTop)
      : DEFAULT_DIGEST_CONFIG.maxPostsPerAuthorInTop,
    categoryDisplayLimit: Number.isFinite(Number(data.categoryDisplayLimit))
      ? Number(data.categoryDisplayLimit)
      : DEFAULT_DIGEST_CONFIG.categoryDisplayLimit,
    topicCap: Number.isFinite(topicCap) && topicCap >= 1 ? Math.floor(topicCap) : DEFAULT_DIGEST_CONFIG.topicCap,
  };
}

function matchesDigestFilters(post, options, range) {
  if (!isPostedAtInLocalRange(post.postedAt, range)) {
    return false;
  }

  if (options.category != null && getDigestCategory(post) !== options.category) {
    return false;
  }

  if (options.minImportance != null) {
    if (getImportance(post) < options.minImportance) return false;
  }

  return true;
}

function compareByImportanceThenDate(a, b) {
  const aImp = getImportance(a.post);
  const bImp = getImportance(b.post);
  if (aImp !== bImp) return bImp - aImp;

  const aTime = parsePostedAtMs(a.post.postedAt);
  const bTime = parsePostedAtMs(b.post.postedAt);
  if (aTime == null && bTime == null) return a.index - b.index;
  if (aTime == null) return 1;
  if (bTime == null) return -1;
  if (aTime !== bTime) return bTime - aTime;
  return a.index - b.index;
}

function sortPostsByImportance(posts) {
  return posts
    .map((post, index) => ({ post, index }))
    .sort(compareByImportanceThenDate)
    .map((item) => item.post);
}

function buildDigestCandidate(post, index, config) {
  const category = getDigestCategory(post);
  const importance = getImportance(post);
  const categoryWeight = getCategoryWeight(category, config);
  return {
    post,
    index,
    category,
    importance,
    categoryWeight,
    personalScore: importance * 10 + categoryWeight * 3,
    authorKey: getAuthorKey(post),
    topicKey: buildTopicKey(post),
    url: String(post.url || "").trim(),
  };
}

function sortCandidatesByPersonalScore(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.personalScore !== b.personalScore) return b.personalScore - a.personalScore;
    if (a.importance !== b.importance) return b.importance - a.importance;

    const aTime = parsePostedAtMs(a.post.postedAt);
    const bTime = parsePostedAtMs(b.post.postedAt);
    if (aTime == null && bTime == null) return a.index - b.index;
    if (aTime == null) return 1;
    if (bTime == null) return -1;
    if (aTime !== bTime) return bTime - aTime;
    return a.index - b.index;
  });
}

function isTopEligible(candidate, config) {
  if (candidate.importance < config.topMinimumImportance) return false;
  if (config.topExcludedCategories.includes(candidate.category)) return false;
  return true;
}

/**
 * Select top digest posts with category/author/topic caps.
 * Pass 1 enforces topicCap; pass 2 relaxes only topicCap if still short.
 */
function selectTopPosts(posts, top, config) {
  const eligible = [];
  for (let i = 0; i < posts.length; i++) {
    const candidate = buildDigestCandidate(posts[i], i, config);
    if (isTopEligible(candidate, config)) {
      eligible.push(candidate);
    }
  }

  const candidates = sortCandidatesByPersonalScore(eligible);
  const selected = [];
  const selectedIndexes = new Set();
  const seenUrls = new Set();
  const categoryCounts = new Map();
  const authorCounts = new Map();
  const topicCounts = new Map();

  function canTake(candidate, relaxTopic) {
    if (selectedIndexes.has(candidate.index)) return false;

    if (candidate.url && seenUrls.has(candidate.url)) return false;

    const categoryCount = categoryCounts.get(candidate.category) || 0;
    if (categoryCount >= config.maxPostsPerCategoryInTop) return false;

    if (candidate.authorKey) {
      const authorCount = authorCounts.get(candidate.authorKey) || 0;
      if (authorCount >= config.maxPostsPerAuthorInTop) return false;
    }

    if (!relaxTopic && candidate.topicKey) {
      const topicCount = topicCounts.get(candidate.topicKey) || 0;
      if (topicCount >= config.topicCap) return false;
    }

    return true;
  }

  function take(candidate, selectionPass, topicCapRelaxed) {
    const nextCategoryCount = (categoryCounts.get(candidate.category) || 0) + 1;
    let nextAuthorCount = null;
    if (candidate.authorKey) {
      nextAuthorCount = (authorCounts.get(candidate.authorKey) || 0) + 1;
    }
    let nextTopicCount = null;
    if (candidate.topicKey) {
      nextTopicCount = (topicCounts.get(candidate.topicKey) || 0) + 1;
    }

    selected.push({
      post: candidate.post,
      selection: {
        selectedRank: selected.length + 1,
        personalScore: candidate.personalScore,
        importance: candidate.importance,
        category: candidate.category,
        categoryWeight: candidate.categoryWeight,
        authorKey: candidate.authorKey,
        authorUsage: nextAuthorCount,
        topicKey: candidate.topicKey,
        topicUsage: nextTopicCount,
        selectionPass,
        topicCapRelaxed,
      },
    });

    selectedIndexes.add(candidate.index);
    if (candidate.url) seenUrls.add(candidate.url);
    categoryCounts.set(candidate.category, nextCategoryCount);
    if (candidate.authorKey) authorCounts.set(candidate.authorKey, nextAuthorCount);
    if (candidate.topicKey) topicCounts.set(candidate.topicKey, nextTopicCount);
  }

  for (const candidate of candidates) {
    if (selected.length >= top) break;
    if (!canTake(candidate, false)) continue;
    take(candidate, 1, false);
  }

  if (selected.length < top) {
    for (const candidate of candidates) {
      if (selected.length >= top) break;
      if (!canTake(candidate, true)) continue;
      take(candidate, 2, true);
    }
  }

  return {
    selected,
    candidates,
    categoryCounts,
    authorCounts,
    topicCounts,
  };
}

function countMapToObject(map) {
  const out = {};
  for (const [key, value] of map.entries()) {
    out[key] = value;
  }
  return out;
}

function buildDigestStats(selectionResult) {
  const { selected, candidates, categoryCounts, authorCounts, topicCounts } = selectionResult;
  let topicRelaxedCount = 0;
  let missingTopicKeyCount = 0;

  for (const item of selected) {
    if (item.selection.topicCapRelaxed) topicRelaxedCount += 1;
    if (!item.selection.topicKey) missingTopicKeyCount += 1;
  }

  return {
    selectedCount: selected.length,
    candidateCount: candidates.length,
    categoryCounts: countMapToObject(categoryCounts),
    authorCounts: countMapToObject(authorCounts),
    topicCounts: countMapToObject(topicCounts),
    topicRelaxedCount,
    missingTopicKeyCount,
  };
}

/**
 * Filter + sort candidates for category listing; select top with caps.
 */
function buildDigestSelection(posts, options, range, config) {
  const filtered = [];
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    if (matchesDigestFilters(post, options, range)) {
      filtered.push(post);
    }
  }

  const sortedFiltered = sortPostsByImportance(filtered);
  const selectionResult = selectTopPosts(sortedFiltered, options.top, config);
  const stats = buildDigestStats(selectionResult);

  return {
    filtered: sortedFiltered,
    topSelected: selectionResult.selected,
    candidates: selectionResult.candidates,
    stats,
  };
}

module.exports = {
  DEFAULT_DIGEST_CONFIG,
  DEFAULT_TOPIC_CAP,
  getDigestCategory,
  getImportance,
  getCategoryWeight,
  getPersonalScore,
  getAuthorKey,
  mergeDisplayTags,
  cleanTag,
  buildTopicKey,
  mergeDigestConfig,
  matchesDigestFilters,
  sortPostsByImportance,
  buildDigestCandidate,
  sortCandidatesByPersonalScore,
  selectTopPosts,
  buildDigestStats,
  buildDigestSelection,
};
