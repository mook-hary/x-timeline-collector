/**
 * Writer v2 acceptance cases (deterministic, no AI).
 * Run: node test/writer-v2-test.js
 */
const assert = require("assert");
const {
  renderMarkdown,
  validateWriterInput,
} = require("../lib/writer-core");
const {
  dedupePosts,
  buildStoryTitle,
  normalizeStoryContext,
  renderStoryArticle,
} = require("../lib/writer-content");

function makeBrief(overrides = {}) {
  return {
    id: "brief-test",
    title: "Daily 2026-07-21",
    purpose: "research-note",
    status: "draft",
    generatedAt: "2026-07-21T00:00:00.000Z",
    knowledge: [
      {
        id: "creative-tech",
        title: "制作・クリエイティブ技術",
        summary: "イラスト、アニメ、ゲームなど制作・表現技術に関する話題",
        status: "published",
        version: 1,
        confidence: 60,
        notes: "",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    ],
    claims: [
      {
        knowledgeId: "creative-tech",
        text: "イラスト、アニメ、ゲームなど制作・表現技術に関する話題",
        confidence: 60,
        evidenceCount: 1,
        usable: true,
        reason: null,
      },
    ],
    evidence: { stories: ["creative-tech"], concepts: [], posts: [] },
    evidenceProvenance: {
      stories: { "creative-tech": ["creative-tech"] },
      concepts: {},
      posts: {},
    },
    gaps: [],
    constraints: ["Knowledge summary にない事実を追加しない。"],
    sourceSnapshot: [
      {
        id: "creative-tech",
        version: 1,
        status: "published",
        updatedAt: "2026-07-21T00:00:00.000Z",
        title: "制作・クリエイティブ技術",
        confidence: 60,
        evidenceCount: 1,
      },
    ],
    statistics: {
      knowledgeCount: 1,
      claimCount: 1,
      usableClaimCount: 1,
      unusableClaimCount: 0,
      evidenceCount: 1,
      storyEvidenceCount: 1,
      conceptEvidenceCount: 0,
      postEvidenceCount: 0,
      gapCount: 0,
      lowConfidenceCount: 0,
      nonPublishedCount: 0,
      minimumConfidence: 60,
      maximumConfidence: 60,
      averageConfidence: 60,
    },
    ...overrides,
  };
}

function makePlan(title) {
  return {
    id: "plan-test",
    title,
    purpose: "explain",
    format: "article",
    language: "ja",
    audience: { description: "一般読者", knowledgeLevel: "unspecified" },
    tone: { style: "clear", formality: "neutral" },
    length: { unit: "characters", target: 600, minimum: 200, maximum: 1200 },
    structure: [
      { id: "introduction", label: "導入", required: true },
      { id: "body", label: "本文", required: true },
      { id: "conclusion", label: "まとめ", required: true },
    ],
    requiredPoints: [],
    excludedPoints: [],
    constraints: [],
    briefReference: {
      id: "brief-test",
      generatedAt: "2026-07-21T00:00:00.000Z",
      title: "Daily 2026-07-21",
      knowledgeIds: ["creative-tech"],
    },
    createdAt: "2026-07-21T00:00:00.000Z",
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
          conceptKey: "koshino",
          label: "コシノヒロコ / 東京都現代美術館 / 展覧会",
          summary:
            "『(UN)KNOWN HIROKO KOSHINO』展が東京都現代美術館で5/26〜7/26開催。来週閉幕、ジャンル横断のコラボ展示",
          posts: [exhibitionPost],
          postCount: 1,
          maxImportance: 4,
          newestPostedAt: "2026-07-15T23:01:06.000Z",
          topics: [
            {
              summary:
                "『(UN)KNOWN HIROKO KOSHINO』展が東京都現代美術館で5/26〜7/26開催。来週閉幕、ジャンル横断のコラボ展示",
              posts: [exhibitionPost],
              postCount: 1,
              maxImportance: 4,
              newestPostedAt: "2026-07-15T23:01:06.000Z",
            },
          ],
        },
      ],
      topics: [],
      posts: [exhibitionPost],
      postCount: 1,
      tags: ["art"],
    },
  ],
};

function case1Exhibition() {
  const brief = makeBrief();
  // Generic plan title so Writer polish may choose event name.
  const plan = makePlan("Daily 2026-07-21");
  const md = renderMarkdown(brief, plan, { stories: exhibitionStories });
  const visible = md.replace(/<!--[\s\S]*?-->/g, "");

  assert.ok(/^# 『\(UN\)KNOWN HIROKO KOSHINO』展/m.test(md), "event name in title");
  assert.ok(!/^# 制作・クリエイティブ技術$/m.test(md), "must not be category-only title");
  assert.ok(!/^# コシノヒロコ \//m.test(md), "must not be slash concept label title");
  assert.ok(md.includes("東京都現代美術館"), "venue in body");
  assert.ok(/7月26日|7\/26/.test(md), "closing date in body");
  assert.ok(md.includes("## 情報源"), "sources section");
  assert.ok(md.includes("https://x.com/TokyoArtBeat_JP/status/2077528913534706013"));
  assert.ok(!md.includes("営業時間"), "must not invent hours");
  assert.ok(!md.includes("チケット"), "must not invent tickets");
  assert.ok(!/確認済み投稿を整理/.test(visible), "no AI template lead");
  assert.ok(!/重要度/.test(visible), "no importance metric");
  assert.ok(!/関連投稿/.test(visible), "no internal 関連投稿");
  assert.ok(!/\b(Story|Concept|Topic|Knowledge|Confidence)\b/.test(visible), "no internal terms");
  assert.ok(!/^Confidence:/m.test(visible), "no Confidence in body");
  assert.ok(!/^Evidence:/m.test(visible), "no Evidence in body");
  // Highlights should not restate the full exhibition summary.
  const highlightBlock = visible.split("## 注目ポイント")[1] || "";
  const highlightBody = highlightBlock.split("## ")[0] || "";
  assert.ok(
    !/『\(UN\)KNOWN HIROKO KOSHINO』展が東京都現代美術館で5\/26/.test(highlightBody),
    "highlights should not duplicate full summary"
  );
  console.log("PASS Case 1: exhibition polish");
}

function case2ShortOpinion() {
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
  const brief = makeBrief();
  const plan = makePlan("Daily 2026-07-21");
  const md = renderMarkdown(brief, plan, { stories });

  assert.ok(md.includes("版権") && md.includes("IP"), "question preserved");
  assert.ok(!md.includes("1980"), "no invented history year");
  assert.ok(!md.includes("1990"), "no invented history");
  assert.ok(!md.includes("著作権法の改正"), "no invented legal history");
  assert.ok(!/確認済み投稿を整理/.test(md), "no template lead");
  assert.ok(!/重要度/.test(md.replace(/<!--[\s\S]*?-->/g, "")), "no importance");
  // Short article: body without HTML comments should be modest.
  const visible = md.replace(/<!--[\s\S]*?-->/g, "").trim();
  assert.ok(visible.length < 900, `expected short article, got ${visible.length}`);
  console.log("PASS Case 2: short opinion");
}

function case3Incomplete() {
  const brief = makeBrief({
    claims: [
      {
        knowledgeId: "creative-tech",
        text: "制作・クリエイティブ技術",
        confidence: 50,
        evidenceCount: 0,
        usable: true,
        reason: null,
      },
    ],
    knowledge: [
      {
        id: "creative-tech",
        title: "制作・クリエイティブ技術",
        summary: "制作・クリエイティブ技術",
        status: "published",
        version: 1,
        confidence: 50,
        notes: "",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    ],
  });
  const plan = makePlan("Daily 2026-07-21");
  const stories = {
    stories: [
      {
        id: "creative-tech",
        label: "制作・クリエイティブ技術",
        description: "",
        concepts: [],
        topics: [],
        posts: [],
        postCount: 0,
      },
    ],
  };
  // Label-only → legacy fallback (no rich content)
  const md = renderMarkdown(brief, plan, { stories });
  assert.ok(md.startsWith("# "), "has H1");
  assert.ok(!md.includes("東京都現代美術館"), "no invented venue");
  assert.ok(!md.includes("コシノヒロコ"), "no invented person");
  assert.ok(md.includes("制作・クリエイティブ技術"), "uses available label/claim");
  console.log("PASS Case 3: incomplete input");
}

function case4Dedupe() {
  const post = { ...exhibitionPost };
  const stories = {
    stories: [
      {
        id: "creative-tech",
        label: "制作・クリエイティブ技術",
        description: "イラスト、アニメ、ゲームなど制作・表現技術に関する話題",
        concepts: [
          {
            label: "コシノヒロコ / 東京都現代美術館 / 展覧会",
            summary: exhibitionPost.enrichment.summary,
            posts: [post],
            postCount: 1,
            maxImportance: 4,
            newestPostedAt: post.postedAt,
            topics: [
              {
                summary: exhibitionPost.enrichment.summary,
                posts: [post],
                postCount: 1,
                maxImportance: 4,
              },
            ],
          },
        ],
        posts: [post],
        postCount: 1,
      },
    ],
  };
  const deduped = dedupePosts([post, { ...post }, { ...post }]);
  assert.strictEqual(deduped.length, 1, "dedupe posts to 1");

  const brief = makeBrief();
  const plan = makePlan("コシノヒロコ / 東京都現代美術館 / 展覧会");
  const md = renderMarkdown(brief, plan, { stories });
  const url = post.url;
  const occurrences = md.split(url).length - 1;
  assert.strictEqual(occurrences, 1, "source URL once");
  console.log("PASS Case 4: dedupe");
}

function case5Determinism() {
  const brief = makeBrief();
  const plan = makePlan("Daily 2026-07-21");
  const a = renderMarkdown(brief, plan, { stories: exhibitionStories });
  const b = renderMarkdown(brief, plan, { stories: exhibitionStories });
  assert.strictEqual(a, b, "markdown identical");
  const v1 = validateWriterInput(brief, plan);
  const v2 = validateWriterInput(brief, plan);
  assert.deepStrictEqual(v1.errors, v2.errors);
  console.log("PASS Case 5: determinism");
}

function main() {
  case1Exhibition();
  case2ShortOpinion();
  case3Incomplete();
  case4Dedupe();
  case5Determinism();
  console.log("\nAll Writer v2 cases PASS");
}

main();
