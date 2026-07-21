/**
 * EP-001 — Writer ← Editorial Brief integration tests.
 * Run: node test/writer-editorial-test.js
 */
const assert = require("assert");
const { renderMarkdown } = require("../lib/writer-core");
const { renderStoryArticle, normalizeStoryContext } = require("../lib/writer-content");
const { selectEditorialArticle, resolveEditContext } = require("../lib/writer-editorial");

function makeBrief(editorialArticles) {
  const brief = {
    id: "brief-test",
    title: editorialArticles?.[0]?.headline || "Daily 2026-07-21",
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
  };
  if (editorialArticles) {
    brief.editorial = { version: 2, articles: editorialArticles };
  }
  return brief;
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
    },
  ],
};

const editorialArticle = {
  knowledgeId: "creative-tech",
  storyId: "creative-tech",
  headline: "『(UN)KNOWN HIROKO KOSHINO』展が7月26日閉幕",
  lead: "東京都現代美術館では、『(UN)KNOWN HIROKO KOSHINO』展が開催されています。会期は5月26日から7月26日までで、終了まで残り少なくなっています。",
  angle: "終了間近",
  whyNow: "終了日が近い",
  audience: "",
  keyFacts: [
    "会期: 5月26日から7月26日まで",
    "会場: 東京都現代美術館",
    "会期: 5月26日から7月26日まで",
  ],
  evidence: [
    {
      url: exhibitionPost.url,
      authorName: "Tokyo Art Beat",
      authorHandle: "TokyoArtBeat_JP",
      postedAt: exhibitionPost.postedAt,
      text: exhibitionPost.text,
    },
  ],
  risks: ["営業時間・チケット情報は入力にないため書かない"],
};

function visible(md) {
  return md.replace(/<!--[\s\S]*?-->/g, "");
}

function case1EditorialPresent() {
  const brief = makeBrief([editorialArticle]);
  // Generic plan title so editorial/story titles can surface
  const plan = makePlan("Daily 2026-07-21");
  const md = renderMarkdown(brief, plan, { stories: exhibitionStories });
  const body = visible(md);

  assert.ok(
    md.startsWith(`# ${editorialArticle.headline}\n`),
    `headline in H1: ${md.split("\n")[0]}`
  );
  assert.ok(body.includes(editorialArticle.lead.split("。")[0]), "lead reflected");
  assert.ok(/会期終了が近づいて|終了まで残り少なく/.test(body), "whyNow/angle focus");
  assert.ok(body.includes("東京都現代美術館"), "venue used");
  assert.ok(/5月26日|7月26日/.test(body), "period used");
  assert.ok(body.includes(exhibitionPost.url), "source url kept");
  assert.ok(!/営業時間|チケット購入/.test(body), "no invented hours/tickets");
  assert.ok(!/確認済み投稿を整理|重要度|Confidence/.test(body), "no internal terms");
  assert.ok(!body.includes("営業時間・チケット情報は入力にない"), "risk not shown");

  const ctx = normalizeStoryContext(exhibitionStories, brief);
  const rendered = renderStoryArticle(ctx, plan, brief);
  assert.strictEqual(rendered.usedEditorial, true, "editorial path used");

  console.log("PASS Case 1: editorial brief present");
}

function case2NoEditorial() {
  const brief = makeBrief(null);
  const plan = makePlan("Daily 2026-07-21");
  const md = renderMarkdown(brief, plan, { stories: exhibitionStories });
  const body = visible(md);
  assert.ok(md.startsWith("# "), "has title");
  assert.ok(body.includes("## 何が起きたか"), "story writer structure");
  assert.ok(body.includes(exhibitionPost.url), "source kept");
  const ctx = normalizeStoryContext(exhibitionStories, brief);
  const rendered = renderStoryArticle(ctx, plan, brief);
  assert.strictEqual(rendered.usedEditorial, false, "fallback path");
  console.log("PASS Case 2: no editorial (Task040 compat)");
}

function case3QuestionOnly() {
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
        description: "x",
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
  const article = {
    knowledgeId: "creative-tech",
    storyId: "creative-tech",
    headline: "版権からIPへ — 呼び方の変化を問う投稿",
    lead: "投稿では、版権ではなくIPと呼ぶようになった時期が尋ねられています。",
    angle: "用語・疑問",
    whyNow: "",
    audience: "",
    keyFacts: ["問い: 版権からIPへ呼び方が変わった時期"],
    evidence: [
      {
        url: post.url,
        authorName: "Aki",
        authorHandle: "nekoruri",
        postedAt: post.postedAt,
        text: post.text,
      },
    ],
    risks: ["質問のみ。回答や歴史的事実を書かない"],
  };
  const brief = makeBrief([article]);
  const plan = makePlan("Daily 2026-07-21");
  const md = renderMarkdown(brief, plan, { stories });
  const body = visible(md);
  assert.ok(/版権|IP/.test(body), "question preserved");
  assert.ok(!/1980|1990|著作権法/.test(body), "no invented answer");
  assert.ok(!body.includes("質問のみ"), "risk not in body");
  console.log("PASS Case 3: question-only risk");
}

function case4KeyFactsDedupe() {
  const brief = makeBrief([editorialArticle]);
  const plan = makePlan("Daily 2026-07-21");
  const ctx = normalizeStoryContext(exhibitionStories, brief);
  const edit = resolveEditContext(brief, ctx, plan);
  assert.strictEqual(edit.keyFacts.length, 2, "duplicate keyFact removed");
  const md = renderMarkdown(brief, plan, { stories: exhibitionStories });
  const body = visible(md);
  const venueCount = body.split("会場: 東京都現代美術館").length - 1;
  assert.ok(venueCount <= 1, "venue keyFact not repeated as highlight line");
  console.log("PASS Case 4: keyFacts dedupe");
}

function case5EmptyEditorial() {
  const brief = makeBrief([
    {
      knowledgeId: "creative-tech",
      storyId: "creative-tech",
      headline: "",
      lead: "",
      angle: "",
      whyNow: "",
      audience: "",
      keyFacts: [],
      evidence: [],
      risks: [],
    },
  ]);
  const plan = makePlan("Daily 2026-07-21");
  const md = renderMarkdown(brief, plan, { stories: exhibitionStories });
  assert.ok(md.startsWith("# "), "renders");
  const ctx = normalizeStoryContext(exhibitionStories, brief);
  const selected = selectEditorialArticle(brief, ctx, plan);
  assert.strictEqual(selected, null, "empty article rejected");
  const rendered = renderStoryArticle(ctx, plan, brief);
  assert.strictEqual(rendered.usedEditorial, false);
  console.log("PASS Case 5: empty editorial fallback");
}

function case6Determinism() {
  const brief = makeBrief([editorialArticle]);
  const plan = makePlan("Daily 2026-07-21");
  const a = renderMarkdown(brief, plan, { stories: exhibitionStories });
  const b = renderMarkdown(brief, plan, { stories: exhibitionStories });
  assert.strictEqual(a, b, "identical markdown");
  console.log("PASS Case 6: determinism");
}

function main() {
  case1EditorialPresent();
  case2NoEditorial();
  case3QuestionOnly();
  case4KeyFactsDedupe();
  case5EmptyEditorial();
  case6Determinism();
  console.log("\nAll Writer Editorial (EP-001) cases PASS");
}

main();
