/**
 * Editorial Brief v2 cases.
 * Run: node test/brief-v2-test.js
 */
const assert = require("assert");
const { buildKnowledgeBrief, validateBrief } = require("../lib/brief-core");

function makeKnowledge(overrides = {}) {
  return {
    id: "creative-tech",
    title: "制作・クリエイティブ技術",
    summary: "イラスト、アニメ、ゲームなど制作・表現技術に関する話題",
    status: "published",
    stories: ["creative-tech"],
    concepts: [],
    posts: [],
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    confidence: 60,
    evidence: {
      stories: ["creative-tech"],
      concepts: [],
      posts: [],
    },
    notes: "",
    version: 1,
    ...overrides,
  };
}

const exhibitionPost = {
  authorName: "Tokyo Art Beat",
  authorHandle: "TokyoArtBeat_JP",
  postedAt: "2026-07-15T23:01:06.000Z",
  text: "【来週閉幕】東京都現代美術館で「(UN)KNOWN HIROKO KOSHINO ー新説／真説 コシノヒロコー」が今夏開催。他ジャンルとのコラボレーションでコシノヒロコの新しい姿を表現\n\n会期は5月26日から7月26日まで。",
  url: "https://x.com/TokyoArtBeat_JP/status/2077528913534706013",
  enrichment: {
    importance: 4,
    reason: "会期終了間近で来場予定や保存に有用な展覧会情報",
    summary:
      "『(UN)KNOWN HIROKO KOSHINO』展が東京都現代美術館で5/26〜7/26開催。来週閉幕、ジャンル横断のコラボ展示",
  },
};

const exhibitionStories = {
  stories: [
    {
      id: "creative-tech",
      label: "制作・クリエイティブ技術",
      description: "イラスト、アニメ、ゲームなど制作・表現技術に関する話題",
      concepts: [
        {
          label: "コシノヒロコ / 東京都現代美術館 / 展覧会",
          summary:
            "『(UN)KNOWN HIROKO KOSHINO』展が東京都現代美術館で5/26〜7/26開催。来週閉幕、ジャンル横断のコラボ展示",
          posts: [exhibitionPost],
          postCount: 1,
          maxImportance: 4,
          newestPostedAt: exhibitionPost.postedAt,
          topics: [
            {
              summary:
                "『(UN)KNOWN HIROKO KOSHINO』展が東京都現代美術館で5/26〜7/26開催。来週閉幕、ジャンル横断のコラボ展示",
              posts: [exhibitionPost],
              postCount: 1,
              maxImportance: 4,
            },
          ],
        },
      ],
      posts: [exhibitionPost],
      postCount: 1,
      tags: [],
    },
  ],
};

function case1Exhibition() {
  const brief = buildKnowledgeBrief(
    [makeKnowledge()],
    { stories: exhibitionStories, preserveOrder: true },
    { now: "2026-07-21T00:00:00.000Z" }
  );

  assert.ok(brief.editorial, "editorial present");
  assert.strictEqual(brief.editorial.version, 2);
  assert.strictEqual(brief.editorial.articles.length, 1);
  const article = brief.editorial.articles[0];

  assert.ok(
    /HIROKO KOSHINO|コシノヒロコ/.test(article.headline),
    `headline concrete: ${article.headline}`
  );
  assert.ok(
    article.headline !== "制作・クリエイティブ技術",
    "headline must not be category"
  );
  assert.ok(
    /7月26日/.test(article.headline) || /7\/26/.test(article.headline),
    `headline should use closing date: ${article.headline}`
  );
  assert.ok(article.lead.length > 10, "lead present");
  assert.strictEqual(article.angle, "終了間近");
  assert.ok(/終了|近い/.test(article.whyNow), `whyNow: ${article.whyNow}`);
  assert.ok(article.keyFacts.length >= 2, "keyFacts extracted");
  assert.ok(
    article.keyFacts.some((f) => /会期|会場|作品/.test(f)),
    "keyFacts include schedule/venue/work"
  );
  assert.ok(article.evidence.length >= 1, "evidence posts");
  assert.ok(
    article.evidence[0].url.includes("x.com"),
    "evidence has url"
  );

  // Legacy Writer fields remain
  assert.ok(Array.isArray(brief.claims) && brief.claims.length === 1);
  assert.ok(brief.claims[0].usable === true);
  assert.ok(brief.title !== "制作・クリエイティブ技術");

  const validated = validateBrief(brief);
  assert.strictEqual(validated.ok, true, validated.errors.join("\n"));
  console.log("PASS Case 1: exhibition editorial brief");
  console.log(
    JSON.stringify(
      {
        title: brief.title,
        headline: article.headline,
        angle: article.angle,
        whyNow: article.whyNow,
        keyFacts: article.keyFacts,
        risks: article.risks,
      },
      null,
      2
    )
  );
}

function case2Question() {
  const post = {
    authorName: "Aki",
    authorHandle: "nekoruri",
    postedAt: "2026-07-15T17:30:26.000Z",
    text: "版権じゃなくてIPって呼ぶのがメジャーになったのっていつ頃だっけ",
    url: "https://x.com/nekoruri/status/2077445700317843957",
    enrichment: {
      importance: 3,
      reason: "業界用語の変化に関する一般的な関心事のため",
      summary: "「版権」から「IP」と呼ぶようになった時期を尋ねる投稿",
    },
  };
  const stories = {
    stories: [
      {
        id: "creative-tech",
        label: "制作・クリエイティブ技術",
        description: "イラスト、アニメ、ゲームなど制作・表現技術に関する話題",
        concepts: [
          {
            label: "用語変遷 / IP / 版権",
            summary: "「版権」から「IP」と呼ぶようになった時期を尋ねる投稿",
            posts: [post],
            postCount: 1,
            maxImportance: 3,
            newestPostedAt: post.postedAt,
            topics: [
              {
                summary: "「版権」から「IP」と呼ぶようになった時期を尋ねる投稿",
                posts: [post],
                postCount: 1,
                maxImportance: 3,
              },
            ],
          },
        ],
        posts: [post],
        postCount: 1,
      },
    ],
  };

  const brief = buildKnowledgeBrief(
    [makeKnowledge()],
    { stories, preserveOrder: true },
    { now: "2026-07-21T00:00:00.000Z" }
  );
  const article = brief.editorial.articles[0];
  assert.ok(
    article.risks.some((r) => /質問のみ/.test(r)),
    `risks should mention question-only: ${article.risks.join("; ")}`
  );
  assert.ok(!/1980|1990|著作権法/.test(article.lead + article.headline));
  assert.ok(
    article.angle === "用語・疑問" || /IP|版権|用語/.test(article.headline)
  );
  console.log("PASS Case 2: short question");
}

function case3Fallback() {
  // No stories option → legacy brief, no crash
  const legacy = buildKnowledgeBrief(
    [makeKnowledge()],
    { preserveOrder: true },
    { now: "2026-07-21T00:00:00.000Z" }
  );
  assert.ok(!legacy.editorial, "no editorial without stories");
  assert.ok(legacy.claims.length === 1);

  // Stories present but empty of concepts/posts
  const thin = buildKnowledgeBrief(
    [makeKnowledge()],
    {
      stories: {
        stories: [
          {
            id: "creative-tech",
            label: "制作・クリエイティブ技術",
            description: "",
            concepts: [],
            posts: [],
            postCount: 0,
          },
        ],
      },
      preserveOrder: true,
    },
    { now: "2026-07-21T00:00:00.000Z" }
  );
  assert.ok(thin.editorial);
  assert.ok(Array.isArray(thin.editorial.articles));
  assert.strictEqual(validateBrief(thin).ok, true);
  console.log("PASS Case 3: fallback / thin story");
}

function main() {
  case1Exhibition();
  case2Question();
  case3Fallback();
  console.log("\nAll Brief v2 cases PASS");
}

main();
