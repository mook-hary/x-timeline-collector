/**
 * Editorial Brief v2 — Story → editorial instruction (not article body).
 * Deterministic. No AI. No invented facts.
 */

const {
  extractStoriesList,
  selectRepresentativeConcept,
  selectRepresentativeTopic,
  collectPosts,
  extractEventOrWorkTitle,
  extractVenue,
  extractPeriod,
  proseFromPostText,
  formatPostedAt,
  looksLikeSlashLabel,
} = require("./writer-content");

const GENERIC_CATEGORY_RE =
  /^(制作・クリエイティブ技術|アニメ・漫画|ゲーム・ゲーム開発|注目の話題|その他|テクノロジー|エンタメ)$/;

const ANGLE_ORDER = [
  { angle: "終了間近", re: /来週閉幕|閉幕|終了間近|会期終了/ },
  { angle: "価格変更", re: /価格|値上げ|値下げ|料金|円/ },
  { angle: "アップデート", re: /アップデート|アップデート|バージョンアップ|update/i },
  { angle: "新サービス発表", re: /新サービス|ローンチ|正式発表|リリース/ },
  { angle: "イベント開催", re: /開催|展覧会|展示|イベント|フェア|カンファレンス/ },
  { angle: "制作手法", re: /制作|描き方|手法|ワークフロー|油彩|イラスト/ },
  { angle: "用語・疑問", re: /[？?]|いつ頃|だっけ|教えて|とは何/ },
];

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensurePeriod(text) {
  let t = asString(text);
  if (!t) return "";
  if (!/[。．!?？]$/.test(t)) t = `${t}。`;
  return t;
}

function isQuestionOnly(text) {
  const t = asString(text);
  if (!t) return false;
  if (!/[？?]/.test(t) && !/だっけ|いつ頃|教えて/.test(t)) return false;
  // Short question without explanatory answer body.
  return t.length <= 120;
}

function blobFrom(concept, topic, posts) {
  return [
    asString(concept?.summary),
    asString(topic?.summary),
    ...posts.map((p) => asString(p?.text)),
    ...posts.map((p) => asString(p?.enrichment?.summary)),
    ...posts.map((p) => asString(p?.enrichment?.reason)),
  ].join("\n");
}

function selectAngle(blob, posts) {
  for (const item of ANGLE_ORDER) {
    if (item.re.test(blob)) return item.angle;
  }
  if (posts.some((p) => isQuestionOnly(p?.text))) return "用語・疑問";
  return "情報共有";
}

function selectWhyNow(blob) {
  if (/来週閉幕|閉幕|終了間近|会期終了/.test(blob)) return "終了日が近い";
  if (/今日|本日/.test(blob)) return "今日の話題として確認できる";
  if (/開催中|今夏開催|開催\.|が開催/.test(blob)) return "イベントが開催されている";
  if (/アップデート|バージョンアップ/.test(blob)) return "アップデート情報がある";
  if (/発表|ローンチ|リリース/.test(blob)) return "発表・公開の情報がある";
  return "";
}

function selectAudience(story, concept, blob) {
  // Only when a clear audience cue exists in tags/labels/text — no guessing.
  const tags = [
    ...(Array.isArray(story?.tags) ? story.tags : []),
    ...(Array.isArray(concept?.tags) ? concept.tags : []),
  ]
    .map(asString)
    .filter(Boolean);

  const pool = `${tags.join(" ")} ${blob}`;
  const rules = [
    { audience: "アニメーター", re: /アニメーター|作画|原画/ },
    { audience: "ゲーム開発者", re: /ゲーム開発|Unity|Unreal|ゲームエンジン/ },
    { audience: "クリエイター", re: /クリエイター|イラストレーター|デザイナー/ },
    { audience: "一般ユーザー", re: /一般ユーザー|一般向け/ },
  ];
  for (const rule of rules) {
    if (rule.re.test(pool)) return rule.audience;
  }
  return "";
}

function buildHeadline(concept, topic, posts, story) {
  const storyLabel = asString(story?.label);
  const summary = asString(concept?.summary) || asString(topic?.summary);
  const prose = proseFromPostText(posts[0]?.text);
  const work =
    extractEventOrWorkTitle(
      [summary, asString(posts[0]?.enrichment?.summary), prose],
      storyLabel
    ) || "";
  const period = extractPeriod(asString(posts[0]?.text)) || extractPeriod(summary);
  const closingDay = (() => {
    if (!period) return "";
    // Prefer range end: 「5月26日から7月26日まで」 / 「5/26〜7/26」
    const fromTo = period.match(
      /から\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/
    );
    if (fromTo) return `${fromTo[1]}月${fromTo[2]}日`;
    const end = period.match(
      /[〜~\-－]\s*(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/
    );
    if (end) return `${end[1]}月${end[2]}日`;
    const single = period.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (single) return `${single[1]}月${single[2]}日`;
    return "";
  })();

  if (work && closingDay && /閉幕|終了|来週閉幕/.test(`${summary}\n${prose}`)) {
    const base = work.replace(/（[^）]+）$/, "");
    return `${base}が${closingDay}閉幕`;
  }
  if (work) {
    const venue = extractVenue(summary) || extractVenue(prose);
    if (venue && !work.includes(venue)) return `${work.replace(/（[^）]+）$/, "")}が${venue}で開催`;
    return work;
  }

  const conceptLabel = asString(concept?.label);
  if (conceptLabel && !GENERIC_CATEGORY_RE.test(conceptLabel)) {
    if (looksLikeSlashLabel(conceptLabel)) {
      const parts = conceptLabel.split(/\s*\/\s*/).filter(Boolean);
      const skip = new Set(["展覧会", "書籍", "新刊", "展示", "話題"]);
      const picked = parts.filter((p) => !skip.has(p));
      if (picked.length >= 2) return `${picked[0]}（${picked[1]}）`;
      if (picked.length === 1) return picked[0];
    }
    return conceptLabel;
  }

  if (summary && !GENERIC_CATEGORY_RE.test(summary)) {
    return summary.length > 60 ? `${summary.slice(0, 59)}…` : summary;
  }

  if (prose) {
    const first = prose.split(/[。．]/)[0] || prose;
    if (first && !GENERIC_CATEGORY_RE.test(first)) {
      return first.length > 60 ? `${first.slice(0, 59)}…` : first;
    }
  }

  // Last resort: avoid pure category if possible
  if (storyLabel && !GENERIC_CATEGORY_RE.test(storyLabel)) return storyLabel;
  return summary || conceptLabel || storyLabel || "(untitled)";
}

function buildLead(concept, topic, posts) {
  const summary =
    asString(concept?.summary) ||
    asString(topic?.summary) ||
    asString(posts[0]?.enrichment?.summary);
  const prose = proseFromPostText(posts[0]?.text);
  const venue =
    extractVenue(summary) ||
    extractVenue(prose) ||
    extractVenue(asString(posts[0]?.text));
  const period =
    extractPeriod(asString(posts[0]?.text)) || extractPeriod(summary);
  const work =
    extractEventOrWorkTitle([summary, prose], "") ||
    "";
  const sentences = [];

  if (venue && work) {
    sentences.push(
      ensurePeriod(
        `${venue}では、${work.replace(/（[^）]+）$/, "")}が開催されています`
      )
    );
  } else if (summary) {
    sentences.push(ensurePeriod(summary.split(/[。．]/)[0] || summary));
  } else if (prose) {
    sentences.push(ensurePeriod(prose.split(/[。．]/)[0] || prose));
  }

  if (period) {
    if (/来週閉幕|閉幕|終了/.test(`${summary}\n${prose}`)) {
      sentences.push(
        ensurePeriod(`会期は${period}で、終了まで残り少なくなっています`)
      );
    } else {
      sentences.push(ensurePeriod(`会期は${period}です`));
    }
  }

  return sentences.slice(0, 3).join("");
}

function buildKeyFacts(concept, topic, posts) {
  const facts = [];
  const seen = new Set();
  const add = (fact) => {
    const f = asString(fact);
    if (!f || seen.has(f)) return;
    seen.add(f);
    facts.push(f);
  };

  const summary = asString(concept?.summary) || asString(topic?.summary);
  const raw = asString(posts[0]?.text);
  const work = extractEventOrWorkTitle(
    [summary, asString(posts[0]?.enrichment?.summary), proseFromPostText(raw)],
    ""
  );
  if (work) add(`作品・イベント: ${work.replace(/（[^）]+）$/, "")}`);

  const period = extractPeriod(raw) || extractPeriod(summary);
  if (period) add(`会期: ${period}`);

  const venue = extractVenue(raw) || extractVenue(summary);
  if (venue) add(`会場: ${venue}`);

  if (/来週閉幕|閉幕/.test(`${summary}\n${raw}`)) add("状況: 閉幕が近い");

  const author = asString(posts[0]?.authorName);
  if (author) add(`情報源投稿者: ${author}`);

  const when = formatPostedAt(posts[0]?.postedAt);
  if (when) add(`投稿日: ${when}`);

  // Numeric / price cues only when present in text.
  const price = raw.match(/(\d{1,3}(?:,\d{3})*円)/);
  if (price) add(`価格: ${price[1]}`);

  return facts.slice(0, 8);
}

function buildEvidenceEntries(posts) {
  return posts.map((post) => ({
    url: asString(post.url) || null,
    authorName: asString(post.authorName) || null,
    authorHandle: asString(post.authorHandle) || null,
    postedAt: asString(post.postedAt) || null,
    text: asString(post.text) || "",
  }));
}

function buildRisks(posts, blob, angle) {
  const risks = [];
  const texts = posts.map((p) => asString(p.text)).join("\n");

  if (posts.some((p) => isQuestionOnly(p?.text)) || angle === "用語・疑問") {
    risks.push("質問のみ。回答や歴史的事実を書かない");
  }

  if (
    /(美術館|博物館|会場|開催)/.test(blob) &&
    !/営業時間|開館時間|入場料|チケット/.test(texts)
  ) {
    risks.push("営業時間・チケット情報は入力にないため書かない");
  }

  if (angle === "価格変更" && !/価格|円|料金/.test(texts)) {
    risks.push("具体的な価格は入力にないため書かない");
  }

  if (posts.length === 0) {
    risks.push("投稿本文が無いため断定を避ける");
  }

  return [...new Set(risks)];
}

function findStoryForKnowledge(storiesList, knowledge) {
  const id = asString(knowledge?.id);
  if (!id) return null;
  const byId = storiesList.find((s) => asString(s.id) === id);
  if (byId) return byId;

  // Evidence story refs on knowledge
  const refs = [
    ...(Array.isArray(knowledge?.evidence?.stories)
      ? knowledge.evidence.stories
      : []),
    ...(Array.isArray(knowledge?.stories) ? knowledge.stories : []),
  ]
    .map(asString)
    .filter(Boolean);
  for (const ref of refs) {
    const found = storiesList.find((s) => asString(s.id) === ref);
    if (found) return found;
  }
  return null;
}

/**
 * Build one editorial article instruction from a Story (+ representative concept).
 */
function buildEditorialArticle(story, knowledge) {
  if (!story || typeof story !== "object") return null;

  const concept = selectRepresentativeConcept(story);
  const topic = concept ? selectRepresentativeTopic(concept) : null;
  const posts = collectPosts(story, concept, topic);
  const blob = blobFrom(concept, topic, posts);

  const angle = selectAngle(blob, posts);
  return {
    knowledgeId: asString(knowledge?.id) || asString(story.id) || null,
    storyId: asString(story.id) || null,
    headline: buildHeadline(concept, topic, posts, story),
    lead: buildLead(concept, topic, posts),
    angle,
    whyNow: selectWhyNow(blob),
    audience: selectAudience(story, concept, blob),
    keyFacts: buildKeyFacts(concept, topic, posts),
    evidence: buildEvidenceEntries(posts),
    risks: buildRisks(posts, blob, angle),
  };
}

/**
 * Build editorial block from stories payload + knowledge list.
 * Returns { version: 2, articles: [...] } or null when no usable story content.
 */
function buildEditorialFromStories(storiesInput, knowledgeList) {
  const storiesList = extractStoriesList(storiesInput);
  const list = Array.isArray(knowledgeList) ? knowledgeList : [];
  if (storiesList.length === 0 || list.length === 0) {
    return { version: 2, articles: [] };
  }

  const articles = [];
  const usedStoryIds = new Set();

  for (const knowledge of list) {
    const story = findStoryForKnowledge(storiesList, knowledge);
    if (!story) continue;
    const sid = asString(story.id);
    if (sid && usedStoryIds.has(sid)) continue;
    const article = buildEditorialArticle(story, knowledge);
    if (!article) continue;
    if (sid) usedStoryIds.add(sid);
    articles.push(article);
  }

  // If knowledge ids did not match, still try first story once (safe fallback).
  if (articles.length === 0 && storiesList[0]) {
    const article = buildEditorialArticle(storiesList[0], list[0]);
    if (article) articles.push(article);
  }

  return { version: 2, articles };
}

function validateEditorial(editorial, errors) {
  if (editorial == null) return;
  if (typeof editorial !== "object" || Array.isArray(editorial)) {
    errors.push("editorial はオブジェクトである必要があります。");
    return;
  }
  if (editorial.version !== 2) {
    errors.push("editorial.version は 2 である必要があります。");
  }
  if (!Array.isArray(editorial.articles)) {
    errors.push("editorial.articles は配列である必要があります。");
    return;
  }
  for (let i = 0; i < editorial.articles.length; i++) {
    const a = editorial.articles[i];
    const prefix = `editorial.articles[${i}]`;
    if (!a || typeof a !== "object") {
      errors.push(`${prefix} はオブジェクトである必要があります。`);
      continue;
    }
    for (const key of ["headline", "lead", "angle"]) {
      if (typeof a[key] !== "string") {
        errors.push(`${prefix}.${key} は文字列である必要があります。`);
      }
    }
    if (typeof a.whyNow !== "string") {
      errors.push(`${prefix}.whyNow は文字列である必要があります（空可）。`);
    }
    if (typeof a.audience !== "string") {
      errors.push(`${prefix}.audience は文字列である必要があります（空可）。`);
    }
    if (!Array.isArray(a.keyFacts)) {
      errors.push(`${prefix}.keyFacts は配列である必要があります。`);
    }
    if (!Array.isArray(a.evidence)) {
      errors.push(`${prefix}.evidence は配列である必要があります。`);
    }
    if (!Array.isArray(a.risks)) {
      errors.push(`${prefix}.risks は配列である必要があります。`);
    }
    if (typeof a.headline === "string" && GENERIC_CATEGORY_RE.test(a.headline.trim())) {
      // warning-level would be nicer; validation stays non-fatal for fallback briefs.
      // Keep as soft check: do not fail validation (Story不足フォールバック).
    }
  }
}

module.exports = {
  buildEditorialFromStories,
  buildEditorialArticle,
  validateEditorial,
  selectAngle,
  selectWhyNow,
  buildHeadline,
  GENERIC_CATEGORY_RE,
};
