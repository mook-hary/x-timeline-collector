/**
 * EP-004 — Editor Foundation (publishability decisions).
 * Run: node test/editor-decision-test.js
 */
const assert = require("assert");
const {
  buildEditorDecisions,
  mergeDecisionsIntoEditorView,
} = require("../lib/editor-decision");
const { buildEditorView } = require("../lib/editor-core");

function post(overrides = {}) {
  return {
    authorName: "Tokyo Art Beat",
    authorHandle: "@TokyoArtBeat_JP",
    postedAt: "2026-07-15T23:01:06.000Z",
    text: "【来週閉幕】東京都現代美術館で「(UN)KNOWN HIROKO KOSHINO」が今夏開催。会期は5月26日から7月26日まで。",
    url: "https://x.com/TokyoArtBeat_JP/status/2077528913534706013",
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
    label: "制作・クリエイティブ技術",
    description: "イラスト、アニメ、ゲームなど制作・表現技術に関する話題",
    concepts: [
      {
        label: "展覧会",
        summary: "『(UN)KNOWN HIROKO KOSHINO』展が東京都現代美術館で開催",
        posts,
        postCount: posts.length,
        maxImportance: 4,
        topics: [
          {
            summary: "『(UN)KNOWN HIROKO KOSHINO』展が東京都現代美術館で開催",
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
    ...overrides,
  };
}

function editorial(storyId, overrides = {}) {
  return {
    storyId,
    knowledgeId: storyId,
    headline: "『(UN)KNOWN HIROKO KOSHINO』展が7月26日閉幕",
    lead: "東京都現代美術館では展覧会が開催されています。",
    angle: "終了間近",
    whyNow: "終了日が近い",
    audience: "",
    keyFacts: ["会期: 5月26日から7月26日まで"],
    evidence: [],
    risks: [],
    ...overrides,
  };
}

function knowledge(id, overrides = {}) {
  return {
    id,
    title: "制作・クリエイティブ技術",
    summary: "イラスト、アニメ、ゲームなど制作・表現技術に関する話題",
    status: "published",
    version: 1,
    confidence: 60,
    ...overrides,
  };
}

function decide(stories, articles, knowledgeList) {
  return buildEditorDecisions({
    stories: { stories },
    editorial: { editorial: { version: 2, articles } },
    knowledge: knowledgeList,
  });
}

function case1Accept() {
  const decisions = decide(
    [story("creative-tech", [post()])],
    [editorial("creative-tech")],
    [knowledge("creative-tech")]
  );
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].decision, "accept");
  assert.strictEqual(decisions[0].storyId, "creative-tech");
  assert.ok(decisions[0].reason.includes("evidenceあり"));
  assert.ok(decisions[0].reason.includes("Editorial生成済み"));
  console.log("PASS Case 1: accept");
}

function case2Hold() {
  // Established story + evidence, but no Editorial and weak Knowledge
  const decisions = decide(
    [story("creative-tech", [post()])],
    [],
    [knowledge("creative-tech", { status: "draft", confidence: 20 })]
  );
  assert.strictEqual(decisions[0].decision, "hold");
  assert.ok(decisions[0].reason.includes("Editorial未生成"));
  assert.ok(decisions[0].reason.includes("Knowledge不足"));
  console.log("PASS Case 2: hold");
}

function case3RejectPromo() {
  const promo = post({
    text: "今すぐフォロー＆RT希望！宣伝です！",
    url: "https://x.com/ad/status/1",
    finalAnalysis: { category: "広告・PR" },
    analysis: { category: "広告・PR" },
    enrichment: { importance: 1, summary: "宣伝" },
  });
  const decisions = decide(
    [
      story("ad-story", [promo], {
        description: "宣伝",
        concepts: [
          {
            label: "広告",
            summary: "宣伝投稿",
            posts: [promo],
            postCount: 1,
            topics: [{ summary: "宣伝投稿", posts: [promo], postCount: 1 }],
          },
        ],
      }),
    ],
    [editorial("ad-story", { headline: "宣伝", lead: "宣伝です。" })],
    [knowledge("ad-story")]
  );
  assert.strictEqual(decisions[0].decision, "reject");
  assert.ok(decisions[0].reason.includes("宣伝のみ"));
  console.log("PASS Case 3: reject (promo)");
}

function case4DuplicateReject() {
  const p = post();
  const decisions = decide(
    [
      story("story-a", [p]),
      story("story-b", [p], { id: "story-b", label: "別ラベル同一投稿" }),
    ],
    [editorial("story-a"), editorial("story-b")],
    [knowledge("story-a"), knowledge("story-b")]
  );
  assert.strictEqual(decisions[0].decision, "accept");
  assert.strictEqual(decisions[1].decision, "reject");
  assert.ok(decisions[1].reason.includes("Story重複"));
  console.log("PASS Case 4: duplicate reject");
}

function case5QuestionReject() {
  const q = post({
    text: "版権じゃなくてIPって呼ぶのがメジャーになったのっていつ頃だっけ",
    url: "https://x.com/nekoruri/status/2077445700317843957",
    authorName: "Aki",
    authorHandle: "@nekoruri",
    enrichment: {
      importance: 3,
      summary: "呼び方の変化を尋ねる投稿",
    },
  });
  const decisions = decide(
    [
      story("q-story", [q], {
        description: "質問",
        concepts: [
          {
            label: "用語",
            summary: "呼び方の変化を尋ねる投稿",
            posts: [q],
            postCount: 1,
            topics: [
              {
                summary: "呼び方の変化を尋ねる投稿",
                posts: [q],
                postCount: 1,
              },
            ],
          },
        ],
      }),
    ],
    [editorial("q-story", { headline: "質問", lead: "質問があります。" })],
    [knowledge("q-story")]
  );
  assert.strictEqual(decisions[0].decision, "reject");
  assert.ok(decisions[0].reason.includes("質問投稿"));
  console.log("PASS Case 5: question reject");
}

function case6Regression() {
  // Topic editor view still builds; merge keeps topics.
  const view = buildEditorView(
    [post()],
    {},
    { hasRange: false }
  );
  assert.ok(Array.isArray(view.topics));
  assert.ok(view.topics.length >= 1);

  const decisions = decide(
    [story("creative-tech", [post()])],
    [editorial("creative-tech")],
    [knowledge("creative-tech")]
  );
  const merged = mergeDecisionsIntoEditorView(
    {
      generatedAt: "2026-07-21T00:00:00.000Z",
      totalPosts: view.totalPosts,
      totalTopics: view.totalTopics,
      topics: view.topics,
    },
    decisions
  );
  assert.ok(Array.isArray(merged.topics), "topics preserved");
  assert.strictEqual(merged.topics.length, view.topics.length);
  assert.ok(Array.isArray(merged.decisions));
  assert.strictEqual(merged.decisions[0].decision, "accept");

  // Determinism
  const a = decide(
    [story("creative-tech", [post()])],
    [editorial("creative-tech")],
    [knowledge("creative-tech")]
  );
  const b = decide(
    [story("creative-tech", [post()])],
    [editorial("creative-tech")],
    [knowledge("creative-tech")]
  );
  assert.deepStrictEqual(a, b);

  console.log("PASS Case 6: regression");
}

function main() {
  case1Accept();
  case2Hold();
  case3RejectPromo();
  case4DuplicateReject();
  case5QuestionReject();
  case6Regression();
  console.log("\nAll Editor Decision (EP-004) cases PASS");
}

main();
