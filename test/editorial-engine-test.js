/**
 * EP-054 — Editorial Engine.
 * Run: node test/editorial-engine-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createEditorialEngine } = require("../lib/editorial-engine");
const { createRule } = require("../lib/editorial-rules");
const { createEditorialStore } = require("../lib/editorial-store");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-24T12:00:00.000Z";
let clock = Date.parse(NOW);
function now() {
  return new Date(clock).toISOString();
}

function longBody(n = 120) {
  return "あ".repeat(n);
}

function makeEngine(dir) {
  return createEditorialEngine({
    directory: dir,
    now,
  });
}

function seedReviewable(engine, id, extra = {}) {
  engine.create({
    id,
    source: extra.source || "news",
    type: extra.type || "article",
    title: extra.title || `Title ${id}`,
    body: extra.body || longBody(120),
    tags: extra.tags || ["news"],
  });
  engine.transition(id, "review");
  return engine.find(id);
}

// --- engine create + basic delegation ---
{
  const dir = path.join(tmpDir("ed-engine-"), "editorial");
  const engine = makeEngine(dir);
  assert.ok(engine.store);
  assert.strictEqual(engine.directory, path.resolve(dir));

  const created = engine.create({
    id: "e1",
    source: "news",
    type: "article",
    title: "Hello",
    body: longBody(120),
    tags: ["a"],
  });
  assert.strictEqual(created.status, "draft");
  assert.strictEqual(engine.find("e1").title, "Hello");
  engine.update("e1", { summary: "s" });
  assert.strictEqual(engine.find("e1").summary, "s");
  engine.transition("e1", "review");
  assert.strictEqual(engine.find("e1").status, "review");

  const evaluation = engine.evaluate("e1");
  assert.ok(Array.isArray(evaluation.results));

  const ranked = engine.rank({ includeEvaluation: true, now: NOW });
  assert.ok(ranked.length >= 1);
  assert.ok(ranked[0].score >= 0);
  console.log("EP054 basic PASS");
}

// --- engine default rules/weights override ---
{
  const dir = path.join(tmpDir("ed-engine-rules-"), "editorial");
  const customRule = createRule({
    id: "always-error",
    description: "always",
    severity: "error",
    check: () => ({ passed: false, message: "nope" }),
  });
  const engine = createEditorialEngine({
    directory: dir,
    now,
    rules: [customRule],
    rankingWeights: {
      quality: 1,
      novelty: 0,
      freshness: 0,
      readiness: 0,
    },
  });
  engine.create({
    id: "c1",
    source: "news",
    type: "article",
    title: "t",
    body: longBody(120),
    tags: ["a"],
  });
  const ev = engine.evaluate("c1");
  assert.strictEqual(ev.passed, false);
  assert.ok(ev.results.some((r) => r.ruleId === "always-error"));

  // call-time override
  const okRule = createRule({
    id: "ok",
    description: "ok",
    severity: "error",
    check: () => ({ passed: true }),
  });
  const overridden = engine.evaluate("c1", { rules: [okRule] });
  assert.strictEqual(overridden.passed, true);

  const ranked = engine.rank({
    includeEvaluation: true,
    weights: { quality: 0, novelty: 0, freshness: 1, readiness: 0 },
    now: NOW,
  });
  assert.ok(ranked[0].weights.freshness === 1);
  console.log("EP054 defaults-override PASS");
}

// --- review queue ---
{
  const dir = path.join(tmpDir("ed-engine-review-"), "editorial");
  const engine = makeEngine(dir);
  seedReviewable(engine, "rev-a", { title: "Alpha review item" });
  seedReviewable(engine, "rev-b", {
    source: "aikido",
    type: "post",
    title: "Keiko notes",
  });
  engine.create({
    id: "draft-only",
    source: "news",
    type: "article",
    title: "Draft",
    body: longBody(120),
    tags: ["a"],
  });

  const queue = engine.getReviewQueue({ now: NOW });
  assert.strictEqual(queue.length, 2);
  assert.ok(queue.every((row) => row.item.status === "review"));
  assert.ok(queue[0].evaluation);
  assert.ok(Array.isArray(queue[0].similarItems));
  assert.ok(queue[0].ranking && typeof queue[0].ranking.score === "number");
  assert.ok(queue[0].ranking.score >= queue[queue.length - 1].ranking.score);

  const newsOnly = engine.getReviewQueue({ source: "news", now: NOW });
  assert.ok(newsOnly.every((r) => r.item.source === "news"));
  assert.strictEqual(newsOnly.length, 1);

  const limited = engine.getReviewQueue({ limit: 1, now: NOW });
  assert.strictEqual(limited.length, 1);
  console.log("EP054 review-queue PASS");
}

// --- publish candidates ---
{
  const dir = path.join(tmpDir("ed-engine-pub-"), "editorial");
  const engine = makeEngine(dir);

  // approved ok
  engine.create({
    id: "pub-ok",
    source: "news",
    type: "article",
    title: "Ready",
    body: longBody(120),
    tags: ["a"],
  });
  engine.transition("pub-ok", "review");
  engine.transition("pub-ok", "approved");

  // scheduled due
  engine.create({
    id: "pub-due",
    source: "news",
    type: "article",
    title: "Due",
    body: longBody(120),
    tags: ["a"],
  });
  engine.transition("pub-due", "review");
  engine.transition("pub-due", "approved");
  engine.transition("pub-due", "scheduled", {
    scheduledAt: "2026-07-24T11:00:00.000Z",
  });

  // scheduled future — excluded
  engine.create({
    id: "pub-later",
    source: "news",
    type: "article",
    title: "Later",
    body: longBody(120),
    tags: ["a"],
  });
  engine.transition("pub-later", "review");
  engine.transition("pub-later", "approved");
  engine.transition("pub-later", "scheduled", {
    scheduledAt: "2026-07-25T12:00:00.000Z",
  });

  // approved but title empty after update? can't clear via failing rule —
  // create rejectable by custom rules
  const rejectEngine = createEditorialEngine({
    directory: path.join(tmpDir("ed-engine-rej-"), "editorial"),
    now,
    rules: [
      createRule({
        id: "reject-bad",
        description: "reject id bad",
        severity: "error",
        check(item) {
          if (item.id === "bad") {
            return { passed: false, message: "bad id" };
          }
          return { passed: true };
        },
      }),
    ],
  });
  rejectEngine.create({
    id: "bad",
    source: "news",
    type: "article",
    title: "Bad",
    body: longBody(120),
    tags: ["a"],
  });
  rejectEngine.transition("bad", "review");
  rejectEngine.transition("bad", "approved");
  rejectEngine.create({
    id: "good",
    source: "news",
    type: "article",
    title: "Good",
    body: longBody(120),
    tags: ["a"],
  });
  rejectEngine.transition("good", "review");
  rejectEngine.transition("good", "approved");

  const candidates = engine.getPublishCandidates({ now: NOW });
  const ids = candidates.map((c) => c.item.id).sort();
  assert.deepStrictEqual(ids, ["pub-due", "pub-ok"]);
  assert.ok(!ids.includes("pub-later"));
  assert.ok(candidates.every((c) => c.evaluation.passed));

  const withRejected = rejectEngine.getPublishCandidates({
    now: NOW,
    includeRejected: true,
  });
  assert.ok(Array.isArray(withRejected.candidates));
  assert.ok(Array.isArray(withRejected.rejected));
  assert.ok(withRejected.candidates.some((c) => c.item.id === "good"));
  assert.ok(withRejected.rejected.some((c) => c.item.id === "bad"));
  // workflow unchanged
  assert.strictEqual(rejectEngine.find("bad").status, "approved");
  console.log("EP054 publish-candidates PASS");
}

// --- dashboard ---
{
  const dir = path.join(tmpDir("ed-engine-dash-"), "editorial");
  const engine = makeEngine(dir);
  seedReviewable(engine, "d-review");
  engine.create({
    id: "d-draft",
    source: "news",
    type: "article",
    title: "Draft",
    body: longBody(120),
    tags: ["a"],
  });
  engine.create({
    id: "d-appr",
    source: "news",
    type: "article",
    title: "Appr",
    body: longBody(120),
    tags: ["a"],
  });
  engine.transition("d-appr", "review");
  engine.transition("d-appr", "approved");
  engine.create({
    id: "d-sched",
    source: "news",
    type: "article",
    title: "Sched",
    body: longBody(120),
    tags: ["a"],
  });
  engine.transition("d-sched", "review");
  engine.transition("d-sched", "approved");
  engine.transition("d-sched", "scheduled", {
    scheduledAt: "2026-07-24T10:00:00.000Z",
  });

  const dash = engine.getDashboard({ now: NOW, topLimit: 2 });
  assert.strictEqual(dash.generatedAt, NOW);
  assert.strictEqual(dash.totals.all, 4);
  assert.strictEqual(dash.totals.draft, 1);
  assert.strictEqual(dash.totals.review, 1);
  assert.strictEqual(dash.totals.approved, 1);
  assert.strictEqual(dash.totals.scheduled, 1);
  assert.strictEqual(dash.readyToPublish, 1);
  assert.strictEqual(dash.reviewQueue, 1);
  assert.ok(dash.ruleFailures.error >= 0);
  assert.ok(typeof dash.averageRankingScore === "number");
  assert.ok(Array.isArray(dash.topCandidates));
  assert.ok(dash.topCandidates.length <= 2);

  const empty = createEditorialEngine({
    directory: path.join(tmpDir("ed-engine-empty-"), "editorial"),
    now,
  }).getDashboard({ now: NOW });
  assert.strictEqual(empty.averageRankingScore, null);
  assert.strictEqual(empty.totals.all, 0);
  console.log("EP054 dashboard PASS");
}

// --- low-level modules still work ---
{
  const root = tmpDir("ed-engine-compat-");
  const store = createEditorialStore({ rootDir: root, now });
  store.create({
    id: "compat-1",
    source: "news",
    type: "post",
    title: "Direct store",
    body: longBody(120),
    tags: ["x"],
  });
  assert.ok(store.find("compat-1"));
  store.transition("compat-1", "review");
  assert.strictEqual(store.find("compat-1").status, "review");
  console.log("EP054 compat PASS");
}

console.log("editorial-engine-test: all PASS");
