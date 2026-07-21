const { parsePostedAtMs, isPostedAtInLocalRange } = require("./date-range");
const { buildTopicKey } = require("./digest-core");

const NO_SUMMARY = "(no summary)";
const TEXT_PREFIX_LEN = 120;

/** Same category fallback as search/digest: finalAnalysis → analysis → その他 */
function getEditorCategory(post) {
  if (post.finalAnalysis?.category) return post.finalAnalysis.category;
  if (post.analysis?.category) return post.analysis.category;
  return "その他";
}

function getImportance(post) {
  const value = Number(post.enrichment?.importance);
  if (!Number.isFinite(value)) return 0;
  return Math.min(5, Math.max(0, value));
}

function cleanTag(tag) {
  let value = String(tag || "").trim().replace(/\s+/g, " ");
  value = value.replace(/^["'「」『』\[\]()（）]+/, "");
  value = value.replace(/["'「」『』\[\]()（）]+$/, "");
  return value.trim().replace(/\s+/g, " ");
}

/** Human tags only: enrichment.tags then finalAnalysis.tags. No matchedKeywords. */
function getHumanTags(post) {
  const raw = [
    ...(Array.isArray(post.enrichment?.tags) ? post.enrichment.tags : []),
    ...(Array.isArray(post.finalAnalysis?.tags) ? post.finalAnalysis.tags : []),
  ];
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    const tag = cleanTag(item);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function mergeTopicTags(posts) {
  const seen = new Set();
  const tags = [];
  for (const post of posts) {
    for (const tag of getHumanTags(post)) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}

function buildPostSummary(post) {
  const enrichmentSummary = String(post.enrichment?.summary || "").trim();
  if (enrichmentSummary) return enrichmentSummary;

  const text = String(post.text || "").trim().replace(/\s+/g, " ");
  if (text) {
    if ([...text].length <= TEXT_PREFIX_LEN) return text;
    return `${[...text].slice(0, TEXT_PREFIX_LEN).join("")}…`;
  }

  return NO_SUMMARY;
}

/**
 * Digest と同じ Topic Key 契約。生成不能時は一投稿＝一 Topic。
 * @returns {string}
 */
function getTopicKey(post, index = 0) {
  const shared = buildTopicKey(post);
  if (shared) return shared;

  const url = String(post.url || "").trim();
  if (url) return `singleton:${url}`;
  return `singleton:index:${index}`;
}

function comparePostsInTopic(a, b) {
  if (a.importance !== b.importance) return b.importance - a.importance;

  const aTime = a.postedAtMs;
  const bTime = b.postedAtMs;
  if (aTime == null && bTime == null) return a.index - b.index;
  if (aTime == null) return 1;
  if (bTime == null) return -1;
  if (aTime !== bTime) return bTime - aTime;
  return a.index - b.index;
}

function sortPostsInTopic(entries) {
  return [...entries].sort(comparePostsInTopic);
}

function buildTopicFromEntries(topicKey, entries) {
  const sorted = sortPostsInTopic(entries);
  const posts = sorted.map((entry) => entry.post);
  const representative = sorted[0];

  let sumImportance = 0;
  let newestPostedAt = null;
  let oldestPostedAt = null;
  let newestMs = null;
  let oldestMs = null;
  let maxImportance = 0;

  for (const entry of sorted) {
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

  return {
    topicKey,
    category: representative.category,
    tags: mergeTopicTags(posts),
    summary: buildPostSummary(representative.post),
    posts,
    postCount: posts.length,
    maxImportance,
    averageImportance: posts.length
      ? Math.round((sumImportance / posts.length) * 10) / 10
      : 0,
    newestPostedAt,
    oldestPostedAt,
    _newestMs: newestMs,
  };
}

/**
 * Group posts into topics by Topic Key.
 * @returns {object[]} unsorted topics
 */
function groupTopics(posts) {
  const groups = new Map();

  for (let index = 0; index < posts.length; index++) {
    const post = posts[index];
    const topicKey = getTopicKey(post, index);
    const entry = {
      post,
      index,
      topicKey,
      category: getEditorCategory(post),
      importance: getImportance(post),
      postedAtMs: parsePostedAtMs(post.postedAt),
    };

    if (!groups.has(topicKey)) groups.set(topicKey, []);
    groups.get(topicKey).push(entry);
  }

  return [...groups.entries()].map(([topicKey, entries]) =>
    buildTopicFromEntries(topicKey, entries)
  );
}

/** Default: maxImportance → newestPostedAt → postCount (all desc). */
function sortTopics(topics) {
  return [...topics]
    .map((topic, index) => ({ topic, index }))
    .sort((a, b) => {
      if (a.topic.maxImportance !== b.topic.maxImportance) {
        return b.topic.maxImportance - a.topic.maxImportance;
      }

      const aNewest = a.topic._newestMs;
      const bNewest = b.topic._newestMs;
      if (aNewest == null && bNewest == null) {
        /* fall through */
      } else if (aNewest == null) {
        return 1;
      } else if (bNewest == null) {
        return -1;
      } else if (aNewest !== bNewest) {
        return bNewest - aNewest;
      }

      if (a.topic.postCount !== b.topic.postCount) {
        return b.topic.postCount - a.topic.postCount;
      }
      return a.index - b.index;
    })
    .map((item) => {
      const { _newestMs, ...topic } = item.topic;
      return topic;
    });
}

function matchesEditorFilters(post, options, range) {
  if (!isPostedAtInLocalRange(post.postedAt, range)) {
    return false;
  }

  if (options.category != null && getEditorCategory(post) !== options.category) {
    return false;
  }

  return true;
}

/**
 * Build Editor View: filtered posts → topics → sorted → limited.
 * @returns {{ topics: object[], totalPosts: number, totalTopics: number }}
 */
function buildEditorView(posts, options = {}, range = { hasRange: false }) {
  const filtered = [];
  for (let i = 0; i < posts.length; i++) {
    if (matchesEditorFilters(posts[i], options, range)) {
      filtered.push(posts[i]);
    }
  }

  const grouped = groupTopics(filtered);
  let topics = sortTopics(grouped);
  const totalTopics = topics.length;

  if (options.limit != null) {
    topics = topics.slice(0, options.limit);
  }

  return {
    topics,
    totalPosts: filtered.length,
    totalTopics,
  };
}

module.exports = {
  NO_SUMMARY,
  getEditorCategory,
  getImportance,
  getHumanTags,
  buildPostSummary,
  getTopicKey,
  groupTopics,
  sortTopics,
  buildEditorView,
};
