const {
  parsePostedAtMs,
  formatLocalDate,
} = require("./date-range");
const { getCategoryOrder } = require("./categories");
const {
  getEditorCategory,
  getImportance,
  buildEditorView,
} = require("./editor-core");

const UNNAMED_LABEL = "(unnamed concept)";
const MAX_KEY_TOKENS = 5;
const LABEL_TAG_LIMIT = 3;
const LABEL_SUMMARY_LEN = 60;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"']+/gi;

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

function isTooGenericConceptToken(token) {
  const value = String(token || "").trim();
  if (!value) return true;
  if (isSymbolOnly(value)) return true;
  const lower = value.toLowerCase();
  if (/^[a-z0-9]+$/i.test(lower) && lower.length <= 2) return true;
  return false;
}

function normalizeConceptToken(token) {
  return stripUrls(String(token || "").trim().replace(/\s+/g, " ")).toLowerCase();
}

function dedupeTokensPreserveDisplay(rawTokens) {
  const seen = new Set();
  const normalized = [];
  const display = [];
  for (const raw of rawTokens) {
    const cleaned = String(raw || "").trim().replace(/\s+/g, " ");
    if (!cleaned) continue;
    const key = normalizeConceptToken(cleaned);
    if (!key || isTooGenericConceptToken(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
    display.push(cleaned);
  }
  const order = normalized
    .map((token, index) => ({ token, display: display[index] }))
    .sort((a, b) => a.token.localeCompare(b.token, "ja"));
  return {
    tokens: order.map((item) => item.token),
    displayTags: order.map((item) => item.display),
  };
}

function extractTokensFromSummary(summary) {
  const value = stripUrls(summary).replace(/\s+/g, " ").trim().toLowerCase();
  if (!value || isSymbolOnly(value) || value === "(no summary)") return [];

  const spaced = value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && !isTooGenericConceptToken(token));

  if (spaced.length >= 2) {
    return [...new Set(spaced.slice(0, MAX_KEY_TOKENS))].sort((a, b) =>
      a.localeCompare(b, "ja")
    );
  }

  if (spaced.length === 1 && [...spaced[0]].length >= 4) {
    return [spaced[0]];
  }

  const compact = value.replace(/\s+/g, "");
  if ([...compact].length >= 8) {
    return [[...compact].slice(0, 40).join("")];
  }

  return [];
}

function isCategoryOnlyKey(tokens, category) {
  if (!category || tokens.length !== 1) return false;
  return tokens[0] === normalizeConceptToken(category);
}

/**
 * Build a continuing-theme Concept Key from an Editor Topic.
 * Not the same as Topic Key. Returns null conceptKey on singleton fallback.
 */
function buildConceptKey(topic) {
  const keySources = [];
  const topicTags = Array.isArray(topic.tags) ? topic.tags : [];
  let { tokens, displayTags } = dedupeTokensPreserveDisplay(topicTags);

  if (tokens.length > 0) {
    keySources.push("tags");
  } else {
    const summaryTokens = extractTokensFromSummary(topic.summary);
    ({ tokens, displayTags } = dedupeTokensPreserveDisplay(summaryTokens));
    if (tokens.length > 0) {
      keySources.push("summary");
    }
  }

  // Avoid category-only keys and never use Topic Key / URL as the meaning key.
  if (tokens.length > 0 && isCategoryOnlyKey(tokens, topic.category)) {
    tokens = [];
    displayTags = [];
    keySources.length = 0;
  }

  if (tokens.length > 0) {
    const limited = tokens.slice(0, MAX_KEY_TOKENS);
    return {
      conceptKey: `concept:${limited.join("|")}`,
      identityKey: `concept:${limited.join("|")}`,
      singletonFallback: false,
      keySources,
      keyTokens: limited,
      keyDisplayTags: displayTags.slice(0, MAX_KEY_TOKENS),
    };
  }

  const topicKey = String(topic.topicKey || "");
  const identityKey = `concept:singleton:topic:${topicKey || "unknown"}`;
  return {
    conceptKey: null,
    identityKey,
    singletonFallback: true,
    keySources: [],
    keyTokens: [],
    keyDisplayTags: [],
  };
}

function truncateLabel(text, maxLen) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if ([...value].length <= maxLen) return value;
  return `${[...value].slice(0, maxLen).join("")}…`;
}

function selectConceptLabel(topics, keyInfo) {
  const mergedTags = mergeConceptTags(topics);
  if (mergedTags.length > 0) {
    return mergedTags.slice(0, LABEL_TAG_LIMIT).join(" / ");
  }

  if (keyInfo.keyDisplayTags.length > 0) {
    return keyInfo.keyDisplayTags.slice(0, LABEL_TAG_LIMIT).join(" / ");
  }

  const bestTopic = sortTopicsInConcept(topics)[0];
  if (bestTopic) {
    const summary = String(bestTopic.summary || "").trim();
    if (summary && summary !== "(no summary)") {
      const label = truncateLabel(summary, LABEL_SUMMARY_LEN);
      if (label) return label;
    }
  }

  if (keyInfo.conceptKey) {
    return keyInfo.conceptKey.replace(/^concept:/, "");
  }

  return UNNAMED_LABEL;
}

function sortTopicsForSummary(topics) {
  return [...topics]
    .map((topic, index) => ({ topic, index }))
    .sort((a, b) => {
      if (a.topic.maxImportance !== b.topic.maxImportance) {
        return b.topic.maxImportance - a.topic.maxImportance;
      }
      const aNewest = topicNewestMs(a.topic);
      const bNewest = topicNewestMs(b.topic);
      if (aNewest == null && bNewest == null) {
        /* fall through */
      } else if (aNewest == null) {
        return 1;
      } else if (bNewest == null) {
        return -1;
      } else if (aNewest !== bNewest) {
        return bNewest - aNewest;
      }
      return a.index - b.index;
    })
    .map((item) => item.topic);
}

function selectConceptSummary(topics) {
  const sorted = sortTopicsForSummary(topics);
  if (sorted.length === 0) return "(no summary)";
  return sorted[0].summary || "(no summary)";
}

function localDateFromPostedAt(postedAt) {
  const ms = parsePostedAtMs(postedAt);
  if (ms == null) return null;
  return formatLocalDate(new Date(ms));
}

function calculateActiveDays(posts) {
  const dates = new Set();
  for (const post of posts) {
    const day = localDateFromPostedAt(post.postedAt);
    if (day) dates.add(day);
  }
  const activeDates = [...dates].sort();
  return { activeDays: activeDates.length, activeDates };
}

function deduplicateConceptPosts(topics) {
  const posts = [];
  const seenUrls = new Set();
  let originalIndex = 0;

  for (const topic of topics) {
    for (const post of topic.posts || []) {
      const url = String(post.url || "").trim();
      if (url) {
        if (seenUrls.has(url)) {
          originalIndex += 1;
          continue;
        }
        seenUrls.add(url);
      }
      posts.push({
        post,
        index: originalIndex,
        importance: getImportance(post),
        postedAtMs: parsePostedAtMs(post.postedAt),
      });
      originalIndex += 1;
    }
  }

  return posts;
}

function sortPostsInConcept(entries) {
  return [...entries].sort((a, b) => {
    const aTime = a.postedAtMs;
    const bTime = b.postedAtMs;
    if (aTime == null && bTime == null) {
      /* fall through */
    } else if (aTime == null) {
      return 1;
    } else if (bTime == null) {
      return -1;
    } else if (aTime !== bTime) {
      return bTime - aTime;
    }

    if (a.importance !== b.importance) return b.importance - a.importance;
    return a.index - b.index;
  });
}

function topicNewestMs(topic) {
  return parsePostedAtMs(topic.newestPostedAt);
}

function sortTopicsInConcept(topics) {
  return [...topics]
    .map((topic, index) => ({ topic, index }))
    .sort((a, b) => {
      const aNewest = topicNewestMs(a.topic);
      const bNewest = topicNewestMs(b.topic);
      if (aNewest == null && bNewest == null) {
        /* fall through */
      } else if (aNewest == null) {
        return 1;
      } else if (bNewest == null) {
        return -1;
      } else if (aNewest !== bNewest) {
        return bNewest - aNewest;
      }

      if (a.topic.maxImportance !== b.topic.maxImportance) {
        return b.topic.maxImportance - a.topic.maxImportance;
      }
      if (a.topic.postCount !== b.topic.postCount) {
        return b.topic.postCount - a.topic.postCount;
      }
      return a.index - b.index;
    })
    .map((item) => item.topic);
}

function categoryRank(category, categoryOrder) {
  const index = categoryOrder.indexOf(category);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function selectDominantCategory(topics, posts, categoryOrder) {
  const stats = new Map();

  for (const post of posts) {
    const category = getEditorCategory(post);
    const current = stats.get(category) || {
      category,
      postCount: 0,
      maxImportance: 0,
    };
    current.postCount += 1;
    current.maxImportance = Math.max(current.maxImportance, getImportance(post));
    stats.set(category, current);
  }

  // Ensure topic-only categories still appear if somehow posts empty
  for (const topic of topics) {
    if (!stats.has(topic.category)) {
      stats.set(topic.category, {
        category: topic.category,
        postCount: 0,
        maxImportance: topic.maxImportance || 0,
      });
    }
  }

  const ranked = [...stats.values()].sort((a, b) => {
    if (a.postCount !== b.postCount) return b.postCount - a.postCount;
    if (a.maxImportance !== b.maxImportance) return b.maxImportance - a.maxImportance;
    return categoryRank(a.category, categoryOrder) - categoryRank(b.category, categoryOrder);
  });

  const categories = {};
  for (const item of ranked) {
    categories[item.category] = item.postCount;
  }

  const dominant = ranked[0] || { category: "その他", postCount: 0, maxImportance: 0 };
  return {
    category: dominant.category,
    categories,
    dominantReason: {
      postCount: dominant.postCount,
      maxImportance: dominant.maxImportance,
      categoryOrderIndex: categoryRank(dominant.category, categoryOrder),
    },
  };
}

function mergeConceptTags(topics) {
  const seen = new Set();
  const tags = [];
  for (const topic of topics) {
    for (const tag of topic.tags || []) {
      const cleaned = String(tag || "").trim().replace(/\s+/g, " ");
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(cleaned);
    }
  }
  return tags;
}

function buildConceptFromTopics(groupTopicsList, keySeed, categoryOrder, groupIndex) {
  const topics = sortTopicsInConcept(groupTopicsList);
  const postEntries = sortPostsInConcept(deduplicateConceptPosts(topics));
  const posts = postEntries.map((entry) => entry.post);

  let sumImportance = 0;
  let maxImportance = 0;
  let newestPostedAt = null;
  let oldestPostedAt = null;
  let newestMs = null;
  let oldestMs = null;

  for (const entry of postEntries) {
    sumImportance += entry.importance;
    if (entry.importance > maxImportance) maxImportance = entry.importance;
    if (entry.postedAtMs != null) {
      if (newestMs == null || entry.postedAtMs > newestMs) {
        newestMs = entry.postedAtMs;
        newestPostedAt = entry.post.postedAt || null;
      }
      if (oldestMs == null || entry.postedAtMs < oldestMs) {
        oldestMs = entry.postedAtMs;
        oldestPostedAt = entry.post.postedAt || null;
      }
    }
  }

  // Prefer key info from first non-singleton topic; else first
  const keyInfo =
    topics.map((topic) => buildConceptKey(topic)).find((info) => !info.singletonFallback) ||
    keySeed;

  const { activeDays, activeDates } = calculateActiveDays(posts);
  const categoryInfo = selectDominantCategory(topics, posts, categoryOrder);
  const label = selectConceptLabel(topics, keyInfo);
  const summary = selectConceptSummary(topics);

  const concept = {
    conceptKey: keyInfo.conceptKey,
    label,
    category: categoryInfo.category,
    categories: categoryInfo.categories,
    tags: mergeConceptTags(topics),
    summary,
    topics,
    topicCount: topics.length,
    posts,
    postCount: posts.length,
    maxImportance,
    averageImportance: posts.length
      ? Math.round((sumImportance / posts.length) * 10) / 10
      : 0,
    newestPostedAt,
    oldestPostedAt,
    activeDays,
  };

  const explanation = {
    keySources: keyInfo.keySources,
    keyTokens: keyInfo.keyTokens,
    humanTagsUsed: keyInfo.keyDisplayTags,
    topicKeys: topics.map((topic) => topic.topicKey),
    dominantCategory: categoryInfo.category,
    dominantCategoryReason: categoryInfo.dominantReason,
    activeDates,
    singletonFallback: keyInfo.singletonFallback,
    identityKey: keyInfo.identityKey,
  };

  return {
    concept,
    explanation,
    _newestMs: newestMs,
    _groupIndex: groupIndex,
  };
}

/**
 * Group Editor Topics into Concepts by Concept Key.
 */
function groupConcepts(topics, categoryOrder = getCategoryOrder()) {
  const groups = new Map();
  const seeds = new Map();

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    const keyInfo = buildConceptKey(topic);
    const groupKey = keyInfo.singletonFallback
      ? `${keyInfo.identityKey}#${i}`
      : keyInfo.identityKey;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
      seeds.set(groupKey, keyInfo);
    }
    groups.get(groupKey).push(topic);
  }

  return [...groups.entries()].map(([groupKey, groupTopicsList], index) =>
    buildConceptFromTopics(groupTopicsList, seeds.get(groupKey), categoryOrder, index)
  );
}

function sortConcepts(items) {
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.concept.activeDays !== b.item.concept.activeDays) {
        return b.item.concept.activeDays - a.item.concept.activeDays;
      }
      if (a.item.concept.topicCount !== b.item.concept.topicCount) {
        return b.item.concept.topicCount - a.item.concept.topicCount;
      }
      if (a.item.concept.maxImportance !== b.item.concept.maxImportance) {
        return b.item.concept.maxImportance - a.item.concept.maxImportance;
      }

      const aNewest = a.item._newestMs;
      const bNewest = b.item._newestMs;
      if (aNewest == null && bNewest == null) {
        /* fall through */
      } else if (aNewest == null) {
        return 1;
      } else if (bNewest == null) {
        return -1;
      } else if (aNewest !== bNewest) {
        return bNewest - aNewest;
      }

      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

function conceptContainsCategories(concept, categories) {
  if (!categories || categories.length === 0) return true;

  for (const wanted of categories) {
    if (Object.prototype.hasOwnProperty.call(concept.categories, wanted)) {
      if (concept.categories[wanted] > 0) return true;
    }
    // Also match via topic categories even if post aggregation missed
    if (concept.topics.some((topic) => topic.category === wanted)) return true;
    if (concept.posts.some((post) => getEditorCategory(post) === wanted)) return true;
  }
  return false;
}

/**
 * Build Concept Library from posts via Editor Topics.
 * Date filtering is applied through Editor View; concept filters apply after grouping.
 */
function buildConceptLibrary(posts, options = {}, range = { hasRange: false }) {
  const categoryOrder = options.categoryOrder || getCategoryOrder();

  // Editor builds Topics for the date range only (no category/limit here).
  const editorView = buildEditorView(posts, {}, range);
  const grouped = groupConcepts(editorView.topics, categoryOrder);
  let items = sortConcepts(grouped);

  const categories = Array.isArray(options.categories)
    ? options.categories.filter(Boolean)
    : options.category != null
      ? [options.category]
      : [];

  items = items.filter((item) => {
    if (!conceptContainsCategories(item.concept, categories)) return false;
    if (options.minDays != null && item.concept.activeDays < options.minDays) {
      return false;
    }
    if (options.minTopics != null && item.concept.topicCount < options.minTopics) {
      return false;
    }
    return true;
  });

  const totalConcepts = items.length;
  if (options.limit != null) {
    items = items.slice(0, options.limit);
  }

  return {
    concepts: items.map((item) => {
      const { _newestMs, _groupIndex, ...rest } = item;
      return rest;
    }),
    totalConcepts,
    totalTopics: editorView.totalTopics,
    totalPosts: editorView.totalPosts,
  };
}

module.exports = {
  UNNAMED_LABEL,
  buildConceptKey,
  selectConceptLabel,
  selectConceptSummary,
  calculateActiveDays,
  deduplicateConceptPosts,
  groupConcepts,
  sortConcepts,
  buildConceptLibrary,
  conceptContainsCategories,
};
