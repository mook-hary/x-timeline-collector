/**
 * EP-005 — Editor Ranking tests.
 * Run: node test/editor-ranking-test.js
 */
const assert = require("assert");
const { buildEditorDecisions } = require("../lib/editor-decision");
const { buildEditorRanking } = require("../lib/editor-ranking");

function post(overrides = {}) {
  return {
    authorName: "Author",
    authorHandle: "@author",
    postedAt: "2026-07-15T12:00:00.000Z",
    text: "東京都現代美術館で展覧会が開催。会期は5月26日から7月26日まで。来週閉幕。",
    url: "https://x.com/author/status/1",
    enrichment: {
      importance: 4,
      summary: "展覧会が7月26日まで。来週閉幕。",
    },
    ...overrides,
  };
}

function story(id, posts, overrides = {}) {
  return {
    id,
    label: id,
    description: "展覧会情報",
    concepts: [
      {
        label: "展覧会",
        summary: "東京都現代美術館で展覧会開催。会期あり。",
        posts,
        postCount: posts.length,
        maxImportance: 4,
        topics: [
          {
            summary: "東京都現代美術館で展覧会開催。会期あり。",
            posts,
            postCount: posts.length,
          },
        ],
      },
    ],
    posts,
    postCount: posts.length,
    conceptCount: 1,
    maxImportance: 4,
    newestPostedAt: posts[0]?.postedAt || null,
    ...overrides,
  };
}

function editorial(storyId, overrides = {}) {
  return {
    storyId,
    knowledgeId: storyId,
    headline: `${storyId} 展が7月26日閉幕`,
    lead: "東京都現代美術館では展覧会が開催されています。会期は5月26日から7月26日まで。",
    angle: "終了間近",
    whyNow: "終了日が近い",
    audience: "",
    keyFacts: ["会期: 5月26日から7月26日まで", "会場: 東京都現代美術館"],
    evidence: [],
    risks: [],
    ...overrides,
  };
}

function knowledge(id) {
  return {
    id,
    title: id,
    summary: "展覧会・公開情報に関する話題",
    status: "published",
    version: 1,
    confidence: 60,
  };
}

function rankAll(stories, articles, knowledgeList, decisions) {
  return buildEditorRanking({
    stories: { stories },
    editorial: { editorial: { version: 2, articles } },
    knowledge: knowledgeList,
    decisions,
  });
}

function case1AcceptOnly() {
  const pAcceptA = post({
    url: "https://x.com/a/1",
    authorHandle: "@a",
    text: "展覧会Aが開催。会期は7月26日まで。",
  });
  const pAcceptB = post({
    url: "https://x.com/b/1",
    authorHandle: "@b",
    text: "展覧会Bが開催。会期は7月20日まで。",
  });
  const pHold = post({
    url: "https://x.com/h/1",
    authorHandle: "@h",
    text: "短いメモ",
  });
  const pReject = post({
    url: "https://x.com/q/1",
    authorHandle: "@q",
    text: "版権じゃなくてIPって呼ぶのがメジャーになったのっていつ頃だっけ",
  });

  const stories = [
    story("accept-a", [pAcceptA]),
    story("accept-b", [pAcceptB]),
    story("hold-x", [pHold], { description: "弱", maxImportance: 0 }),
    story("reject-q", [pReject], {
      description: "質問",
      concepts: [
        {
          label: "q",
          summary: "質問",
          posts: [pReject],
          postCount: 1,
          topics: [{ summary: "質問", posts: [pReject], postCount: 1 }],
        },
      ],
    }),
  ];

  const decisions = [
    { storyId: "accept-a", decision: "accept", reason: ["ok"] },
    { storyId: "accept-b", decision: "accept", reason: ["ok"] },
    { storyId: "hold-x", decision: "hold", reason: ["弱"] },
    { storyId: "reject-q", decision: "reject", reason: ["質問投稿"] },
  ];

  const ranking = rankAll(
    stories,
    [editorial("accept-a"), editorial("accept-b")],
    [knowledge("accept-a"), knowledge("accept-b")],
    decisions
  );

  assert.strictEqual(ranking.length, 2);
  assert.ok(ranking.every((r) => ["accept-a", "accept-b"].includes(r.storyId)));
  assert.ok(!ranking.some((r) => r.storyId === "hold-x"));
  assert.ok(!ranking.some((r) => r.storyId === "reject-q"));
  console.log("PASS Case 1: accept-only ranking");
}

function case2EvidenceWins() {
  const one = [post({ url: "https://x.com/e/1", text: "展覧会が開催。会期7月26日。" })];
  const many = [
    post({
      url: "https://x.com/e/1",
      authorHandle: "@a",
      text: "展覧会が開催。会期7月26日。",
    }),
    post({
      url: "https://x.com/e/2",
      authorHandle: "@b",
      postedAt: "2026-07-15T12:00:00.000Z",
      text: "同展の会場は東京都現代美術館。",
    }),
    post({
      url: "https://x.com/e/3",
      authorHandle: "@c",
      postedAt: "2026-07-15T12:00:00.000Z",
      text: "会期終了が近いので確認を。",
    }),
  ];
  const stories = [
    story("few-ev", one, { newestPostedAt: "2026-07-15T12:00:00.000Z" }),
    story("many-ev", many, { newestPostedAt: "2026-07-15T12:00:00.000Z" }),
  ];
  const decisions = [
    { storyId: "few-ev", decision: "accept", reason: [] },
    { storyId: "many-ev", decision: "accept", reason: [] },
  ];
  const ranking = rankAll(
    stories,
    [editorial("few-ev"), editorial("many-ev")],
    [knowledge("few-ev"), knowledge("many-ev")],
    decisions
  );
  assert.strictEqual(ranking[0].storyId, "many-ev");
  assert.ok(ranking[0].factors.evidence > ranking[1].factors.evidence);
  console.log("PASS Case 2: evidence wins");
}

function case3Freshness() {
  const older = [
    post({
      url: "https://x.com/f/old",
      postedAt: "2026-07-01T00:00:00.000Z",
      text: "展覧会が開催。会期あり。",
    }),
  ];
  const newer = [
    post({
      url: "https://x.com/f/new",
      postedAt: "2026-07-20T00:00:00.000Z",
      text: "展覧会が開催。会期あり。",
    }),
  ];
  const stories = [
    story("old-s", older, { newestPostedAt: "2026-07-01T00:00:00.000Z" }),
    story("new-s", newer, { newestPostedAt: "2026-07-20T00:00:00.000Z" }),
  ];
  const decisions = [
    { storyId: "old-s", decision: "accept", reason: [] },
    { storyId: "new-s", decision: "accept", reason: [] },
  ];
  const ranking = rankAll(
    stories,
    [editorial("old-s"), editorial("new-s")],
    [knowledge("old-s"), knowledge("new-s")],
    decisions
  );
  assert.strictEqual(ranking[0].storyId, "new-s");
  assert.ok(ranking[0].factors.freshness > ranking[1].factors.freshness);
  console.log("PASS Case 3: freshness");
}

function case4EditorialReadiness() {
  const posts = [
    post({
      url: "https://x.com/ed/1",
      text: "東京都現代美術館で『TEST』展。会期は5月26日から7月26日まで。",
    }),
  ];
  const stories = [
    story("with-ed", posts),
    story("no-ed", [
      post({
        url: "https://x.com/ed/2",
        text: "東京都現代美術館で『TEST2』展。会期は5月26日から7月26日まで。",
      }),
    ]),
  ];
  const badEditorial = editorial("no-ed", {
    headline: "展覧会が8月31日閉幕",
    lead: "入場料は9,999円です。",
    whyNow: "今注目されている",
    keyFacts: ["会期は8月31日まで"],
  });
  const decisions = [
    { storyId: "with-ed", decision: "accept", reason: [] },
    { storyId: "no-ed", decision: "accept", reason: [] },
  ];
  const ranking = rankAll(
    stories,
    [editorial("with-ed"), badEditorial],
    [knowledge("with-ed"), knowledge("no-ed")],
    decisions
  );
  const withEd = ranking.find((r) => r.storyId === "with-ed");
  const noEd = ranking.find((r) => r.storyId === "no-ed");
  assert.ok(withEd.factors.editorialReadiness > noEd.factors.editorialReadiness);
  assert.ok(withEd.rank < noEd.rank);
  console.log("PASS Case 4: editorial readiness");
}

function case5TieBreakStoryId() {
  // Identical posts/timing/editorial shape → same scores → storyId asc
  const mk = (id) => {
    const p = post({
      url: `https://x.com/tie/${id}`,
      authorHandle: `@${id}`,
      postedAt: "2026-07-15T12:00:00.000Z",
      text: "イベントが開催。会期は7月26日まで。東京都で公開。",
    });
    return story(id, [p], { newestPostedAt: "2026-07-15T12:00:00.000Z" });
  };
  const stories = [mk("story-b"), mk("story-a")];
  const decisions = [
    { storyId: "story-b", decision: "accept", reason: [] },
    { storyId: "story-a", decision: "accept", reason: [] },
  ];
  const ranking = rankAll(
    stories,
    [
      editorial("story-a", {
        headline: "story-a が7月26日閉幕",
        lead: "イベントが開催。会期は7月26日まで。",
      }),
      editorial("story-b", {
        headline: "story-b が7月26日閉幕",
        lead: "イベントが開催。会期は7月26日まで。",
      }),
    ],
    [knowledge("story-a"), knowledge("story-b")],
    decisions
  );
  assert.strictEqual(ranking[0].score, ranking[1].score);
  assert.strictEqual(ranking[0].storyId, "story-a");
  assert.strictEqual(ranking[1].storyId, "story-b");
  console.log("PASS Case 5: tie-break storyId");
}

function case6EmptyAccept() {
  const ranking = rankAll(
    [story("only-hold", [post()])],
    [editorial("only-hold")],
    [knowledge("only-hold")],
    [{ storyId: "only-hold", decision: "hold", reason: ["x"] }]
  );
  assert.deepStrictEqual(ranking, []);
  console.log("PASS Case 6: empty ranking");
}

function case7Determinism() {
  const stories = [
    story("d1", [
      post({ url: "https://x.com/d/1", text: "展覧会開催。会期7月26日。" }),
    ]),
    story("d2", [
      post({
        url: "https://x.com/d/2",
        postedAt: "2026-07-16T00:00:00.000Z",
        text: "別展覧会開催。会期7月30日。",
      }),
    ], { newestPostedAt: "2026-07-16T00:00:00.000Z" }),
  ];
  const decisions = [
    { storyId: "d1", decision: "accept", reason: [] },
    { storyId: "d2", decision: "accept", reason: [] },
  ];
  const input = {
    stories,
    articles: [editorial("d1"), editorial("d2")],
    knowledge: [knowledge("d1"), knowledge("d2")],
    decisions,
  };
  const a = rankAll(input.stories, input.articles, input.knowledge, input.decisions);
  const b = rankAll(input.stories, input.articles, input.knowledge, input.decisions);
  assert.deepStrictEqual(a, b);
  console.log("PASS Case 7: determinism");
}

function case8Regression() {
  // EP-004 still works; ranking attaches without mutating decisions.
  const stories = [story("creative-tech", [post()])];
  const articles = [editorial("creative-tech")];
  const knowledgeList = [knowledge("creative-tech")];
  const decisions = buildEditorDecisions({
    stories: { stories },
    editorial: { editorial: { version: 2, articles } },
    knowledge: knowledgeList,
  });
  assert.strictEqual(decisions[0].decision, "accept");
  const before = JSON.stringify(decisions);
  const ranking = rankAll(stories, articles, knowledgeList, decisions);
  assert.strictEqual(JSON.stringify(decisions), before, "decisions unchanged");
  assert.strictEqual(ranking.length, 1);
  assert.strictEqual(ranking[0].rank, 1);
  assert.ok(ranking[0].score >= 0 && ranking[0].score <= 100);
  assert.ok(ranking[0].factors.evidence <= 30);
  assert.ok(ranking[0].factors.freshness <= 25);
  assert.ok(ranking[0].factors.publicInterest <= 20);
  assert.ok(ranking[0].factors.editorialReadiness <= 15);
  assert.ok(ranking[0].factors.informationDensity <= 10);
  console.log("PASS Case 8: regression (decisions intact)");
}

function main() {
  case1AcceptOnly();
  case2EvidenceWins();
  case3Freshness();
  case4EditorialReadiness();
  case5TieBreakStoryId();
  case6EmptyAccept();
  case7Determinism();
  case8Regression();
  console.log("\nAll Editor Ranking (EP-005) cases PASS");
}

main();
