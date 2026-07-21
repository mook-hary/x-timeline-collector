/**
 * EP-002 — Editorial Brief Validation tests.
 * Run: node test/writer-editorial-validate-test.js
 */
const assert = require("assert");
const { renderMarkdown } = require("../lib/writer-core");
const {
  renderStoryArticle,
  normalizeStoryContext,
} = require("../lib/writer-content");
const { resolveEditContext } = require("../lib/writer-editorial");

function makeBrief(editorialArticles, overrides = {}) {
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
    ...overrides,
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

function baseArticle(overrides = {}) {
  return {
    knowledgeId: "creative-tech",
    storyId: "creative-tech",
    headline: "『(UN)KNOWN HIROKO KOSHINO』展が7月26日閉幕",
    lead: "東京都現代美術館では、『(UN)KNOWN HIROKO KOSHINO』展が開催されています。会期は5月26日から7月26日までで、終了まで残り少なくなっています。",
    angle: "終了間近",
    whyNow: "終了日が近い",
    audience: "",
    keyFacts: ["会期: 5月26日から7月26日まで", "会場: 東京都現代美術館"],
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
    ...overrides,
  };
}

function visible(md) {
  return md.replace(/<!--[\s\S]*?-->/g, "");
}

function editOf(brief, plan = makePlan("Daily 2026-07-21")) {
  const ctx = normalizeStoryContext(exhibitionStories, brief);
  return resolveEditContext(brief, ctx, plan);
}

function case1EvidenceUrlMatch() {
  const brief = makeBrief([baseArticle()]);
  const edit = editOf(brief);
  assert.ok(edit, "edit context");
  assert.strictEqual(edit.validation.matchedEvidenceCount, 1);
  assert.ok(
    !edit.validation.warnings.some((w) => w.startsWith("unmatched-evidence")),
    "no unmatched warning"
  );
  const md = renderMarkdown(brief, makePlan("Daily 2026-07-21"), {
    stories: exhibitionStories,
  });
  assert.ok(visible(md).includes(exhibitionPost.url), "source kept");
  console.log("PASS Case 1: Evidence URL match");
}

function case2EvidenceMismatch() {
  const article = baseArticle({
    evidence: [
      {
        url: "https://x.com/other/status/999",
        authorName: "Other",
        authorHandle: "other",
        postedAt: "2026-01-01T00:00:00.000Z",
        text: "存在しない投稿本文XYZ",
      },
    ],
  });
  const brief = makeBrief([article]);
  const edit = editOf(brief);
  assert.strictEqual(edit.validation.matchedEvidenceCount, 0);
  assert.ok(
    edit.validation.warnings.some((w) => w.startsWith("unmatched-evidence")),
    "warning recorded"
  );
  const md = renderMarkdown(brief, makePlan("Daily 2026-07-21"), {
    stories: exhibitionStories,
  });
  const body = visible(md);
  assert.ok(!body.includes("https://x.com/other/status/999"), "bad url absent");
  assert.ok(!body.includes("存在しない投稿本文XYZ"), "bad text absent");
  assert.ok(body.includes(exhibitionPost.url), "story source kept");
  console.log("PASS Case 2: Evidence mismatch");
}

function case3DateConflictKeyFact() {
  const article = baseArticle({
    keyFacts: [
      "会期は8月31日まで",
      "会期: 5月26日から7月26日まで",
      "会場: 東京都現代美術館",
    ],
  });
  const brief = makeBrief([article]);
  const edit = editOf(brief);
  assert.ok(
    edit.validation.rejectedKeyFacts.some((f) => f.includes("8月31日")),
    "8/31 rejected"
  );
  assert.ok(
    edit.keyFacts.some((f) => /7月26日/.test(f)),
    "7/26 kept"
  );
  assert.ok(
    edit.validation.conflicts.some((c) => c.type === "date-conflict"),
    "conflict recorded"
  );
  const md = renderMarkdown(brief, makePlan("Daily 2026-07-21"), {
    stories: exhibitionStories,
  });
  const body = visible(md);
  assert.ok(!body.includes("8月31日"), "bad date not in article");
  assert.ok(/7月26日/.test(body), "story date used");
  console.log("PASS Case 3: date conflict keyFact");
}

function case4HeadlineConflict() {
  const badHeadline = "展覧会が8月31日閉幕";
  const article = baseArticle({ headline: badHeadline });
  const brief = makeBrief([article]);
  brief.title = badHeadline;
  const plan = makePlan(badHeadline);
  const edit = editOf(brief, plan);
  assert.ok(edit.validation.rejectedFields.includes("headline"));
  assert.strictEqual(edit.validation.rejectedHeadline, badHeadline);
  assert.ok(!edit.headline || edit.headline !== badHeadline);

  const md = renderMarkdown(brief, plan, { stories: exhibitionStories });
  assert.ok(!md.includes("8月31日"), `no bad date in md: ${md.split("\n")[0]}`);
  assert.ok(/7月26日|東京都現代美術館|HIROKO KOSHINO/.test(md), "story title path");
  console.log("PASS Case 4: headline conflict");
}

function case5LeadPartialUnconfirmed() {
  const article = baseArticle({
    lead: "東京都現代美術館では、『(UN)KNOWN HIROKO KOSHINO』展が開催されています。入場料は2,000円です。",
  });
  const brief = makeBrief([article]);
  const edit = editOf(brief);
  assert.ok(!/2,000円|2000円/.test(edit.lead || ""), "price removed from lead");
  const md = renderMarkdown(brief, makePlan("Daily 2026-07-21"), {
    stories: exhibitionStories,
  });
  const body = visible(md);
  assert.ok(!/2,000円|入場料は/.test(body), "unconfirmed price absent");
  assert.ok(/東京都現代美術館|HIROKO KOSHINO/.test(body), "safe content remains");
  console.log("PASS Case 5: lead partial unconfirmed");
}

function case6WhyNowGrounded() {
  const brief = makeBrief([baseArticle({ whyNow: "終了日が近い" })]);
  const edit = editOf(brief);
  assert.strictEqual(edit.whyNow, "終了日が近い");
  assert.ok(!edit.validation.rejectedFields.includes("whyNow"));
  const md = renderMarkdown(brief, makePlan("Daily 2026-07-21"), {
    stories: exhibitionStories,
  });
  assert.ok(
    /会期終了が近づいて/.test(visible(md)),
    "whyNow reflected in importance"
  );
  console.log("PASS Case 6: whyNow grounded");
}

function case7WhyNowUngrounded() {
  const article = baseArticle({
    whyNow: "今注目されている",
    angle: "",
  });
  const brief = makeBrief([article]);
  const edit = editOf(brief);
  assert.ok(edit.validation.rejectedFields.includes("whyNow"));
  assert.strictEqual(edit.whyNow, "");
  const md = renderMarkdown(brief, makePlan("Daily 2026-07-21"), {
    stories: exhibitionStories,
  });
  const body = visible(md);
  assert.ok(!/今注目されている/.test(body), "hype not emitted");
  console.log("PASS Case 7: whyNow ungrounded");
}

function case8SemanticKeyFactDedupe() {
  const article = baseArticle({
    keyFacts: [
      "会期: 5月26日から7月26日まで",
      "5月26日〜7月26日開催",
      "会場: 東京都現代美術館",
      "東京都現代美術館で開催",
    ],
  });
  const brief = makeBrief([article]);
  const edit = editOf(brief);
  const periodFacts = edit.keyFacts.filter((f) =>
    /5月26日|7月26日/.test(f)
  );
  const venueFacts = edit.keyFacts.filter((f) => /東京都現代美術館/.test(f));
  assert.strictEqual(periodFacts.length, 1, `period once: ${edit.keyFacts}`);
  assert.strictEqual(venueFacts.length, 1, `venue once: ${edit.keyFacts}`);
  console.log("PASS Case 8: semantic keyFacts dedupe");
}

function case9QuestionOnly() {
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
  console.log("PASS Case 9: question-only");
}

function case10NoEditorial() {
  const brief = makeBrief(null);
  const plan = makePlan("Daily 2026-07-21");
  const md = renderMarkdown(brief, plan, { stories: exhibitionStories });
  assert.ok(md.startsWith("# "), "renders");
  const ctx = normalizeStoryContext(exhibitionStories, brief);
  const rendered = renderStoryArticle(ctx, plan, brief);
  assert.strictEqual(rendered.usedEditorial, false);
  assert.strictEqual(rendered.validation, null);
  console.log("PASS Case 10: no editorial fallback");
}

function case11Determinism() {
  const brief = makeBrief([baseArticle()]);
  const plan = makePlan("Daily 2026-07-21");
  const e1 = editOf(brief, plan);
  const e2 = editOf(brief, plan);
  assert.deepStrictEqual(e1.validation, e2.validation, "validation identical");
  const a = renderMarkdown(brief, plan, { stories: exhibitionStories });
  const b = renderMarkdown(brief, plan, { stories: exhibitionStories });
  assert.strictEqual(a, b, "markdown identical");
  console.log("PASS Case 11: determinism");
}

function main() {
  case1EvidenceUrlMatch();
  case2EvidenceMismatch();
  case3DateConflictKeyFact();
  case4HeadlineConflict();
  case5LeadPartialUnconfirmed();
  case6WhyNowGrounded();
  case7WhyNowUngrounded();
  case8SemanticKeyFactDedupe();
  case9QuestionOnly();
  case10NoEditorial();
  case11Determinism();
  console.log("\nAll Writer Editorial Validation (EP-002) cases PASS");
}

main();
