const { parsePostedAtMs, isPostedAtInLocalRange } = require("./date-range");

function includesIgnoreCase(haystack, needle) {
  return String(haystack || "")
    .toLowerCase()
    .includes(String(needle || "").toLowerCase());
}

function dedupeCaseInsensitive(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(text);
  }
  return unique;
}

/** Canonical category for search with migration-safe fallback. */
function getSearchCategory(post) {
  if (post.finalAnalysis?.category) return post.finalAnalysis.category;
  if (post.analysis?.category) return post.analysis.category;
  return "その他";
}

/**
 * Human tags (finalAnalysis + enrichment) and classification keywords.
 * Display should prefer humanTags; matching uses allTags.
 */
function getSearchableTags(post) {
  const humanTags = dedupeCaseInsensitive([
    ...(Array.isArray(post.finalAnalysis?.tags) ? post.finalAnalysis.tags : []),
    ...(Array.isArray(post.enrichment?.tags) ? post.enrichment.tags : []),
  ]);

  const keywordTags = dedupeCaseInsensitive(
    (Array.isArray(post.analysis?.matchedKeywords)
      ? post.analysis.matchedKeywords
      : []
    ).map((item) => (item && typeof item === "object" ? item.keyword : item))
  );

  return {
    humanTags,
    keywordTags,
    allTags: dedupeCaseInsensitive([...humanTags, ...keywordTags]),
  };
}

function splitTextTerms(text) {
  if (text == null || text === "") return [];
  return String(text)
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function buildSearchDocument(post) {
  const enrichment = post.enrichment || {};
  const finalAnalysis = post.finalAnalysis || {};
  const tags = getSearchableTags(post);
  const category = getSearchCategory(post);
  const importance = Number(enrichment.importance);
  const textBlobs = [
    post.text,
    enrichment.summary,
    enrichment.reason,
    finalAnalysis.reason,
    post.authorName,
    post.authorHandle,
    tags.allTags.join(" "),
  ]
    .map((value) => String(value || ""))
    .join("\n");

  return {
    post,
    category,
    importance: Number.isFinite(importance) ? importance : -1,
    postedAtMs: parsePostedAtMs(post.postedAt),
    authorName: post.authorName || "",
    authorHandle: post.authorHandle || "",
    humanTags: tags.humanTags,
    keywordTags: tags.keywordTags,
    allTags: tags.allTags,
    textBlobs,
  };
}

/**
 * Normalize CLI-parsed options into a search query.
 * categories: string[] (OR), tags: string[] (AND), textTerms: string[] (AND)
 */
function normalizeSearchOptions(raw, range) {
  const categories = Array.isArray(raw.categories)
    ? raw.categories.filter(Boolean)
    : raw.category != null
      ? [raw.category]
      : [];
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter(Boolean)
    : raw.tag != null
      ? [raw.tag]
      : [];
  const textTerms = Array.isArray(raw.textTerms)
    ? raw.textTerms.filter(Boolean)
    : splitTextTerms(raw.text);

  return {
    categories,
    tags,
    textTerms,
    author: raw.author != null ? String(raw.author) : null,
    importance: raw.importance != null ? Number(raw.importance) : null,
    range: range || { hasRange: false },
    explain: Boolean(raw.explain),
    limit: raw.limit != null ? Number(raw.limit) : null,
  };
}

function matchTagQuery(allTags, query) {
  return allTags.some((tag) => includesIgnoreCase(tag, query));
}

function collectMatchedTags(allTags, queries) {
  const matched = [];
  for (const query of queries) {
    for (const tag of allTags) {
      if (includesIgnoreCase(tag, query)) {
        matched.push(tag);
      }
    }
  }
  return dedupeCaseInsensitive(matched);
}

function collectMatchedTextTerms(textBlobs, terms) {
  return terms.filter((term) => includesIgnoreCase(textBlobs, term));
}

function matchesPost(doc, query) {
  const match = {
    category: doc.category,
    importance: doc.post.enrichment?.importance ?? null,
    textTerms: [],
    tags: [],
    author: null,
    datePassed: null,
  };

  if (query.categories.length > 0) {
    if (!query.categories.includes(doc.category)) {
      return { ok: false, match };
    }
  }

  if (query.importance != null) {
    if (!Number.isFinite(doc.importance) || doc.importance < query.importance) {
      return { ok: false, match };
    }
  }

  if (query.tags.length > 0) {
    for (const tagQuery of query.tags) {
      if (!matchTagQuery(doc.allTags, tagQuery)) {
        return { ok: false, match };
      }
    }
    match.tags = collectMatchedTags(doc.allTags, query.tags);
  }

  if (query.author != null) {
    const authorHit =
      includesIgnoreCase(doc.authorName, query.author) ||
      includesIgnoreCase(doc.authorHandle, query.author);
    match.author = authorHit;
    if (!authorHit) return { ok: false, match };
  }

  if (query.textTerms.length > 0) {
    const hitTerms = collectMatchedTextTerms(doc.textBlobs, query.textTerms);
    match.textTerms = hitTerms;
    if (hitTerms.length !== query.textTerms.length) {
      return { ok: false, match };
    }
  }

  if (query.range && query.range.hasRange) {
    const dateOk = isPostedAtInLocalRange(doc.post.postedAt, query.range);
    match.datePassed = dateOk;
    if (!dateOk) return { ok: false, match };
  }

  return { ok: true, match };
}

function sortSearchDocuments(docs) {
  return [...docs]
    .map((doc, index) => ({ doc, index }))
    .sort((a, b) => {
      if (a.doc.importance !== b.doc.importance) {
        return b.doc.importance - a.doc.importance;
      }
      const aTime = a.doc.postedAtMs;
      const bTime = b.doc.postedAtMs;
      if (aTime == null && bTime == null) return a.index - b.index;
      if (aTime == null) return 1;
      if (bTime == null) return -1;
      if (aTime !== bTime) return bTime - aTime;
      return a.index - b.index;
    })
    .map((item) => item.doc);
}

/**
 * @returns {{ post: object, match: object }[]}
 */
function searchPosts(posts, query) {
  const matched = [];
  for (const post of posts) {
    const doc = buildSearchDocument(post);
    const { ok, match } = matchesPost(doc, query);
    if (ok) {
      matched.push({ post, match, _doc: doc });
    }
  }

  const sorted = sortSearchDocuments(matched.map((item) => item._doc));
  const byPost = new Map(matched.map((item) => [item.post, item.match]));

  let results = sorted.map((doc) => ({
    post: doc.post,
    match: byPost.get(doc.post),
  }));

  if (query.limit != null) {
    results = results.slice(0, query.limit);
  }

  return results;
}

module.exports = {
  includesIgnoreCase,
  getSearchCategory,
  getSearchableTags,
  splitTextTerms,
  buildSearchDocument,
  normalizeSearchOptions,
  matchesPost,
  searchPosts,
  sortSearchDocuments,
};
