/**
 * EP-005 — Editor Ranking for accept decisions only.
 * Deterministic. No AI. Does not control Writer / Daily Edition yet.
 */

const {
  collectStoryPosts,
  extractStoriesList,
  extractEditorialArticles,
  extractKnowledgeList,
} = require("./editor-decision");
const {
  selectRepresentativeConcept,
  selectRepresentativeTopic,
} = require("./writer-content");
const { validateAndBuildEditContext } = require("./writer-editorial-validate");
const { hasEditorialContent } = require("./writer-editorial");

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePostedAtMs(value) {
  const t = asString(value);
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function storyById(stories, storyId) {
  const id = asString(storyId);
  if (!id) return null;
  return stories.find((s) => asString(s?.id) === id) || null;
}

function dedupeEvidencePosts(posts) {
  const out = [];
  const seen = new Set();
  for (const post of posts) {
    const url = asString(post?.url);
    const key = url
      ? `url:${url}`
      : `t:${asString(post?.authorHandle)}|${asString(post?.postedAt)}|${asString(
          post?.text
        )}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(post);
  }
  return out;
}

function scoreEvidence(posts) {
  const n = dedupeEvidencePosts(posts).filter(
    (p) => asString(p.url) || asString(p.text).length >= 8
  ).length;
  if (n <= 0) return 0;
  if (n === 1) return 15;
  if (n === 2) return 22;
  return 30;
}

function newestStoryMs(story, posts) {
  const candidates = [];
  const push = (v) => {
    const ms = parsePostedAtMs(v);
    if (ms != null) candidates.push(ms);
  };
  push(story?.newestPostedAt);
  push(story?.updatedAt);
  for (const post of posts) {
    push(post?.postedAt);
    push(post?.collectedAt);
  }
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

/**
 * Relative freshness vs accepted cohort. No wall-clock dependency.
 */
function scoreFreshness(storyMs, cohortMs) {
  if (storyMs == null) return 0;
  const known = cohortMs.filter((ms) => ms != null);
  if (known.length === 0) return 0;
  const max = Math.max(...known);
  const min = Math.min(...known);
  if (max === min) return 25;
  const ratio = (storyMs - min) / (max - min);
  if (ratio >= 2 / 3) return 25;
  if (ratio >= 1 / 3) return 15;
  return 5;
}

function buildCorpusText(story, posts, knowledge) {
  const parts = [
    asString(story?.label),
    asString(story?.description),
    asString(knowledge?.title),
    asString(knowledge?.summary),
  ];
  for (const c of Array.isArray(story?.concepts) ? story.concepts : []) {
    parts.push(asString(c?.label), asString(c?.summary));
  }
  for (const post of posts) {
    parts.push(asString(post?.text));
    parts.push(asString(post?.enrichment?.summary));
    parts.push(asString(post?.enrichment?.reason));
  }
  return parts.join("\n");
}

function scorePublicInterest(story, posts, knowledge) {
  const text = buildCorpusText(story, posts, knowledge);
  if (!text) return 0;

  // Do not award for question-only / promo-only corpora.
  const allQuestion =
    posts.length > 0 &&
    posts.every((p) => {
      const t = asString(p.text);
      return (
        t.length <= 120 &&
        (/[？?]/.test(t) || /だっけ|いつ頃|教えて/.test(t))
      );
    });
  if (allQuestion) return 0;

  const allPromo =
    posts.length > 0 &&
    posts.every((p) => {
      const t = asString(p.text);
      const cat =
        asString(p?.finalAnalysis?.category) || asString(p?.analysis?.category);
      return (
        cat === "広告・PR" ||
        /(今すぐフォロー|いいね＆RT|RT希望|宣伝[でだ]|広告です)/i.test(t)
      );
    });
  if (allPromo) return 0;

  let score = 0;
  if (/(開催|開始|終了|閉幕|発売|公開|リリース|ローンチ)/.test(text)) {
    score += 8;
  }
  if (/(価格|値上げ|値下げ|料金|運賃|制度|サービス変更|仕様変更)/.test(text)) {
    score += 6;
  }
  if (/(締切|終了日|会期|来週閉幕|応募終了)/.test(text)) {
    score += 4;
  }
  const authors = new Set(
    posts
      .map((p) => asString(p.authorHandle) || asString(p.authorName))
      .filter(Boolean)
  );
  if (authors.size >= 2) score += 2;

  return Math.min(20, score);
}

function buildStoryCtx(story) {
  const concept = selectRepresentativeConcept(story);
  const topic = concept ? selectRepresentativeTopic(concept) : null;
  const posts = collectStoryPosts(story);
  return { story, concept, topic, posts };
}

function findEditorialArticle(articles, storyId) {
  const id = asString(storyId);
  for (const a of articles) {
    if (asString(a?.storyId) === id && hasEditorialContent(a)) return a;
  }
  for (const a of articles) {
    if (asString(a?.knowledgeId) === id && hasEditorialContent(a)) return a;
  }
  return null;
}

/**
 * editorialReadiness: 0 | 8 | 15 using validated edit context when possible.
 */
function scoreEditorialReadiness(article, storyCtx) {
  if (!article || !hasEditorialContent(article)) return 0;

  let edit = null;
  try {
    edit = validateAndBuildEditContext(article, storyCtx);
  } catch {
    edit = null;
  }

  if (!edit || !edit.usedEditorial) return 0;

  const rejected = new Set(
    Array.isArray(edit.validation?.rejectedFields)
      ? edit.validation.rejectedFields
      : []
  );

  let usable = 0;
  if (asString(edit.headline) && !rejected.has("headline")) usable += 1;
  if (asString(edit.lead) && !rejected.has("lead")) usable += 1;
  if (asString(edit.angle)) usable += 1;
  if (asString(edit.whyNow) && !rejected.has("whyNow")) usable += 1;
  if (Array.isArray(edit.keyFacts) && edit.keyFacts.length > 0) usable += 1;

  if (usable >= 4) return 15;
  if (usable >= 1) return 8;
  return 0;
}

function scoreInformationDensity(story, posts, edit) {
  const text = buildCorpusText(story, posts, null);
  const bits = new Set();

  if (/\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*[\/／]\s*\d{1,2}/.test(text)) {
    bits.add("date");
  }
  if (/(美術館|博物館|会場|ホール|劇場|駅|空港)/.test(text)) {
    bits.add("place");
  }
  if (
    posts.some((p) => asString(p.authorName) || asString(p.authorHandle)) ||
    /株式会社|主催|提供/.test(text)
  ) {
    bits.add("actor");
  }
  if (/(閉幕|開催中|終了間近|開始|延期|中止)/.test(text)) {
    bits.add("status");
  }
  if (/\d+\s*円|価格|料金|入場料/.test(text)) {
    bits.add("price");
  }
  if (/(向け|対象|一般|学生|クリエイター)/.test(text)) {
    bits.add("audience");
  }
  if (/(変更|値上げ|値下げ|アップデート|リニューアル)/.test(text)) {
    bits.add("change");
  }

  if (edit && Array.isArray(edit.keyFacts)) {
    for (const fact of edit.keyFacts) {
      const f = asString(fact);
      if (/会期|日/.test(f)) bits.add("date");
      if (/会場|美術館/.test(f)) bits.add("place");
      if (/状況|閉幕/.test(f)) bits.add("status");
      if (/価格|円/.test(f)) bits.add("price");
      if (/投稿者|主催/.test(f)) bits.add("actor");
    }
  }

  // Map distinct bit count → 0..10
  const n = bits.size;
  if (n <= 0) return 0;
  if (n === 1) return 2;
  if (n === 2) return 4;
  if (n === 3) return 6;
  if (n === 4) return 8;
  return 10;
}

function buildReasons(factors, story, edit) {
  const reasons = [];
  if (factors.evidence >= 22) reasons.push("複数の根拠がある");
  else if (factors.evidence >= 15) reasons.push("根拠投稿がある");

  const blob = [
    asString(story?.description),
    ...(Array.isArray(story?.concepts)
      ? story.concepts.map((c) => asString(c?.summary))
      : []),
  ].join("\n");
  if (/(終了|閉幕|締切|会期)/.test(blob) || asString(edit?.whyNow).includes("終了")) {
    reasons.push("終了日が近い");
  } else if (factors.freshness >= 25) {
    reasons.push("新しい情報である");
  }

  if (factors.editorialReadiness >= 15) {
    reasons.push("Editorialが利用可能");
  } else if (factors.editorialReadiness >= 8) {
    reasons.push("Editorialが一部利用可能");
  }

  if (factors.publicInterest >= 12 && reasons.length < 3) {
    reasons.push("明確な出来事がある");
  }

  return reasons.slice(0, 3);
}

function clampScore(n) {
  const x = Math.round(Number(n) || 0);
  if (x < 0) return 0;
  if (x > 100) return 100;
  return x;
}

function compareRankingEntries(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.factors.evidence !== b.factors.evidence) {
    return b.factors.evidence - a.factors.evidence;
  }
  if (a.factors.freshness !== b.factors.freshness) {
    return b.factors.freshness - a.factors.freshness;
  }
  if (a.factors.editorialReadiness !== b.factors.editorialReadiness) {
    return b.factors.editorialReadiness - a.factors.editorialReadiness;
  }
  return a.storyId.localeCompare(b.storyId);
}

/**
 * Build ranking[] for decision===accept stories only.
 */
function buildEditorRanking({
  stories,
  editorial,
  knowledge,
  decisions,
} = {}) {
  const storyList = extractStoriesList(stories);
  const articles = extractEditorialArticles(editorial);
  const knowledgeList = extractKnowledgeList(knowledge);
  const decisionList = Array.isArray(decisions) ? decisions : [];

  const acceptedIds = decisionList
    .filter((d) => d && d.decision === "accept" && asString(d.storyId))
    .map((d) => asString(d.storyId));

  const candidates = [];
  for (const storyId of acceptedIds) {
    const story = storyById(storyList, storyId);
    if (!story) continue;
    const posts = collectStoryPosts(story);
    const knowledgeItem =
      knowledgeList.find((k) => asString(k?.id) === storyId) || null;
    const article = findEditorialArticle(articles, storyId);
    const storyCtx = buildStoryCtx(story);
    let edit = null;
    if (article) {
      try {
        edit = validateAndBuildEditContext(article, storyCtx);
      } catch {
        edit = null;
      }
    }

    const newestMs = newestStoryMs(story, posts);
    candidates.push({
      storyId,
      story,
      posts,
      knowledgeItem,
      article,
      edit,
      newestMs,
    });
  }

  if (candidates.length === 0) return [];

  const cohortMs = candidates.map((c) => c.newestMs);
  const scored = candidates.map((c) => {
    const factors = {
      evidence: scoreEvidence(c.posts),
      freshness: scoreFreshness(c.newestMs, cohortMs),
      publicInterest: scorePublicInterest(c.story, c.posts, c.knowledgeItem),
      editorialReadiness: scoreEditorialReadiness(c.article, buildStoryCtx(c.story)),
      informationDensity: scoreInformationDensity(c.story, c.posts, c.edit),
    };
    const score = clampScore(
      factors.evidence +
        factors.freshness +
        factors.publicInterest +
        factors.editorialReadiness +
        factors.informationDensity
    );
    return {
      storyId: c.storyId,
      score,
      factors,
      reasons: buildReasons(factors, c.story, c.edit),
    };
  });

  scored.sort(compareRankingEntries);

  return scored.map((item, index) => ({
    storyId: item.storyId,
    rank: index + 1,
    score: item.score,
    factors: item.factors,
    reasons: item.reasons,
  }));
}

function mergeRankingIntoEditorView(editorView, ranking) {
  const base =
    editorView && typeof editorView === "object" && !Array.isArray(editorView)
      ? { ...editorView }
      : {};
  return {
    ...base,
    ranking: Array.isArray(ranking) ? ranking : [],
  };
}

module.exports = {
  buildEditorRanking,
  mergeRankingIntoEditorView,
  scoreEvidence,
  scoreFreshness,
  scorePublicInterest,
  scoreEditorialReadiness,
  scoreInformationDensity,
  compareRankingEntries,
};
