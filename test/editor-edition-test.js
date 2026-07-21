/**
 * EP-006 — Editor Edition Layout tests.
 * Run: node test/editor-edition-test.js
 */
const assert = require("assert");
const {
  buildEditorEdition,
  mergeEditionIntoEditorView,
  assignSection,
} = require("../lib/editor-edition");
const { buildEditorDecisions } = require("../lib/editor-decision");
const { buildEditorRanking } = require("../lib/editor-ranking");

function story(id) {
  return {
    id,
    label: id,
    description: `story ${id}`,
    concepts: [
      {
        label: id,
        summary: `${id} summary with event`,
        posts: [
          {
            authorName: "A",
            authorHandle: `@${id}`,
            postedAt: "2026-07-15T12:00:00.000Z",
            text: `${id} 展覧会が開催。会期あり。`,
            url: `https://x.com/${id}/1`,
          },
        ],
        postCount: 1,
        topics: [],
      },
    ],
    posts: [
      {
        authorName: "A",
        authorHandle: `@${id}`,
        postedAt: "2026-07-15T12:00:00.000Z",
        text: `${id} 展覧会が開催。会期あり。`,
        url: `https://x.com/${id}/1`,
      },
    ],
    postCount: 1,
    conceptCount: 1,
    maxImportance: 4,
  };
}

function rankingEntry(storyId, rank, score) {
  return { storyId, rank, score, factors: {}, reasons: [] };
}

function layout(stories, decisions, ranking) {
  return buildEditorEdition({
    stories: { stories },
    decisions,
    ranking,
  });
}

function case1OneItem() {
  const stories = [story("s1")];
  const decisions = [{ storyId: "s1", decision: "accept", reason: [] }];
  const ranking = [rankingEntry("s1", 1, 90)];
  const edition = layout(stories, decisions, ranking);
  assert.strictEqual(edition.selected.length, 1);
  assert.strictEqual(edition.selected[0].section, "top");
  assert.strictEqual(edition.selected[0].position, 1);
  assert.strictEqual(edition.summary.secondaryCount, 0);
  assert.strictEqual(edition.summary.briefCount, 0);
  console.log("PASS Case 1: one item → top");
}

function case2ThreeItems() {
  const stories = [story("s1"), story("s2"), story("s3")];
  const decisions = stories.map((s) => ({
    storyId: s.id,
    decision: "accept",
    reason: [],
  }));
  const ranking = [
    rankingEntry("s1", 1, 90),
    rankingEntry("s2", 2, 80),
    rankingEntry("s3", 3, 70),
  ];
  const edition = layout(stories, decisions, ranking);
  assert.strictEqual(edition.summary.topCount, 1);
  assert.strictEqual(edition.summary.secondaryCount, 2);
  assert.strictEqual(edition.summary.briefCount, 0);
  assert.deepStrictEqual(
    edition.selected.map((s) => s.storyId),
    ["s1", "s2", "s3"]
  );
  assert.strictEqual(edition.selected[0].section, "top");
  assert.strictEqual(edition.selected[1].section, "secondary");
  assert.strictEqual(edition.selected[2].section, "secondary");
  console.log("PASS Case 2: three items");
}

function case3SixItems() {
  const stories = Array.from({ length: 6 }, (_, i) => story(`s${i + 1}`));
  const decisions = stories.map((s) => ({
    storyId: s.id,
    decision: "accept",
    reason: [],
  }));
  const ranking = stories.map((s, i) => rankingEntry(s.id, i + 1, 90 - i));
  const edition = layout(stories, decisions, ranking);
  assert.strictEqual(edition.summary.topCount, 1);
  assert.strictEqual(edition.summary.secondaryCount, 3);
  assert.strictEqual(edition.summary.briefCount, 2);
  assert.strictEqual(edition.selected.length, 6);
  console.log("PASS Case 3: six items");
}

function case4TenItems() {
  const stories = Array.from({ length: 10 }, (_, i) => story(`s${i + 1}`));
  const decisions = stories.map((s) => ({
    storyId: s.id,
    decision: "accept",
    reason: [],
  }));
  const ranking = stories.map((s, i) => rankingEntry(s.id, i + 1, 100 - i));
  const edition = layout(stories, decisions, ranking);
  assert.strictEqual(edition.selected.length, 9);
  assert.strictEqual(edition.summary.topCount, 1);
  assert.strictEqual(edition.summary.secondaryCount, 3);
  assert.strictEqual(edition.summary.briefCount, 5);
  assert.ok(
    edition.omitted.some(
      (o) => o.storyId === "s10" && o.reasonCode === "edition-capacity"
    )
  );
  assert.ok(!edition.selected.some((s) => s.storyId === "s10"));
  console.log("PASS Case 4: ten items → capacity omit");
}

function case5Duplicate() {
  const stories = [story("dup")];
  const decisions = [{ storyId: "dup", decision: "accept", reason: [] }];
  const ranking = [
    rankingEntry("dup", 1, 90),
    rankingEntry("dup", 2, 85),
  ];
  const edition = layout(stories, decisions, ranking);
  assert.strictEqual(edition.selected.length, 1);
  assert.strictEqual(edition.selected[0].storyId, "dup");
  const ids = edition.selected.map((s) => s.storyId);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(
    edition.omitted.some(
      (o) => o.storyId === "dup" && o.reasonCode === "duplicate-story"
    )
  );
  console.log("PASS Case 5: duplicate storyId");
}

function case6AcceptZero() {
  const stories = [story("h1"), story("r1")];
  const decisions = [
    { storyId: "h1", decision: "hold", reason: [] },
    { storyId: "r1", decision: "reject", reason: [] },
  ];
  const ranking = [];
  const edition = layout(stories, decisions, ranking);
  assert.deepStrictEqual(edition.selected, []);
  assert.strictEqual(edition.summary.candidateCount, 0);
  assert.strictEqual(edition.summary.selectedCount, 0);
  assert.strictEqual(edition.summary.topCount, 0);
  assert.strictEqual(edition.summary.secondaryCount, 0);
  assert.strictEqual(edition.summary.briefCount, 0);
  console.log("PASS Case 6: accept 0");
}

function case7HoldRejectInRanking() {
  const stories = [story("ok"), story("hold"), story("rej")];
  const decisions = [
    { storyId: "ok", decision: "accept", reason: [] },
    { storyId: "hold", decision: "hold", reason: [] },
    { storyId: "rej", decision: "reject", reason: [] },
  ];
  const before = JSON.stringify(decisions);
  const ranking = [
    rankingEntry("ok", 1, 90),
    rankingEntry("hold", 2, 88),
    rankingEntry("rej", 3, 87),
  ];
  const edition = layout(stories, decisions, ranking);
  assert.strictEqual(edition.selected.length, 1);
  assert.strictEqual(edition.selected[0].storyId, "ok");
  assert.ok(!edition.selected.some((s) => s.storyId === "hold"));
  assert.ok(!edition.selected.some((s) => s.storyId === "rej"));
  assert.strictEqual(JSON.stringify(decisions), before);
  console.log("PASS Case 7: hold/reject excluded");
}

function case8AcceptNotRanked() {
  const stories = [story("a1"), story("a2")];
  const decisions = [
    { storyId: "a1", decision: "accept", reason: [] },
    { storyId: "a2", decision: "accept", reason: [] },
  ];
  const ranking = [rankingEntry("a1", 1, 90)];
  const edition = layout(stories, decisions, ranking);
  assert.strictEqual(edition.selected.length, 1);
  assert.ok(!edition.selected.some((s) => s.storyId === "a2"));
  assert.ok(
    edition.omitted.some(
      (o) => o.storyId === "a2" && o.reasonCode === "not-ranked"
    )
  );
  console.log("PASS Case 8: accept not ranked");
}

function case9StoryMissing() {
  const decisions = [{ storyId: "ghost", decision: "accept", reason: [] }];
  const ranking = [rankingEntry("ghost", 1, 90)];
  const edition = layout([], decisions, ranking);
  assert.deepStrictEqual(edition.selected, []);
  assert.ok(
    edition.omitted.some(
      (o) => o.storyId === "ghost" && o.reasonCode === "story-not-found"
    )
  );
  console.log("PASS Case 9: story not found");
}

function case10OrderingFallback() {
  const stories = [story("z"), story("a"), story("m")];
  const decisions = stories.map((s) => ({
    storyId: s.id,
    decision: "accept",
    reason: [],
  }));
  // Same invalid/equal rank → score desc → storyId asc
  const ranking = [
    rankingEntry("z", 1, 50),
    rankingEntry("a", 1, 50),
    rankingEntry("m", 1, 80),
  ];
  const edition = layout(stories, decisions, ranking);
  assert.deepStrictEqual(
    edition.selected.map((s) => s.storyId),
    ["m", "a", "z"]
  );
  console.log("PASS Case 10: ordering fallback");
}

function case11Determinism() {
  const stories = Array.from({ length: 5 }, (_, i) => story(`d${i}`));
  const decisions = stories.map((s) => ({
    storyId: s.id,
    decision: "accept",
    reason: [],
  }));
  const ranking = stories.map((s, i) => rankingEntry(s.id, i + 1, 90 - i));
  const a = layout(stories, decisions, ranking);
  const b = layout(stories, decisions, ranking);
  assert.deepStrictEqual(a, b);
  console.log("PASS Case 11: determinism");
}

function case12Regression() {
  // Merge keeps topics/decisions/ranking; EP-004/005 modules still load.
  const stories = [story("creative-tech")];
  const decisions = buildEditorDecisions({
    stories: { stories },
    editorial: {
      editorial: {
        version: 2,
        articles: [
          {
            storyId: "creative-tech",
            knowledgeId: "creative-tech",
            headline: "展が7月26日閉幕",
            lead: "東京都現代美術館では展覧会が開催されています。会期は5月26日から7月26日まで。",
            angle: "終了間近",
            whyNow: "終了日が近い",
            keyFacts: ["会期: 5月26日から7月26日まで", "会場: 東京都現代美術館"],
            evidence: [],
            risks: [],
          },
        ],
      },
    },
    knowledge: [
      {
        id: "creative-tech",
        title: "制作",
        summary: "展覧会",
        status: "published",
        confidence: 60,
      },
    ],
  });
  assert.strictEqual(decisions[0].decision, "accept");
  const ranking = [
    {
      storyId: "creative-tech",
      rank: 1,
      score: 94,
      factors: {},
      reasons: [],
    },
  ];
  const beforeDec = JSON.stringify(decisions);
  const beforeRank = JSON.stringify(ranking);
  const edition = layout(stories, decisions, ranking);
  assert.strictEqual(JSON.stringify(decisions), beforeDec);
  assert.strictEqual(JSON.stringify(ranking), beforeRank);
  assert.strictEqual(edition.selected[0].section, "top");

  const merged = mergeEditionIntoEditorView(
    {
      topics: [{ topicKey: "t1" }],
      decisions,
      ranking,
    },
    edition
  );
  assert.ok(merged.topics);
  assert.deepStrictEqual(merged.decisions, decisions);
  assert.deepStrictEqual(merged.ranking, ranking);
  assert.ok(merged.edition);
  assert.strictEqual(assignSection(1), "top");
  assert.strictEqual(assignSection(2), "secondary");
  assert.strictEqual(assignSection(5), "brief");

  // ranking builder still callable
  assert.ok(typeof buildEditorRanking === "function");
  console.log("PASS Case 12: regression merge");
}

function main() {
  case1OneItem();
  case2ThreeItems();
  case3SixItems();
  case4TenItems();
  case5Duplicate();
  case6AcceptZero();
  case7HoldRejectInRanking();
  case8AcceptNotRanked();
  case9StoryMissing();
  case10OrderingFallback();
  case11Determinism();
  case12Regression();
  console.log("\nAll Editor Edition (EP-006) cases PASS");
}

main();
