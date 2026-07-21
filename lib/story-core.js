const path = require("path");
const { parsePostedAtMs } = require("./date-range");
const { getCategoryOrder } = require("./categories");
const { getEditorCategory, getImportance } = require("./editor-core");
const {
  buildConceptLibrary,
  calculateActiveDays,
} = require("./concept-core");
const { readJsonArrayRequired } = require("./pipeline-io");

const STORIES_FILE = path.join(__dirname, "..", "config", "stories.json");
const STORY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function normalizeTag(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function asStringArray(value, fieldName, fail) {
  if (!Array.isArray(value)) {
    fail(`Story定義の ${fieldName} は配列である必要があります。`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      fail(`Story定義の ${fieldName}[${index}] は文字列である必要があります。`);
    }
    return item;
  });
}

/**
 * Validate and normalize Story definitions from config/stories.json.
 * Rule B requires at least one of includeTags / includeCategories.
 */
function validateStoryDefinitions(raw, options = {}) {
  const fail = options.fail || ((message) => {
    throw new Error(message);
  });
  const categoryOrder = options.categoryOrder || getCategoryOrder();
  const allowedCategories = new Set(categoryOrder);

  if (!Array.isArray(raw)) {
    fail("config/stories.json は配列である必要があります。");
  }

  const seenIds = new Set();
  const definitions = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail(`Story定義[${i}] はオブジェクトである必要があります。`);
    }

    if (typeof item.id !== "string" || !item.id.trim()) {
      fail(`Story定義[${i}] の id は空でない文字列である必要があります。`);
    }
    const id = item.id.trim();
    if (!STORY_ID_RE.test(id)) {
      fail(
        `Story定義[${i}] の id が不正です: ${id}\n英数字・ハイフン・アンダースコアのみ（先頭は英数字）を使ってください。`
      );
    }
    if (seenIds.has(id)) {
      fail(`Story定義の id が重複しています: ${id}`);
    }
    seenIds.add(id);

    if (typeof item.label !== "string" || !item.label.trim()) {
      fail(`Story定義[${id}] の label は空でない文字列である必要があります。`);
    }

    const includeTags = asStringArray(
      item.includeTags == null ? [] : item.includeTags,
      `Story[${id}].includeTags`,
      fail
    );
    const excludeTags = asStringArray(
      item.excludeTags == null ? [] : item.excludeTags,
      `Story[${id}].excludeTags`,
      fail
    );
    const includeCategories = asStringArray(
      item.includeCategories == null ? [] : item.includeCategories,
      `Story[${id}].includeCategories`,
      fail
    );

    for (const category of includeCategories) {
      if (!allowedCategories.has(category)) {
        fail(
          `Story定義[${id}] の includeCategories に不正なカテゴリがあります: ${category}`
        );
      }
    }

    if (includeTags.length === 0 && includeCategories.length === 0) {
      fail(
        `Story定義[${id}] には includeTags または includeCategories のいずれかを1件以上指定してください。`
      );
    }

    let priority = 0;
    if (item.priority != null) {
      const num = Number(item.priority);
      if (!Number.isFinite(num)) {
        fail(`Story定義[${id}] の priority は数値である必要があります。`);
      }
      priority = num;
    }

    const description =
      item.description == null ? "" : String(item.description);

    definitions.push({
      id,
      label: item.label.trim(),
      description,
      includeTags,
      excludeTags,
      includeCategories,
      priority,
      definitionIndex: i,
    });
  }

  return definitions;
}

function loadStoryDefinitions(fail) {
  const raw = readJsonArrayRequired(STORIES_FILE, "Story定義");
  return validateStoryDefinitions(raw, {
    fail,
    categoryOrder: getCategoryOrder(),
  });
}

function conceptTagSet(concept) {
  const set = new Set();
  for (const tag of concept.tags || []) {
    const key = normalizeTag(tag);
    if (key) set.add(key);
  }
  return set;
}

function conceptCategorySet(concept) {
  const set = new Set();
  if (concept.category) set.add(concept.category);
  if (concept.categories && typeof concept.categories === "object") {
    for (const [name, count] of Object.entries(concept.categories)) {
      if (Number(count) > 0) set.add(name);
    }
  }
  for (const topic of concept.topics || []) {
    if (topic.category) set.add(topic.category);
  }
  for (const post of concept.posts || []) {
    set.add(getEditorCategory(post));
  }
  return set;
}

function findExactTagMatches(configuredTags, conceptTags) {
  const matched = [];
  const conceptSet = conceptTags instanceof Set ? conceptTags : conceptTagSet({ tags: conceptTags });
  for (const raw of configuredTags) {
    const key = normalizeTag(raw);
    if (key && conceptSet.has(key)) {
      matched.push(raw);
    }
  }
  return matched;
}

/**
 * Rule B:
 * 1. excludeTags hit → no match
 * 2. if includeTags non-empty → tag exact match required
 * 3. else includeCategories containment
 */
function matchConceptToStory(concept, definition) {
  const conceptTags = conceptTagSet(concept);
  const conceptCategories = conceptCategorySet(concept);

  const excludedHits = findExactTagMatches(definition.excludeTags, conceptTags);
  if (excludedHits.length > 0) {
    return {
      matched: false,
      matchedTags: [],
      matchedCategories: [],
      excludedTags: excludedHits,
      reason: "excluded",
    };
  }

  if (definition.includeTags.length > 0) {
    const matchedTags = findExactTagMatches(definition.includeTags, conceptTags);
    if (matchedTags.length === 0) {
      return {
        matched: false,
        matchedTags: [],
        matchedCategories: [],
        excludedTags: [],
        reason: "tags-miss",
      };
    }
    return {
      matched: true,
      matchedTags,
      matchedCategories: [],
      excludedTags: [],
      reason: "tags",
    };
  }

  const matchedCategories = definition.includeCategories.filter((category) =>
    conceptCategories.has(category)
  );
  if (matchedCategories.length === 0) {
    return {
      matched: false,
      matchedTags: [],
      matchedCategories: [],
      excludedTags: [],
      reason: "categories-miss",
    };
  }

  return {
    matched: true,
    matchedTags: [],
    matchedCategories,
    excludedTags: [],
    reason: "categories",
  };
}

function conceptIdentityKey(concept, index) {
  if (concept.conceptKey) return `key:${concept.conceptKey}`;
  const topicKey = concept.topics?.[0]?.topicKey;
  if (topicKey) return `topic:${topicKey}`;
  const url = String(concept.posts?.[0]?.url || "").trim();
  if (url) return `url:${url}`;
  return `index:${index}`;
}

function sortConceptsInStory(concepts) {
  return [...concepts]
    .map((concept, index) => ({ concept, index }))
    .sort((a, b) => {
      if (a.concept.activeDays !== b.concept.activeDays) {
        return b.concept.activeDays - a.concept.activeDays;
      }
      if (a.concept.topicCount !== b.concept.topicCount) {
        return b.concept.topicCount - a.concept.topicCount;
      }
      if (a.concept.maxImportance !== b.concept.maxImportance) {
        return b.concept.maxImportance - a.concept.maxImportance;
      }
      const aNewest = parsePostedAtMs(a.concept.newestPostedAt);
      const bNewest = parsePostedAtMs(b.concept.newestPostedAt);
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
    .map((item) => item.concept);
}

function collectStoryTopics(concepts) {
  const topics = [];
  const seen = new Set();
  for (const concept of concepts) {
    for (const topic of concept.topics || []) {
      const key = topic.topicKey
        ? `topic:${topic.topicKey}`
        : `anon:${topics.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      topics.push(topic);
    }
  }
  return topics;
}

function collectStoryPosts(concepts) {
  const entries = [];
  const seenUrls = new Set();
  let index = 0;
  for (const concept of concepts) {
    for (const post of concept.posts || []) {
      const url = String(post.url || "").trim();
      if (url) {
        if (seenUrls.has(url)) {
          index += 1;
          continue;
        }
        seenUrls.add(url);
      }
      entries.push({
        post,
        index,
        importance: getImportance(post),
        postedAtMs: parsePostedAtMs(post.postedAt),
      });
      index += 1;
    }
  }
  return entries;
}

function mergeObservedTags(concepts) {
  const seen = new Set();
  const tags = [];
  for (const concept of concepts) {
    for (const tag of concept.tags || []) {
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

function aggregateCategoriesByPosts(posts, categoryOrder) {
  const counts = new Map();
  for (const post of posts) {
    const category = getEditorCategory(post);
    counts.set(category, (counts.get(category) || 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    const ai = categoryOrder.indexOf(a[0]);
    const bi = categoryOrder.indexOf(b[0]);
    const aRank = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
    const bRank = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
    return aRank - bRank;
  });

  const categories = {};
  for (const [name, count] of ranked) {
    categories[name] = count;
  }

  return {
    categories,
    dominantCategory: ranked[0] ? ranked[0][0] : null,
  };
}

/**
 * score = maxImportance * 10 + activeDays * 4 + conceptCount * 3 + topicCount + priority
 */
function calculateStoryScore(parts) {
  const maxImportance = Number(parts.maxImportance) || 0;
  const activeDays = Number(parts.activeDays) || 0;
  const conceptCount = Number(parts.conceptCount) || 0;
  const topicCount = Number(parts.topicCount) || 0;
  const priority = Number(parts.priority) || 0;

  const components = {
    maxImportance: maxImportance * 10,
    activeDays: activeDays * 4,
    conceptCount: conceptCount * 3,
    topicCount,
    priority,
  };

  return {
    score:
      components.maxImportance +
      components.activeDays +
      components.conceptCount +
      components.topicCount +
      components.priority,
    components,
  };
}

function buildStory(definition, matchedEntries, categoryOrder) {
  const concepts = sortConceptsInStory(matchedEntries.map((entry) => entry.concept));
  const topics = collectStoryTopics(concepts);
  const postEntries = collectStoryPosts(concepts);
  const posts = postEntries.map((entry) => entry.post);

  let sumImportance = 0;
  let validImportanceCount = 0;
  let maxImportance = 0;
  let newestPostedAt = null;
  let oldestPostedAt = null;
  let newestMs = null;
  let oldestMs = null;

  for (const entry of postEntries) {
    if (Number.isFinite(entry.importance)) {
      sumImportance += entry.importance;
      validImportanceCount += 1;
      if (entry.importance > maxImportance) maxImportance = entry.importance;
    }
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

  const { activeDays, activeDates } = calculateActiveDays(posts);
  const categoryInfo = aggregateCategoriesByPosts(posts, categoryOrder);
  const observedTags = mergeObservedTags(concepts);
  const scoreInfo = calculateStoryScore({
    maxImportance,
    activeDays,
    conceptCount: concepts.length,
    topicCount: topics.length,
    priority: definition.priority,
  });

  const averageImportance =
    validImportanceCount > 0 ? sumImportance / validImportanceCount : 0;

  const story = {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    priority: definition.priority,
    concepts,
    conceptCount: concepts.length,
    topics,
    topicCount: topics.length,
    posts,
    postCount: posts.length,
    categories: categoryInfo.categories,
    dominantCategory: categoryInfo.dominantCategory,
    configuredTags: [...definition.includeTags],
    tags: observedTags,
    activeDays,
    maxImportance,
    averageImportance,
    newestPostedAt,
    oldestPostedAt,
    score: scoreInfo.score,
  };

  const explanation = {
    definition: {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      includeTags: definition.includeTags,
      includeCategories: definition.includeCategories,
      excludeTags: definition.excludeTags,
      priority: definition.priority,
      definitionIndex: definition.definitionIndex,
    },
    matchedConcepts: matchedEntries.map((entry) => ({
      conceptKey: entry.concept.conceptKey,
      label: entry.concept.label,
      match: entry.match,
    })),
    scoreComponents: scoreInfo.components,
    activeDates,
    categoryCounts: categoryInfo.categories,
    dominantCategory: categoryInfo.dominantCategory,
    definitionIndex: definition.definitionIndex,
    tieBreak: {
      activeDays,
      maxImportance,
      conceptCount: concepts.length,
      newestPostedAt,
      priority: definition.priority,
      definitionIndex: definition.definitionIndex,
    },
  };

  return {
    story,
    explanation,
    _newestMs: newestMs,
    _definitionIndex: definition.definitionIndex,
  };
}

function groupStories(concepts, definitions, categoryOrder = getCategoryOrder()) {
  const buckets = new Map();
  for (const definition of definitions) {
    buckets.set(definition.id, {
      definition,
      matched: [],
      seen: new Set(),
    });
  }

  const membershipCounts = new Map();
  const unassigned = [];

  for (let index = 0; index < concepts.length; index++) {
    const concept = concepts[index];
    const identity = conceptIdentityKey(concept, index);
    let matchedAny = false;

    for (const definition of definitions) {
      const match = matchConceptToStory(concept, definition);
      if (!match.matched) continue;

      const bucket = buckets.get(definition.id);
      if (bucket.seen.has(identity)) continue;
      bucket.seen.add(identity);
      bucket.matched.push({ concept, match, identity });
      matchedAny = true;
      membershipCounts.set(identity, (membershipCounts.get(identity) || 0) + 1);
    }

    if (!matchedAny) {
      unassigned.push({
        concept,
        explanation: {
          unassigned: true,
          reason: "no-story-match",
          identityKey: identity,
        },
      });
    }
  }

  const stories = [];
  for (const definition of definitions) {
    const bucket = buckets.get(definition.id);
    if (bucket.matched.length === 0) continue;
    stories.push(buildStory(definition, bucket.matched, categoryOrder));
  }

  let multiStoryConceptCount = 0;
  for (const count of membershipCounts.values()) {
    if (count > 1) multiStoryConceptCount += 1;
  }

  return {
    stories,
    unassignedConcepts: unassigned,
    multiStoryConceptCount,
  };
}

function sortStories(items) {
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.story.score !== b.item.story.score) {
        return b.item.story.score - a.item.story.score;
      }
      if (a.item.story.activeDays !== b.item.story.activeDays) {
        return b.item.story.activeDays - a.item.story.activeDays;
      }
      if (a.item.story.maxImportance !== b.item.story.maxImportance) {
        return b.item.story.maxImportance - a.item.story.maxImportance;
      }
      if (a.item.story.conceptCount !== b.item.story.conceptCount) {
        return b.item.story.conceptCount - a.item.story.conceptCount;
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

      if (a.item.story.priority !== b.item.story.priority) {
        return b.item.story.priority - a.item.story.priority;
      }

      if (a.item._definitionIndex !== b.item._definitionIndex) {
        return a.item._definitionIndex - b.item._definitionIndex;
      }

      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

function storyContainsCategories(story, categories) {
  if (!categories || categories.length === 0) return true;
  for (const wanted of categories) {
    if ((story.categories[wanted] || 0) > 0) return true;
    if (story.concepts.some((concept) => {
      if (concept.category === wanted) return true;
      if ((concept.categories?.[wanted] || 0) > 0) return true;
      return (concept.posts || []).some((post) => getEditorCategory(post) === wanted);
    })) {
      return true;
    }
  }
  return false;
}

function uniquePostsFromConcepts(concepts) {
  const posts = [];
  const seenUrls = new Set();
  for (const concept of concepts) {
    for (const post of concept.posts || []) {
      const url = String(post.url || "").trim();
      if (url) {
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
      }
      posts.push(post);
    }
  }
  return posts;
}

function buildStoryStatistics(allConcepts, grouped, stories) {
  const allPosts = uniquePostsFromConcepts(allConcepts);
  const { activeDays } = calculateActiveDays(allPosts);
  const categoryOrder = getCategoryOrder();
  const categoryCounts = aggregateCategoriesByPosts(allPosts, categoryOrder).categories;

  const matchedConceptCount = allConcepts.length - grouped.unassignedConcepts.length;

  return {
    storyCount: stories.length,
    matchedConceptCount,
    unassignedConceptCount: grouped.unassignedConcepts.length,
    totalConceptCount: allConcepts.length,
    totalTopicCount: allConcepts.reduce((sum, concept) => sum + (concept.topicCount || 0), 0),
    totalPostCount: allPosts.length,
    activeDays,
    categoryCounts,
    multiStoryConceptCount: grouped.multiStoryConceptCount,
  };
}

/**
 * Build Editor-in-Chief Story View from posts via Concept Library.
 */
function buildStoryView(posts, definitions, options = {}, range = { hasRange: false }) {
  const categoryOrder = options.categoryOrder || getCategoryOrder();
  const library = buildConceptLibrary(posts, {}, range);
  const concepts = library.concepts.map((item) => item.concept);

  const grouped = groupStories(concepts, definitions, categoryOrder);
  let items = sortStories(grouped.stories);

  const categories = Array.isArray(options.categories)
    ? options.categories.filter(Boolean)
    : [];
  const storyIds = Array.isArray(options.storyIds)
    ? options.storyIds.filter(Boolean)
    : [];

  items = items.filter((item) => {
    if (storyIds.length > 0 && !storyIds.includes(item.story.id)) return false;
    if (!storyContainsCategories(item.story, categories)) return false;
    if (options.minDays != null && item.story.activeDays < options.minDays) {
      return false;
    }
    if (options.minConcepts != null && item.story.conceptCount < options.minConcepts) {
      return false;
    }
    return true;
  });

  const totalStories = items.length;
  const statistics = buildStoryStatistics(
    concepts,
    grouped,
    items.map((item) => item.story)
  );

  if (options.limit != null) {
    items = items.slice(0, options.limit);
  }

  const stories = items.map((item) => {
    const { _newestMs, _definitionIndex, ...rest } = item;
    return rest;
  });

  return {
    stories,
    unassignedConcepts: grouped.unassignedConcepts,
    statistics,
    totalStories,
    totalConcepts: library.totalConcepts,
    totalTopics: library.totalTopics,
    totalPosts: library.totalPosts,
  };
}

module.exports = {
  STORIES_FILE,
  validateStoryDefinitions,
  loadStoryDefinitions,
  matchConceptToStory,
  calculateStoryScore,
  groupStories,
  sortStories,
  buildStory,
  buildStoryView,
};
