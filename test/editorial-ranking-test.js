/**
 * EP-053 — Editorial Ranking.
 * Run: node test/editorial-ranking-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  getDefaultRankingWeights,
  calculateQuality,
  calculateNovelty,
  calculateFreshness,
  calculateReadiness,
  calculateRanking,
  rankItems,
  normalizeWeights,
} = require("../lib/editorial-ranking");
const { createEditorialStore } = require("../lib/editorial-store");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-24T12:00:00.000Z";

function item(partial) {
  return {
    id: "x",
    source: "news",
    type: "article",
    title: "t",
    summary: "",
    body: "b",
    tags: [],
    status: "draft",
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

// --- weights ---
{
  const w = getDefaultRankingWeights();
  assert.strictEqual(w.quality, 0.4);
  assert.deepStrictEqual(normalizeWeights(null), {
    quality: 0.4,
    novelty: 0.25,
    freshness: 0.2,
    readiness: 0.15,
  });
  assert.throws(
    () => normalizeWeights({ quality: 1, novelty: 0, freshness: 0, readiness: 0.1 }),
    /sum/
  );
  assert.throws(
    () => normalizeWeights({ quality: -1, novelty: 1, freshness: 0, readiness: 0 }),
    />= 0/
  );
  console.log("EP053 weights PASS");
}

// --- quality ---
{
  const uneval = calculateQuality(null);
  assert.strictEqual(uneval.score, 100);
  assert.strictEqual(uneval.unevaluated, true);

  const q = calculateQuality({
    counts: { error: 1, warning: 2, info: 1, skipped: 0 },
  });
  assert.strictEqual(q.score, 100 - 40 - 20 - 2);
  assert.strictEqual(
    calculateQuality({ counts: { error: 3, warning: 0, info: 0 } }).score,
    0
  );
  console.log("EP053 quality PASS");
}

// --- novelty ---
{
  assert.strictEqual(calculateNovelty(null).score, 100);
  assert.strictEqual(calculateNovelty(0).score, 100);
  assert.strictEqual(calculateNovelty(0.2).score, 80);
  assert.strictEqual(calculateNovelty(1).score, 0);
  assert.throws(() => calculateNovelty(1.5), /0 and 1/);
  assert.throws(() => calculateNovelty(-0.1), /0 and 1/);
  console.log("EP053 novelty PASS");
}

// --- freshness boundaries ---
{
  const base = item({
    publishedAt: null,
    updatedAt: "2026-07-24T12:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.strictEqual(calculateFreshness(base, NOW).score, 100);

  assert.strictEqual(
    calculateFreshness(
      item({ updatedAt: "2026-07-23T12:00:00.000Z" }),
      NOW
    ).score,
    100
  );
  assert.strictEqual(
    calculateFreshness(
      item({ updatedAt: "2026-07-22T11:59:00.000Z" }),
      NOW
    ).score,
    85
  );
  assert.strictEqual(
    calculateFreshness(
      item({ updatedAt: "2026-07-18T12:00:00.000Z" }),
      NOW
    ).score,
    70
  );
  assert.strictEqual(
    calculateFreshness(
      item({ updatedAt: "2026-07-11T12:00:00.000Z" }),
      NOW
    ).score,
    50
  );
  assert.strictEqual(
    calculateFreshness(
      item({ updatedAt: "2026-06-30T12:00:00.000Z" }),
      NOW
    ).score,
    25
  );
  assert.strictEqual(
    calculateFreshness(
      item({ updatedAt: "2026-06-01T12:00:00.000Z" }),
      NOW
    ).score,
    10
  );
  assert.strictEqual(
    calculateFreshness(item({ updatedAt: "2026-07-25T00:00:00.000Z" }), NOW)
      .score,
    100
  );
  assert.strictEqual(
    calculateFreshness(
      { id: "n", status: "draft" },
      NOW
    ).score,
    50
  );
  // publishedAt preferred
  assert.ok(
    calculateFreshness(
      item({
        publishedAt: "2026-07-24T11:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      NOW
    ).reason.includes("Published")
  );
  console.log("EP053 freshness PASS");
}

// --- readiness ---
{
  assert.strictEqual(calculateReadiness("approved").score, 100);
  assert.strictEqual(calculateReadiness("scheduled").score, 100);
  assert.strictEqual(calculateReadiness("review").score, 75);
  assert.strictEqual(calculateReadiness("draft").score, 50);
  assert.strictEqual(calculateReadiness("published").score, 30);
  assert.strictEqual(calculateReadiness("archived").score, 0);
  assert.throws(() => calculateReadiness("ready"), /unknown status/);
  console.log("EP053 readiness PASS");
}

// --- calculateRanking ---
{
  const a = item({ status: "review", updatedAt: NOW });
  const r1 = calculateRanking(a, {
    now: NOW,
    evaluation: { counts: { error: 0, warning: 1, info: 0 } },
    maxSimilarity: 0.2,
  });
  assert.ok(r1.score >= 0 && r1.score <= 100);
  assert.strictEqual(r1.metrics.quality, 90);
  assert.strictEqual(r1.metrics.novelty, 80);
  assert.strictEqual(r1.metrics.freshness, 100);
  assert.strictEqual(r1.metrics.readiness, 75);
  assert.strictEqual(
    r1.score,
    Math.round((90 * 0.4 + 80 * 0.25 + 100 * 0.2 + 75 * 0.15) * 100) / 100
  );
  assert.ok(r1.reasons.some((x) => /warning/.test(x)));
  assert.ok(r1.reasons.some((x) => /0\.20/.test(x)));

  const r2 = calculateRanking(a, {
    now: NOW,
    evaluation: { counts: { error: 0, warning: 1, info: 0 } },
    maxSimilarity: 0.2,
  });
  assert.deepStrictEqual(r1.score, r2.score);
  assert.deepStrictEqual(r1.metrics, r2.metrics);

  const custom = calculateRanking(a, {
    now: NOW,
    weights: { quality: 1, novelty: 0, freshness: 0, readiness: 0 },
    evaluation: { counts: { error: 0, warning: 1, info: 0 } },
  });
  assert.strictEqual(custom.score, 90);
  console.log("EP053 calculateRanking PASS");
}

// --- rankItems sort / filter / limit ---
{
  const items = [
    item({
      id: "b",
      status: "draft",
      source: "news",
      type: "article",
      updatedAt: "2026-07-24T10:00:00.000Z",
    }),
    item({
      id: "a",
      status: "approved",
      source: "news",
      type: "article",
      updatedAt: "2026-07-24T09:00:00.000Z",
    }),
    item({
      id: "c",
      status: "draft",
      source: "aikido",
      type: "post",
      updatedAt: "2026-07-24T11:00:00.000Z",
    }),
  ];
  // Force same score via context for tie-break test
  const tied = rankItems(
    [
      item({
        id: "z",
        status: "draft",
        updatedAt: "2026-07-24T08:00:00.000Z",
      }),
      item({
        id: "y",
        status: "draft",
        updatedAt: "2026-07-24T09:00:00.000Z",
      }),
      item({
        id: "x",
        status: "draft",
        updatedAt: "2026-07-24T09:00:00.000Z",
      }),
    ],
    {
      defaultContext: {
        now: NOW,
        maxSimilarity: 0,
        evaluation: { counts: { error: 0, warning: 0, info: 0 } },
      },
    }
  );
  // same score → newer updatedAt first, then id asc
  assert.deepStrictEqual(
    tied.map((r) => r.item.id),
    ["x", "y", "z"]
  );

  const ranked = rankItems(items, {
    defaultContext: { now: NOW, maxSimilarity: 0 },
    source: "news",
    type: "article",
    statuses: ["draft", "approved"],
  });
  assert.ok(ranked.every((r) => r.item.source === "news"));
  assert.ok(ranked[0].score >= ranked[ranked.length - 1].score);
  assert.strictEqual(ranked[0].item.status, "approved");

  const limited = rankItems(items, {
    defaultContext: { now: NOW },
    limit: 1,
  });
  assert.strictEqual(limited.length, 1);

  const byCtx = rankItems(items, {
    defaultContext: { now: NOW, maxSimilarity: 0 },
    contextById: {
      b: { maxSimilarity: 0.9 },
    },
  });
  const scoreB = byCtx.find((r) => r.item.id === "b").metrics.novelty;
  assert.strictEqual(scoreB, 10);
  console.log("EP053 rankItems PASS");
}

// --- store rank / rankItem / rankByIds ---
{
  const store = createEditorialStore({
    rootDir: tmpDir("editorial-rank-"),
    now: () => NOW,
  });
  store.create({
    id: "r1",
    source: "news",
    type: "article",
    title: "Alpha release notes",
    body: "あ".repeat(120),
    tags: ["news"],
  });
  store.create({
    id: "r2",
    source: "news",
    type: "article",
    title: "Beta changelog",
    body: "い".repeat(120),
    tags: ["news"],
  });
  store.transition("r1", "review");
  store.transition("r1", "approved");

  assert.throws(() => store.rankItem("missing"), /not found/);
  assert.throws(() => store.rankByIds(["r1", "missing"]), /not found/);

  const one = store.rankItem("r1", {
    includeEvaluation: true,
    includeSimilarity: true,
    now: NOW,
  });
  assert.ok(one.score >= 0 && one.score <= 100);
  assert.ok(one.metrics.quality <= 100);

  const many = store.rank({
    includeEvaluation: true,
    includeSimilarity: true,
    now: NOW,
    limit: 2,
  });
  assert.strictEqual(many.length, 2);
  assert.ok(many[0].score >= many[1].score);

  const byIds = store.rankByIds(["r2", "r1"], {
    now: NOW,
    includeEvaluation: true,
  });
  assert.strictEqual(byIds.length, 2);
  // ranking order, not input order
  assert.ok(byIds[0].score >= byIds[1].score);

  // existing APIs intact
  assert.strictEqual(store.find("r1").status, "approved");
  store.findSimilarById("r1", { threshold: 0.5 });
  store.evaluate("r2");
  console.log("EP053 store-rank PASS");
}

console.log("editorial-ranking-test: all PASS");
