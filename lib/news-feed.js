/**
 * NEWS-FEED-EXPORT-001 — Public news-feed.json from Daily Enriched posts.
 * Conversion boundary: internal enriched posts → stable public schema.
 * Deterministic. No OpenAI. Does not copy timeline.json or full X text.
 */

const fs = require("fs");
const path = require("path");
const { writeJsonAtomicOrThrow } = require("./pipeline-io");
const { getPersonalScore } = require("./digest-core");
const {
  getCategory,
  getSummary,
  getUrl,
  getImportanceOrNull,
  scoreEditorialPost,
} = require("./editorial-score");

const SCHEMA_VERSION = 1;
const FEED_SOURCE = "x-timeline-collector";
const SOURCE_TYPE = "x";
const SCOPE_TYPE = "collect-run";
const NEWS_FEED_REL = path.join("output", "digest-reader", "news-feed.json");
const NEWS_FEED_BASENAME = "news-feed.json";

const PLACEHOLDER_SUMMARY = "要約なし";

function isPlaceholderSummary(summary) {
  const value = String(summary || "").trim();
  if (!value) return true;
  return value === PLACEHOLDER_SUMMARY;
}

function toIsoOrNull(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function toScoreOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readStoredAxis(post, key) {
  if (!post || typeof post !== "object") return null;
  const fromEnrichment =
    post.enrichment && typeof post.enrichment === "object"
      ? post.enrichment[key]
      : undefined;
  if (fromEnrichment != null && fromEnrichment !== "") {
    return toScoreOrNull(fromEnrichment);
  }
  if (post[key] != null && post[key] !== "") {
    return toScoreOrNull(post[key]);
  }
  return null;
}

function publicHttpUrlOrNull(url) {
  const href = String(url || "").trim();
  if (!href) return null;
  if (!/^https?:\/\//i.test(href)) return null;
  return href;
}

function extractStatusId(url) {
  const m = String(url || "").match(
    /(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i
  );
  return m ? m[1] : "";
}

function publicId(post, sourceUrl) {
  const explicit = publicTextOrNull(post && post.id);
  if (explicit) return explicit;
  const fromUrl = extractStatusId(sourceUrl || getUrl(post));
  if (fromUrl) return fromUrl;
  if (sourceUrl) return sourceUrl;
  return null;
}

function publicTextOrNull(value) {
  const text = String(value == null ? "" : value).trim();
  return text || null;
}

function publicAuthor(post) {
  if (!post || typeof post !== "object") {
    return { name: null, handle: null };
  }
  return {
    name: publicTextOrNull(post.authorName),
    handle: publicTextOrNull(post.authorHandle),
  };
}

function publicTitleAndSummary(post) {
  const summary = getSummary(post);
  if (isPlaceholderSummary(summary)) {
    return { title: null, summary: null };
  }
  return { title: summary, summary };
}

function publicScores(post) {
  const importanceStored = readStoredAxis(post, "importance");
  const importance =
    importanceStored != null ? importanceStored : getImportanceOrNull(post);
  return {
    informationValue: readStoredAxis(post, "informationValue"),
    personalRelevance: readStoredAxis(post, "personalRelevance"),
    impact: readStoredAxis(post, "impact"),
    attentionSignal: readStoredAxis(post, "attentionSignal"),
    importance,
  };
}

function toNewsFeedItem(post) {
  const sourceUrl = publicHttpUrlOrNull(getUrl(post));
  const { title, summary } = publicTitleAndSummary(post);
  return {
    id: publicId(post, sourceUrl),
    title,
    summary,
    category: getCategory(post),
    sourceType: SOURCE_TYPE,
    sourceUrl,
    postedAt: toIsoOrNull(post && post.postedAt),
    collectedAt: toIsoOrNull(post && post.collectedAt),
    author: publicAuthor(post),
    scores: publicScores(post),
  };
}

/**
 * Sort Daily Enriched posts by existing editorialScore only.
 * Does not filter, dedupe, or apply Today's Picks caps.
 */
function rankNewsFeedPosts(posts, config) {
  const list = Array.isArray(posts) ? posts : [];
  const scored = list.map((post, index) => {
    const context = config
      ? { personalScore: getPersonalScore(post, config) }
      : {};
    return {
      post,
      index,
      editorialScore: scoreEditorialPost(post, context),
    };
  });
  scored.sort((a, b) => {
    if (a.editorialScore !== b.editorialScore) {
      return b.editorialScore - a.editorialScore;
    }
    return a.index - b.index;
  });
  return scored.map((row) => row.post);
}

function resolveGeneratedAt(options = {}) {
  const fromOption = toIsoOrNull(options.generatedAt);
  if (fromOption) return fromOption;
  if (typeof options.now === "function") {
    const iso = toIsoOrNull(options.now());
    if (iso) return iso;
  }
  return new Date().toISOString();
}

/**
 * Internal Daily Enriched posts → public news-feed document.
 * Does not invent values. Missing optional fields are null.
 *
 * @param {object[]} posts
 * @param {{ generatedAt?: string, now?: () => Date|string, config?: object }} [options]
 */
function buildNewsFeed(posts, options = {}) {
  const list = Array.isArray(posts) ? posts : [];
  const ranked = rankNewsFeedPosts(list, options.config);
  return {
    schemaVersion: SCHEMA_VERSION,
    source: FEED_SOURCE,
    generatedAt: resolveGeneratedAt(options),
    scope: {
      type: SCOPE_TYPE,
      itemCount: list.length,
    },
    items: ranked.map(toNewsFeedItem),
  };
}

function newsFeedPath(rootDir, outputDir) {
  if (outputDir) return path.join(path.resolve(outputDir), NEWS_FEED_BASENAME);
  return path.join(path.resolve(rootDir || process.cwd()), NEWS_FEED_REL);
}

function writeNewsFeed(filePath, feed) {
  writeJsonAtomicOrThrow(filePath, feed);
  return {
    generated: true,
    itemCount: Array.isArray(feed && feed.items) ? feed.items.length : 0,
    path: NEWS_FEED_REL,
    filePath,
  };
}

function parseNewsFeedFromOutput(output) {
  const text = String(output || "");
  const m = text.match(/news-feed items=(\d+)\s+path=(\S+)/i);
  if (!m) return null;
  const itemCount = Number(m[1]);
  return {
    generated: true,
    itemCount: Number.isFinite(itemCount) ? itemCount : 0,
    path: m[2],
  };
}

function normalizeNewsFeedSummary(raw) {
  if (!raw || typeof raw !== "object") return null;
  const itemCount = Number(raw.itemCount);
  return {
    generated: raw.generated !== false,
    itemCount: Number.isFinite(itemCount) ? itemCount : 0,
    path: String(raw.path || NEWS_FEED_REL).replace(/\\/g, "/"),
  };
}

function loadNewsFeedSummary(rootDir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const filePath = newsFeedPath(rootDir);
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(String(readFileSync(filePath, "utf8")));
    if (!data || data.schemaVersion !== SCHEMA_VERSION) return null;
    const itemCount = Array.isArray(data.items) ? data.items.length : 0;
    return {
      generated: true,
      itemCount,
      path: NEWS_FEED_REL,
    };
  } catch (_error) {
    return null;
  }
}

function formatNewsFeedBuildLine(summary) {
  const itemCount =
    summary && Number.isFinite(Number(summary.itemCount))
      ? Number(summary.itemCount)
      : 0;
  return `[build:digest-reader] news-feed items=${itemCount} path=${NEWS_FEED_REL}`;
}

module.exports = {
  SCHEMA_VERSION,
  FEED_SOURCE,
  SOURCE_TYPE,
  SCOPE_TYPE,
  NEWS_FEED_REL,
  NEWS_FEED_BASENAME,
  buildNewsFeed,
  toNewsFeedItem,
  rankNewsFeedPosts,
  writeNewsFeed,
  newsFeedPath,
  parseNewsFeedFromOutput,
  normalizeNewsFeedSummary,
  loadNewsFeedSummary,
  formatNewsFeedBuildLine,
};
