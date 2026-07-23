/**
 * EP-027 — Editorial score tests.
 * Run: node test/editorial-score-test.js
 */
const assert = require("assert");
const {
  scoreEditorialPost,
  excludeDuplicateEditorialPosts,
  rankEditorialPosts,
  AD_PENALTY,
  OTHER_PENALTY,
} = require("../lib/editorial-score");

function basePost(overrides = {}) {
  return {
    url: "https://x.com/u/status/1",
    finalAnalysis: { category: "AI", tags: ["LLM"] },
    enrichment: {
      importance: 4,
      summary: "有用な要約がここにある程度の長さで書かれている。",
      reason: "学習に役立つため",
      tags: ["AI"],
    },
    ...overrides,
  };
}

// --- importance missing still scores ---
{
  const withImp = scoreEditorialPost(
    basePost({
      enrichment: {
        summary: "要約あり。十分な長さの説明文です。",
        reason: "根拠あり",
        tags: [],
      },
    })
  );
  // strip importance explicitly
  const noImp = scoreEditorialPost({
    url: "https://x.com/u/status/2",
    finalAnalysis: { category: "AI", tags: [] },
    enrichment: {
      summary: "要約あり。十分な長さの説明文です。",
      reason: "根拠あり",
      tags: [],
    },
  });
  assert.ok(Number.isFinite(noImp));
  assert.ok(noImp > 0);
  // With importance should score higher when other fields match closely
  const withImp2 = scoreEditorialPost({
    url: "https://x.com/u/status/2",
    finalAnalysis: { category: "AI", tags: [] },
    enrichment: {
      importance: 5,
      summary: "要約あり。十分な長さの説明文です。",
      reason: "根拠あり",
      tags: [],
    },
  });
  assert.ok(withImp2 > noImp);
  assert.ok(Number.isFinite(withImp));
  console.log("importance-missing PASS");
}

// --- summary boosts score ---
{
  const withSummary = scoreEditorialPost({
    url: "https://x.com/u/status/3",
    finalAnalysis: { category: "仕事・キャリア" },
    enrichment: {
      importance: 3,
      summary: "キャリア形成について具体的な助言をまとめた投稿。",
      reason: "",
      tags: [],
    },
  });
  const withoutSummary = scoreEditorialPost({
    url: "https://x.com/u/status/3",
    finalAnalysis: { category: "仕事・キャリア" },
    enrichment: {
      importance: 3,
      summary: "",
      reason: "",
      tags: [],
    },
  });
  const placeholder = scoreEditorialPost({
    url: "https://x.com/u/status/3",
    finalAnalysis: { category: "仕事・キャリア" },
    enrichment: {
      importance: 3,
      summary: "要約なし",
      reason: "",
      tags: [],
    },
  });
  assert.ok(withSummary > withoutSummary);
  assert.ok(withSummary > placeholder);
  console.log("summary-bonus PASS");
}

// --- ads penalized ---
{
  const normal = scoreEditorialPost({
    url: "https://x.com/u/status/4",
    finalAnalysis: { category: "ニュース・報道" },
    enrichment: {
      importance: 3,
      summary: "報道の要約テキストがここにあります。",
      reason: "注目",
      tags: ["news"],
    },
  });
  const ad = scoreEditorialPost({
    url: "https://x.com/u/status/5",
    finalAnalysis: { category: "広告・PR" },
    enrichment: {
      importance: 3,
      summary: "報道の要約テキストがここにあります。",
      reason: "注目",
      tags: ["news"],
    },
  });
  assert.ok(ad < normal);
  assert.ok(normal - ad >= AD_PENALTY - 5);
  console.log("ad-penalty PASS");
}

// --- その他 mildly penalized ---
{
  const known = scoreEditorialPost({
    url: "https://x.com/u/status/6",
    finalAnalysis: { category: "生活・健康" },
    enrichment: { importance: 2, summary: "短い要約", tags: [] },
  });
  const other = scoreEditorialPost({
    url: "https://x.com/u/status/7",
    finalAnalysis: { category: "その他" },
    enrichment: { importance: 2, summary: "短い要約", tags: [] },
  });
  assert.ok(other < known);
  assert.ok(known - other >= OTHER_PENALTY - 2);
  console.log("other-penalty PASS");
}

// --- duplicate URL exclusion ---
{
  const posts = [
    { url: "https://x.com/a/status/1", enrichment: { summary: "A" } },
    { url: "https://x.com/a/status/1", enrichment: { summary: "A-dup" } },
    { url: "https://x.com/b/status/2", enrichment: { summary: "B" } },
    { url: "HTTPS://X.COM/A/STATUS/1", enrichment: { summary: "A-case" } },
  ];
  const deduped = excludeDuplicateEditorialPosts(posts);
  assert.strictEqual(deduped.length, 2);
  assert.strictEqual(deduped[0].enrichment.summary, "A");
  assert.strictEqual(deduped[1].enrichment.summary, "B");

  const ranked = rankEditorialPosts([
    {
      url: "https://x.com/a/status/9",
      finalAnalysis: { category: "広告・PR" },
      enrichment: { importance: 5, summary: "広告まとめ" },
    },
    {
      url: "https://x.com/a/status/9",
      finalAnalysis: { category: "AI" },
      enrichment: { importance: 5, summary: "重複は除外されるべき" },
    },
    {
      url: "https://x.com/c/status/10",
      finalAnalysis: { category: "AI" },
      enrichment: {
        importance: 5,
        summary: "本命の要約。かなり長い文章で加点される。",
        reason: "有用",
        tags: ["x"],
      },
    },
  ]);
  assert.strictEqual(ranked.length, 2);
  assert.ok(ranked[0].editorialScore >= ranked[1].editorialScore);
  console.log("dedupe PASS");
}

// --- deterministic ---
{
  const post = basePost();
  const a = scoreEditorialPost(post);
  const b = scoreEditorialPost(post);
  const c = scoreEditorialPost(JSON.parse(JSON.stringify(post)));
  assert.strictEqual(a, b);
  assert.strictEqual(a, c);

  const ctx = { digestSelected: true, personalScore: 40 };
  assert.strictEqual(
    scoreEditorialPost(post, ctx),
    scoreEditorialPost(post, ctx)
  );
  assert.ok(scoreEditorialPost(post, ctx) > scoreEditorialPost(post));
  console.log("deterministic PASS");
}

// --- digest selection / toPostJson shape ---
{
  const digestShaped = {
    url: "https://x.com/u/status/11",
    category: "プログラミング・IT",
    importance: 4,
    summary: "API設計の要点を短くまとめた投稿。",
    reason: "実務向け",
    tags: ["API"],
    personalScore: 52,
    digestSelected: true,
  };
  const score = scoreEditorialPost(digestShaped);
  assert.ok(score > scoreEditorialPost({ ...digestShaped, digestSelected: false }));
  console.log("digest-shaped PASS");
}

console.log("editorial-score-test: ALL PASS");
