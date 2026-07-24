/**
 * KP-005 — Aikido Knowledge Candidate Review.
 * Run: node test/aikido-candidate-review-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createAikidoCandidateReview,
  assertTransition,
} = require("../lib/aikido-candidate-review");
const { createAikidoKnowledgeStore } = require("../lib/aikido-knowledge");
const { createAikidoSourceIntake } = require("../lib/aikido-source-intake");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-24T20:00:00.000Z";
let clock = Date.parse(NOW);
function now() {
  return new Date(clock).toISOString();
}
function advance(ms) {
  clock += ms;
}

function candidate(partial = {}) {
  return {
    candidateId: "cand-aaa111",
    sourceId: "src-1",
    title: "中心の感覚",
    category: "principle",
    summary: "中心を保つ",
    content: "力が抜けた状態で軸を意識する。",
    tags: ["center"],
    difficulty: 2,
    confidence: 0.8,
    warnings: [],
    sourceReferences: [
      { sourceId: "src-1", quote: "中心", location: "p1" },
    ],
    metadata: { extractorVersion: "1", provider: "fake" },
    ...partial,
  };
}

// --- transitions ---
{
  assertTransition("pending", "approved");
  assertTransition("pending", "reviewing");
  assertTransition("reviewing", "rejected");
  assertTransition("approved", "converted");
  assert.throws(() => assertTransition("rejected", "approved"), /transition/);
  console.log("KP005 transitions PASS");
}

// --- create / duplicate / list ---
{
  clock = Date.parse(NOW);
  const review = createAikidoCandidateReview({
    rootDir: tmpDir("aikido-rev-"),
    now,
  });

  const r1 = review.createReview({ ...candidate(), now: NOW });
  assert.strictEqual(r1.status, "pending");
  assert.strictEqual(r1.candidateId, "cand-aaa111");
  assert.deepStrictEqual(r1.candidateMetadata.provider, "fake");
  assert.ok(fs.existsSync(path.join(review.storeDir, `${r1.id}.json`)));

  assert.throws(
    () => review.createReview(candidate()),
    /duplicate candidateId/
  );
  const dup = review.createReview({
    ...candidate({ candidateId: "cand-aaa111", title: "別" }),
    allowDuplicateCandidate: true,
  });
  assert.ok(dup.id !== r1.id);

  advance(1000);
  review.createReview({
    ...candidate({
      candidateId: "cand-bbb",
      category: "training",
      title: "稽古",
      tags: ["keiko"],
      confidence: 0.3,
      warnings: ["w1"],
    }),
  });

  const listed = review.listReviews();
  assert.ok(listed[0].createdAt <= listed[listed.length - 1].createdAt);
  assert.strictEqual(review.listReviews({ category: "training" }).length, 1);
  assert.strictEqual(review.listReviews({ minConfidence: 0.5 }).length >= 1, true);
  assert.strictEqual(review.listReviews({ hasWarnings: true }).length, 1);
  assert.strictEqual(review.listReviews({ limit: 1 }).length, 1);
  console.log("KP005 create-list PASS");
}

// --- createReviews from extraction ---
{
  const review = createAikidoCandidateReview({
    rootDir: tmpDir("aikido-rev-batch-"),
    now: () => NOW,
  });
  const created = review.createReviews({
    sourceId: "src-x",
    candidates: [
      candidate({ candidateId: "c1", sourceId: "src-x" }),
      candidate({ candidateId: "c2", sourceId: "src-x", title: "二" }),
      { candidateId: "bad", sourceId: "src-x", title: "", category: "principle" },
    ],
    errors: [],
    warnings: [],
  });
  assert.strictEqual(created.summary.createdCount, 2);
  assert.strictEqual(created.summary.errorCount, 1);
  assert.strictEqual(created.reviews.length, 2);
  console.log("KP005 createReviews PASS");
}

// --- update / protect / approve / reject ---
{
  clock = Date.parse(NOW);
  const review = createAikidoCandidateReview({
    rootDir: tmpDir("aikido-rev-flow-"),
    now,
  });
  const r = review.createReview(candidate({ candidateId: "flow-1" }));

  assert.throws(
    () => review.updateReview(r.id, { status: "approved" }),
    /cannot be changed/
  );
  assert.throws(
    () => review.updateReview(r.id, { candidateId: "x" }),
    /cannot be changed/
  );

  advance(1000);
  const updated = review.updateReview(r.id, {
    title: "修正タイトル",
    reviewerNotes: "直した",
  });
  assert.strictEqual(updated.title, "修正タイトル");
  assert.strictEqual(updated.status, "pending");

  assert.throws(() => review.rejectReview(r.id, {}), /rejectionReason/);

  const rejected = review.rejectReview(r.id, {
    rejectionReason: "根拠不足",
  });
  assert.strictEqual(rejected.status, "rejected");
  assert.ok(rejected.rejectedAt);

  const r2 = review.createReview(candidate({ candidateId: "flow-2" }));
  const approved = review.approveReview(r2.id, {
    reviewerNotes: "OK",
  });
  assert.strictEqual(approved.status, "approved");
  assert.ok(approved.approvedAt);
  assert.strictEqual(approved.reviewerNotes, "OK");
  console.log("KP005 update-approve-reject PASS");
}

// --- knowledge conversion + atomicity ---
{
  clock = Date.parse(NOW);
  const root = tmpDir("aikido-rev-know-");
  const knowledgeStore = createAikidoKnowledgeStore({
    rootDir: root,
    now,
  });
  const review = createAikidoCandidateReview({
    rootDir: root,
    now,
    knowledgeStore,
  });

  const r = review.createReview(candidate({ candidateId: "conv-1" }));
  assert.throws(
    () => review.createKnowledgeFromReview(r.id),
    /only approved/
  );

  review.approveReview(r.id);
  const converted = review.createKnowledgeFromReview(r.id, {
    knowledgeId: "know-1",
  });
  assert.strictEqual(converted.review.status, "converted");
  assert.strictEqual(converted.knowledge.id, "know-1");
  assert.deepStrictEqual(converted.knowledge.sources, ["src-1"]);
  assert.strictEqual(converted.review.knowledgeId, "know-1");
  assert.ok(converted.review.convertedAt);

  assert.throws(
    () => review.createKnowledgeFromReview(r.id),
    /only approved|already converted/
  );
  assert.throws(
    () => review.updateReview(r.id, { title: "x" }),
    /converted reviews cannot/
  );

  // atomicity: failing createKnowledge leaves review unchanged
  const r3 = review.createReview(candidate({ candidateId: "conv-fail" }));
  review.approveReview(r3.id);
  const failingStore = {
    createKnowledge() {
      throw new Error("disk full");
    },
  };
  const reviewFail = createAikidoCandidateReview({
    rootDir: root,
    now,
    knowledgeStore: failingStore,
  });
  // use same files - find r3
  const before = reviewFail.findReview(r3.id);
  assert.throws(() => reviewFail.createKnowledgeFromReview(r3.id), /disk full/);
  const after = reviewFail.findReview(r3.id);
  assert.strictEqual(after.status, before.status);
  assert.strictEqual(after.knowledgeId, null);
  console.log("KP005 convert PASS");
}

// --- review without knowledge store ---
{
  const review = createAikidoCandidateReview({
    rootDir: tmpDir("aikido-rev-solo-"),
    now: () => NOW,
  });
  const r = review.createReview(candidate({ candidateId: "solo-1" }));
  review.approveReview(r.id);
  assert.throws(
    () => review.createKnowledgeFromReview(r.id),
    /knowledgeStore/
  );
  assert.strictEqual(review.findReview(r.id).status, "approved");
  console.log("KP005 no-knowledge-store PASS");
}

// --- intake extractAndCreateReviews ---
{
  const root = tmpDir("aikido-rev-intake-");
  const review = createAikidoCandidateReview({ rootDir: root, now: () => NOW });
  const intake = createAikidoSourceIntake({
    rootDir: root,
    now: () => NOW,
    candidateReview: review,
    provider: {
      name: "fake",
      extractKnowledge() {
        return {
          candidates: [
            candidate({
              candidateId: "from-extract",
              sourceId: "intake-src",
            }),
          ],
        };
      },
    },
  });
  intake.createSource({
    id: "intake-src",
    sourceType: "article",
    title: "記事",
    rawText: "合気道では中心を保つことが大切である。",
  });
  const out = intake.extractAndCreateReviews("intake-src", { now: NOW });
  assert.strictEqual(out.summary.createdCount, 1);
  assert.strictEqual(intake.findSource("intake-src").status, "collected");
  console.log("KP005 intake-link PASS");
}

console.log("aikido-candidate-review-test: all PASS");
