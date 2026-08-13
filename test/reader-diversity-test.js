/**
 * READER-QUALITY-001 — Reader primary-slot diversity.
 * Run: node test/reader-diversity-test.js
 */
const assert = require("assert");
const {
  diversifyReaderSlots,
  getLinkedArticleKey,
} = require("../lib/reader-diversity");
const { selectTodayPicks } = require("../lib/today-picks");
const { buildDigest } = require("../digest");
const {
  DEFAULT_DIGEST_CONFIG,
  mergeDigestConfig,
} = require("../lib/digest-core");

function post(overrides = {}) {
  const {
    url = "https://x.com/user/status/1",
    text = "本文テキストです",
    category = "AI",
    importance = 4,
    summary = "十分な長さのある要約テキストです。",
    reason = "注目理由あり",
    tags = ["unique-tag"],
    postedAt = "2026-07-14T12:00:00.000Z",
    authorHandle = "@user",
    ...rest
  } = overrides;
  return {
    postedAt,
    url,
    text,
    authorHandle,
    authorName: "User",
    finalAnalysis: { category, tags, ...(rest.finalAnalysis || {}) },
    enrichment: {
      importance,
      summary,
      reason,
      tags,
      ...(rest.enrichment || {}),
    },
    ...rest,
  };
}

// --- Same linked article: only one in primary ---
{
  const article = "https://news.example.com/story/abc";
  const posts = [
    post({
      url: "https://x.com/a/status/101",
      importance: 5,
      summary: `記事紹介 ${article}`,
      text: `読むべき ${article}`,
      tags: ["story-abc"],
      authorHandle: "@a",
    }),
    post({
      url: "https://x.com/b/status/102",
      importance: 4,
      summary: `同じ記事 ${article}`,
      text: `別ユーザーが紹介 ${article}`,
      tags: ["story-abc"],
      authorHandle: "@b",
      postedAt: "2026-07-14T11:00:00.000Z",
    }),
    post({
      url: "https://x.com/c/status/103",
      importance: 5,
      summary: "全く別のトピックである量子計算の進展について。",
      text: "量子計算の進展 https://other.example.com/q",
      tags: ["quantum"],
      authorHandle: "@c",
      postedAt: "2026-07-14T10:00:00.000Z",
    }),
  ];

  const { primary, overflow } = diversifyReaderSlots(posts, 3, {
    topicCap: 1,
    linkCap: 1,
  });

  assert.strictEqual(primary.length, 2);
  assert.strictEqual(overflow.length, 1);
  assert.strictEqual(primary[0].url, "https://x.com/a/status/101");
  assert.ok(primary.some((p) => p.url === "https://x.com/c/status/103"));
  assert.strictEqual(overflow[0].url, "https://x.com/b/status/102");
  assert.strictEqual(
    getLinkedArticleKey(posts[0]),
    getLinkedArticleKey(posts[1])
  );
  console.log("RQ001 linked-article primary cap PASS");
}

// --- Exact URL duplicate only once ---
{
  const posts = [
    post({
      url: "https://x.com/a/status/200",
      importance: 5,
      summary: "同一URL投稿Aの固有要約テキストです。",
      tags: ["url-a"],
    }),
    post({
      url: "https://x.com/a/status/200?utm_source=x",
      importance: 4,
      summary: "同一URL投稿Bの固有要約テキストです。",
      tags: ["url-b"],
      authorHandle: "@other",
    }),
    post({
      url: "https://x.com/a/status/201",
      importance: 4,
      summary: "別ステータスの固有要約テキストです。",
      tags: ["url-c"],
      authorHandle: "@third",
    }),
  ];
  const { primary, overflow } = diversifyReaderSlots(posts, 3);
  assert.strictEqual(primary.length, 2);
  assert.strictEqual(overflow.length, 1);
  console.log("RQ001 exact-url primary cap PASS");
}

// --- Different topics kept; same topic capped then relaxed to fill ---
{
  const posts = [
    post({
      url: "https://x.com/a/status/301",
      importance: 5,
      summary: "トピック甲に関する独自の要約テキストです。",
      tags: ["topic-甲"],
      authorHandle: "@a",
    }),
    post({
      url: "https://x.com/b/status/302",
      importance: 4,
      summary: "トピック甲の別角度だが同一タグです。",
      tags: ["topic-甲"],
      authorHandle: "@b",
    }),
    post({
      url: "https://x.com/c/status/303",
      importance: 4,
      summary: "トピック乙に関する独自の要約テキストです。",
      tags: ["topic-乙"],
      authorHandle: "@c",
    }),
  ];
  const strict = diversifyReaderSlots(posts, 2, { topicCap: 1 });
  assert.strictEqual(strict.primary.length, 2);
  assert.ok(strict.primary.some((p) => p.url.includes("301")));
  assert.ok(strict.primary.some((p) => p.url.includes("303")));
  assert.strictEqual(strict.overflow[0].url.includes("302"), true);

  // Link/URL uniqueness still holds; topic relax can fill remaining slots.
  const fill = diversifyReaderSlots(posts, 3, { topicCap: 1 });
  assert.strictEqual(fill.primary.length, 3);
  assert.strictEqual(fill.overflow.length, 0);
  console.log("RQ001 topic diversity PASS");
}

// --- buildDigest: morePosts carry overflow; source list length unchanged ---
{
  const article = "https://www.reuters.com/world/demo-story";
  const source = [];
  for (let i = 0; i < 6; i++) {
    source.push(
      post({
        url: `https://x.com/u/status/${400 + i}`,
        importance: 5 - (i % 2),
        summary:
          i < 3
            ? `同一記事の紹介 ${article} 投稿${i}`
            : `別件ニュース${i}の固有要約テキストです。`,
        text:
          i < 3
            ? `リンク ${article}`
            : `https://news.example.com/item/${i}`,
        tags: i < 3 ? ["same-story"] : [`unique-${i}`],
        authorHandle: `@u${i}`,
        postedAt: `2026-07-14T0${i}:00:00.000Z`,
      })
    );
  }
  const sourceLen = source.length;
  const config = mergeDigestConfig({
    ...DEFAULT_DIGEST_CONFIG,
    categoryDisplayLimit: 3,
    topMinimumImportance: 1,
  });
  const digest = buildDigest(
    source,
    { top: 2 },
    {
      hasRange: false,
      mode: "all",
      rangeJson: null,
      labelFrom: "",
      labelTo: "",
    },
    config
  );

  assert.strictEqual(source.length, sourceLen);
  const ai = digest.categories.find((c) => c.category === "AI");
  assert.ok(ai);
  assert.strictEqual(ai.count, 6);
  assert.ok(ai.posts.length <= 3);
  assert.ok(Array.isArray(ai.morePosts));
  assert.strictEqual(ai.posts.length + ai.morePosts.length, 6);

  const primaryLinks = ai.posts
    .map((p) => getLinkedArticleKey({ enrichment: { summary: p.summary }, text: p.text, url: p.url }))
    .filter(Boolean);
  const uniquePrimaryLinks = new Set(primaryLinks);
  // Same reuters story should not appear more than once in primary.
  assert.ok(uniquePrimaryLinks.size === primaryLinks.length);
  console.log("RQ001 buildDigest morePosts PASS");
}

// --- Today's Picks: same linked article does not occupy multiple picks ---
{
  const article = "https://tech.example.com/launch";
  const posts = [
    post({
      url: "https://x.com/a/status/501",
      importance: 5,
      summary: `ローンチ記事 ${article}`,
      text: `必読 ${article}`,
      tags: ["launch"],
      authorHandle: "@a",
      category: "プログラミング・IT",
    }),
    post({
      url: "https://x.com/b/status/502",
      importance: 5,
      summary: `同じローンチ ${article}`,
      text: `共有 ${article}`,
      tags: ["launch"],
      authorHandle: "@b",
      category: "プログラミング・IT",
      postedAt: "2026-07-14T11:00:00.000Z",
    }),
    post({
      url: "https://x.com/c/status/503",
      importance: 5,
      summary: "別製品の独自リリースノート要約テキストです。",
      text: "https://tech.example.com/other-product",
      tags: ["other-product"],
      authorHandle: "@c",
      category: "プログラミング・IT",
      postedAt: "2026-07-14T10:00:00.000Z",
    }),
  ];
  const picks = selectTodayPicks(posts, 3);
  const pickUrls = picks.map((p) => p.url);
  assert.ok(pickUrls.includes("https://x.com/a/status/501"));
  assert.ok(!pickUrls.includes("https://x.com/b/status/502"));
  assert.ok(pickUrls.includes("https://x.com/c/status/503"));
  assert.strictEqual(posts.length, 3);
  console.log("RQ001 today-picks linked-article PASS");
}

console.log("reader-diversity-test: ALL PASS");
