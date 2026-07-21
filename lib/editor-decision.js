/**
 * EP-004 — Editor Foundation: publishability decisions per Story.
 * Inputs: Story + Editorial + Knowledge. No ranking / layout.
 * Deterministic. No AI.
 */

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function extractStoriesList(storiesInput) {
  if (!storiesInput) return [];
  if (Array.isArray(storiesInput)) return storiesInput;
  if (Array.isArray(storiesInput.stories)) return storiesInput.stories;
  return [];
}

function extractKnowledgeList(knowledgeInput) {
  if (!knowledgeInput) return [];
  if (Array.isArray(knowledgeInput)) return knowledgeInput;
  if (Array.isArray(knowledgeInput.knowledge)) return knowledgeInput.knowledge;
  return [];
}

function extractEditorialArticles(editorialInput) {
  if (!editorialInput) return [];
  if (Array.isArray(editorialInput)) return editorialInput;
  if (
    editorialInput.editorial &&
    Array.isArray(editorialInput.editorial.articles)
  ) {
    return editorialInput.editorial.articles;
  }
  if (Array.isArray(editorialInput.articles)) return editorialInput.articles;
  return [];
}

function collectStoryPosts(story) {
  const out = [];
  const seen = new Set();
  const push = (post) => {
    if (!post || typeof post !== "object") return;
    const key =
      asString(post.url) ||
      `${asString(post.authorHandle)}|${asString(post.postedAt)}|${asString(
        post.text
      ).slice(0, 80)}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(post);
  };

  for (const post of Array.isArray(story?.posts) ? story.posts : []) {
    push(post);
  }
  for (const concept of Array.isArray(story?.concepts) ? story.concepts : []) {
    for (const post of Array.isArray(concept?.posts) ? concept.posts : []) {
      push(post);
    }
    for (const topic of Array.isArray(concept?.topics) ? concept.topics : []) {
      for (const post of Array.isArray(topic?.posts) ? topic.posts : []) {
        push(post);
      }
    }
  }
  return out;
}

function isQuestionOnly(text) {
  const t = asString(text);
  if (!t) return false;
  if (!/[？?]/.test(t) && !/だっけ|いつ頃|教えて/.test(t)) return false;
  return t.length <= 120;
}

function isPromoOnly(post) {
  const text = asString(post?.text);
  const category =
    asString(post?.finalAnalysis?.category) ||
    asString(post?.analysis?.category);
  if (category === "広告・PR") {
    if (!/(開催|発表|リリース|アップデート|会期|展覧会)/.test(text)) {
      return true;
    }
  }
  if (
    /(今すぐフォロー|いいね＆RT|RT希望|宣伝[でだ]|広告です|PRです|タイアップ)/i.test(
      text
    ) &&
    text.length <= 160
  ) {
    return true;
  }
  return false;
}

function hasEditorialContent(article) {
  if (!article || typeof article !== "object") return false;
  if (asString(article.headline)) return true;
  if (asString(article.lead)) return true;
  if (asString(article.angle)) return true;
  if (asString(article.whyNow)) return true;
  if (Array.isArray(article.keyFacts) && article.keyFacts.some((f) => asString(f))) {
    return true;
  }
  return false;
}

function findEditorialForStory(articles, story) {
  const storyId = asString(story?.id);
  if (!storyId) return null;
  for (const a of articles) {
    if (asString(a?.storyId) === storyId && hasEditorialContent(a)) return a;
  }
  for (const a of articles) {
    if (asString(a?.knowledgeId) === storyId && hasEditorialContent(a)) {
      return a;
    }
  }
  return null;
}

function findKnowledgeForStory(knowledgeList, story) {
  const storyId = asString(story?.id);
  if (!storyId) return null;
  return (
    knowledgeList.find((k) => asString(k?.id) === storyId) ||
    knowledgeList.find((k) => {
      const stories = Array.isArray(k?.evidence?.stories)
        ? k.evidence.stories
        : [];
      return stories.map(asString).includes(storyId);
    }) ||
    null
  );
}

function countEvidence(posts) {
  let withUrl = 0;
  let withText = 0;
  for (const post of posts) {
    if (asString(post.url)) withUrl += 1;
    if (asString(post.text).length >= 8) withText += 1;
  }
  return { withUrl, withText, total: posts.length };
}

function isStoryEstablished(story, posts) {
  if (!asString(story?.id)) return false;
  if (posts.some((p) => asString(p.text).length >= 8)) return true;
  if (asString(story?.description).length >= 8) return true;
  const concepts = Array.isArray(story?.concepts) ? story.concepts : [];
  if (concepts.some((c) => asString(c?.summary).length >= 8)) return true;
  return false;
}

function isStoryWeak(story, posts, evidence) {
  if (!isStoryEstablished(story, posts)) return true;
  if (evidence.total === 0) return true;
  if (evidence.withText === 0) return true;
  const maxImp = Number(story?.maxImportance);
  const conceptCount = Number(story?.conceptCount) ||
    (Array.isArray(story?.concepts) ? story.concepts.length : 0);
  if (
    (!Number.isFinite(maxImp) || maxImp <= 0) &&
    conceptCount === 0 &&
    evidence.withText <= 1 &&
    asString(posts[0]?.text).length < 40
  ) {
    return true;
  }
  return false;
}

function isKnowledgeInsufficient(knowledge) {
  if (!knowledge) return true;
  const status = asString(knowledge.status);
  if (status && status !== "published") return true;
  const confidence = Number(knowledge.confidence);
  if (Number.isFinite(confidence) && confidence < 50) return true;
  if (!asString(knowledge.summary) && !asString(knowledge.title)) return true;
  return false;
}

function storyFingerprint(story, posts) {
  const urls = posts
    .map((p) => asString(p.url))
    .filter(Boolean)
    .sort();
  if (urls.length > 0) return `urls:${urls.join("|")}`;
  const texts = posts
    .map((p) => asString(p.text).replace(/\s+/g, " "))
    .filter((t) => t.length >= 8)
    .sort();
  if (texts.length > 0) return `texts:${texts.join("|")}`;
  return `id:${asString(story?.id)}`;
}

/**
 * Decide accept | hold | reject for one story.
 * Reject checked first, then hold, then accept.
 */
function decideStory(story, context) {
  const reasons = [];
  const posts = collectStoryPosts(story);
  const evidence = countEvidence(posts);
  const editorial = findEditorialForStory(context.articles, story);
  const knowledge = findKnowledgeForStory(context.knowledgeList, story);
  const fingerprint = storyFingerprint(story, posts);

  // --- reject ---
  if (
    context.seenFingerprints.has(fingerprint) &&
    fingerprint !== `id:${asString(story?.id)}`
  ) {
    reasons.push("Story重複");
    return { decision: "reject", reason: reasons, fingerprint };
  }
  if (
    context.seenStoryIds.has(asString(story?.id)) &&
    asString(story?.id)
  ) {
    reasons.push("Story重複");
    return { decision: "reject", reason: reasons, fingerprint };
  }

  const questionPosts = posts.filter((p) => isQuestionOnly(p.text));
  if (posts.length > 0 && questionPosts.length === posts.length) {
    reasons.push("質問投稿");
    return { decision: "reject", reason: reasons, fingerprint };
  }

  const promoPosts = posts.filter((p) => isPromoOnly(p));
  if (posts.length > 0 && promoPosts.length === posts.length) {
    reasons.push("宣伝のみ");
    return { decision: "reject", reason: reasons, fingerprint };
  }

  if (evidence.total === 0 || (evidence.withUrl === 0 && evidence.withText === 0)) {
    reasons.push("根拠不足");
    return { decision: "reject", reason: reasons, fingerprint };
  }

  // --- hold ---
  let hold = false;
  if (evidence.withUrl === 0 && evidence.withText < 2) {
    hold = true;
    reasons.push("evidence不足");
  }
  if (isStoryWeak(story, posts, evidence)) {
    hold = true;
    reasons.push("Storyが弱い");
  }
  if (isKnowledgeInsufficient(knowledge)) {
    hold = true;
    reasons.push("Knowledge不足");
  }
  if (!editorial) {
    hold = true;
    reasons.push("Editorial未生成");
  }

  if (hold) {
    // Deduplicate reasons, stable order
    return {
      decision: "hold",
      reason: [...new Set(reasons)],
      fingerprint,
    };
  }

  // --- accept ---
  reasons.push("evidenceあり");
  reasons.push("Story成立");
  reasons.push("Editorial生成済み");
  return { decision: "accept", reason: reasons, fingerprint };
}

/**
 * Build decisions for all stories. Array order is input story order.
 * @returns {{ storyId: string, decision: string, reason: string[] }[]}
 */
function buildEditorDecisions({ stories, editorial, knowledge } = {}) {
  const storyList = extractStoriesList(stories);
  const articles = extractEditorialArticles(editorial);
  const knowledgeList = extractKnowledgeList(knowledge);

  const context = {
    articles,
    knowledgeList,
    seenFingerprints: new Set(),
    seenStoryIds: new Set(),
  };

  const decisions = [];
  for (const story of storyList) {
    const storyId = asString(story?.id) || "(unknown)";
    const result = decideStory(story, context);
    context.seenFingerprints.add(result.fingerprint);
    if (asString(story?.id)) context.seenStoryIds.add(asString(story.id));

    decisions.push({
      storyId,
      decision: result.decision,
      reason: result.reason.slice(),
    });
  }

  return decisions;
}

/**
 * Merge decisions into an existing editor.json payload without removing topics.
 */
function mergeDecisionsIntoEditorView(editorView, decisions) {
  const base =
    editorView && typeof editorView === "object" && !Array.isArray(editorView)
      ? { ...editorView }
      : {};
  return {
    ...base,
    decisions: Array.isArray(decisions) ? decisions : [],
  };
}

module.exports = {
  buildEditorDecisions,
  mergeDecisionsIntoEditorView,
  decideStory,
  collectStoryPosts,
  isQuestionOnly,
  isPromoOnly,
  extractStoriesList,
  extractEditorialArticles,
  extractKnowledgeList,
};
