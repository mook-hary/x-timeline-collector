/**
 * EA-001 — Candidate Review Dashboard.
 * Run: node test/aikido-review-dashboard-test.js
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  createAikidoReviewDashboardApi,
  ERROR_CODES,
} = require("../lib/aikido-review-dashboard-api");
const {
  createAikidoReviewDashboardServer,
  DEFAULT_HOST,
} = require("../lib/aikido-review-dashboard-server");
const { createAikidoCandidateReview } = require("../lib/aikido-candidate-review");
const { createAikidoKnowledgeStore } = require("../lib/aikido-knowledge");
const { createAikidoSourceIntake } = require("../lib/aikido-source-intake");
const { resolveSafeStaticPath } = require("../lib/dashboard-http");
const {
  createEditorialDashboardServer,
} = require("../lib/editorial-dashboard-server");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-25T05:00:00.000Z";
let clock = Date.parse(NOW);
function now() {
  return new Date(clock).toISOString();
}
function advance(ms) {
  clock += ms;
}

function httpRequest(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_e) {
            json = null;
          }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function seedPending(root, partial = {}) {
  const knowledge = createAikidoKnowledgeStore({ rootDir: root, now });
  const sourceIntake = createAikidoSourceIntake({ rootDir: root, now });
  const source = sourceIntake.createSource({
    id: partial.sourceId || "src-rev-1",
    sourceType: "article",
    title: "出典記事",
    url: "https://example.com/aikido",
    notes: "出典メモ",
  });
  const reviewStore = createAikidoCandidateReview({
    rootDir: root,
    now,
    knowledgeStore: knowledge,
  });
  const review = reviewStore.createReview({
    candidateId: partial.candidateId || "cand-1",
    sourceId: source.id,
    title: partial.title || "中心の感覚",
    category: partial.category || "principle",
    summary: partial.summary || "中心を保つ",
    content: partial.content || "力が抜けた状態で軸を意識する。",
    tags: partial.tags || ["center"],
    difficulty: partial.difficulty != null ? partial.difficulty : 2,
    confidence: 0.8,
    warnings: [],
    sourceReferences: [
      { sourceId: source.id, quote: "中心", location: "p1" },
    ],
  });
  return { knowledge, sourceIntake, source, reviewStore, review };
}

async function main() {
  // path safety
  {
    const root = tmpDir("rev-dash-path-");
    const staticDir = path.join(root, "review-dashboard");
    fs.mkdirSync(staticDir, { recursive: true });
    assert.strictEqual(resolveSafeStaticPath(staticDir, "/../../.env"), null);
    assert.strictEqual(
      resolveSafeStaticPath(staticDir, "/%2e%2e/%2e%2e/.env"),
      null
    );
    console.log("EA001 path PASS");
  }

  // API core
  {
    clock = Date.parse(NOW);
    const root = tmpDir("rev-dash-api-");
    const seeded = seedPending(root);
    const api = createAikidoReviewDashboardApi({
      rootDir: root,
      reviewStore: seeded.reviewStore,
      knowledgeStore: seeded.knowledge,
      sourceIntake: seeded.sourceIntake,
    });

    const listed = api.listCandidates({ status: "pending" });
    assert.strictEqual(listed.ok, true);
    assert.strictEqual(listed.data.candidates.length, 1);
    assert.strictEqual(listed.data.pendingCount, 1);

    const missing = api.getCandidate("nope");
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.error.code, ERROR_CODES.CANDIDATE_NOT_FOUND);

    const detail = api.getCandidate(seeded.review.id);
    assert.strictEqual(detail.ok, true);
    assert.strictEqual(detail.data.candidate.source.title, "出典記事");
    assert.strictEqual(
      detail.data.candidate.source.url,
      "https://example.com/aikido"
    );

    assert.strictEqual(
      api.saveCandidate(seeded.review.id, { title: "" }).error.code,
      ERROR_CODES.CANDIDATE_TITLE_REQUIRED
    );
    assert.strictEqual(
      api.saveCandidate(seeded.review.id, {
        title: "t",
        category: "",
        content: "c",
      }).error.code,
      ERROR_CODES.CANDIDATE_CATEGORY_REQUIRED
    );
    assert.strictEqual(
      api.saveCandidate(seeded.review.id, {
        title: "t",
        category: "principle",
        content: "  ",
      }).error.code,
      ERROR_CODES.CANDIDATE_CONTENT_REQUIRED
    );

    const saved = api.saveCandidate(seeded.review.id, {
      title: "編集タイトル",
      category: "principle",
      summary: "編集要約",
      content: "編集本文です。",
      tags: "a, b",
      difficulty: 3,
    });
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(saved.data.candidate.title, "編集タイトル");
    assert.deepStrictEqual(saved.data.candidate.tags, ["a", "b"]);

    const knowBefore = seeded.knowledge.listKnowledge().length;
    const preview = api.knowledgePreview(seeded.review.id);
    assert.strictEqual(preview.ok, true);
    assert.strictEqual(preview.data.preview.title, "編集タイトル");
    assert.strictEqual(seeded.knowledge.listKnowledge().length, knowBefore);
    assert.strictEqual(
      seeded.reviewStore.findReview(seeded.review.id).status,
      "pending"
    );

    assert.strictEqual(
      api.approveCandidate(seeded.review.id, {}).error.code,
      ERROR_CODES.APPROVAL_CONFIRMATION_REQUIRED
    );

    const approved = api.approveCandidate(seeded.review.id, { confirm: true });
    assert.strictEqual(approved.ok, true);
    assert.ok(approved.data.knowledgeId);
    assert.strictEqual(
      seeded.reviewStore.findReview(seeded.review.id).status,
      "converted"
    );
    assert.strictEqual(seeded.knowledge.listKnowledge().length, knowBefore + 1);

    const again = api.approveCandidate(seeded.review.id, { confirm: true });
    assert.strictEqual(again.error.code, ERROR_CODES.ALREADY_APPROVED);
    assert.strictEqual(seeded.knowledge.listKnowledge().length, knowBefore + 1);

    const editLocked = api.saveCandidate(seeded.review.id, {
      title: "x",
      category: "principle",
      content: "y",
    });
    assert.strictEqual(editLocked.error.code, ERROR_CODES.CANDIDATE_READONLY);
    console.log("EA001 approve PASS");
  }

  // knowledge failure leaves pending
  {
    clock = Date.parse(NOW);
    const root = tmpDir("rev-dash-fail-");
    const seeded = seedPending(root, { candidateId: "cand-fail" });
    const badKnowledge = {
      createKnowledge() {
        const err = new Error("disk full");
        err.code = "aikido-knowledge-io";
        throw err;
      },
      listKnowledge: () => [],
      findKnowledge: () => null,
    };
    const reviewStore = createAikidoCandidateReview({
      rootDir: root,
      now,
      knowledgeStore: badKnowledge,
    });
    // reuse existing review file from seeded by using same store dir - recreate review
    const review = reviewStore.createReview({
      candidateId: "cand-fail-2",
      sourceId: seeded.source.id,
      title: "失敗テスト",
      category: "principle",
      summary: "s",
      content: "本文",
      tags: [],
      difficulty: 1,
      sourceReferences: [],
    });
    const api = createAikidoReviewDashboardApi({
      rootDir: root,
      reviewStore,
      knowledgeStore: badKnowledge,
      sourceIntake: seeded.sourceIntake,
    });
    const result = api.approveCandidate(review.id, { confirm: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, ERROR_CODES.KNOWLEDGE_CREATE_FAILED);
    assert.strictEqual(reviewStore.findReview(review.id).status, "pending");
    console.log("EA001 knowledge-fail PASS");
  }

  // reject
  {
    clock = Date.parse(NOW);
    const root = tmpDir("rev-dash-rej-");
    const seeded = seedPending(root, { candidateId: "cand-rej" });
    const api = createAikidoReviewDashboardApi({
      rootDir: root,
      reviewStore: seeded.reviewStore,
      knowledgeStore: seeded.knowledge,
      sourceIntake: seeded.sourceIntake,
    });
    assert.strictEqual(
      api.rejectCandidate(seeded.review.id, {}).error.code,
      ERROR_CODES.REJECTION_CONFIRMATION_REQUIRED
    );
    const knowBefore = seeded.knowledge.listKnowledge().length;
    const rejected = api.rejectCandidate(seeded.review.id, {
      confirm: true,
      reason: "範囲外",
    });
    assert.strictEqual(rejected.ok, true);
    assert.strictEqual(
      seeded.reviewStore.findReview(seeded.review.id).status,
      "rejected"
    );
    assert.strictEqual(
      seeded.reviewStore.findReview(seeded.review.id).rejectionReason,
      "範囲外"
    );
    assert.strictEqual(seeded.knowledge.listKnowledge().length, knowBefore);

    const reReject = api.rejectCandidate(seeded.review.id, {
      confirm: true,
      reason: "again",
    });
    assert.strictEqual(reReject.error.code, ERROR_CODES.ALREADY_REJECTED);
    const reApprove = api.approveCandidate(seeded.review.id, { confirm: true });
    assert.strictEqual(reApprove.error.code, ERROR_CODES.ALREADY_REJECTED);
    console.log("EA001 reject PASS");
  }

  // HTTP server + ED-001 regression smoke
  {
    clock = Date.parse(NOW);
    const root = tmpDir("rev-dash-http-");
    const seeded = seedPending(root, { candidateId: "cand-http" });
    const staticDir = path.join(root, "review-dashboard");
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, "index.html"), "<title>review</title>\n");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");

    const dash = createAikidoReviewDashboardServer({
      host: "127.0.0.1",
      port: 0,
      rootDir: root,
      staticDir,
      apiOptions: {
        reviewStore: seeded.reviewStore,
        knowledgeStore: seeded.knowledge,
        sourceIntake: seeded.sourceIntake,
      },
    });
    await new Promise((resolve, reject) => {
      dash.server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
    });
    assert.strictEqual(dash.server.address().address, "127.0.0.1");
    assert.strictEqual(DEFAULT_HOST, "127.0.0.1");
    const port = dash.server.address().port;

    const home = await httpRequest(port, "GET", "/");
    assert.strictEqual(home.status, 200);

    const list = await httpRequest(port, "GET", "/api/candidates?status=pending");
    assert.strictEqual(list.json.ok, true);
    assert.strictEqual(list.json.data.candidates[0].id, seeded.review.id);

    const trav = await httpRequest(port, "GET", "/../../.env");
    assert.strictEqual(trav.status, 403);
    assert.ok(!trav.text.includes("SECRET"));

    await new Promise((r) => dash.server.close(() => r()));

    // ED-001 still constructs
    const edRoot = tmpDir("rev-ed-regress-");
    const edStatic = path.join(edRoot, "dashboard");
    fs.mkdirSync(edStatic, { recursive: true });
    fs.writeFileSync(path.join(edStatic, "index.html"), "ok\n");
    const ed = createEditorialDashboardServer({
      host: "127.0.0.1",
      port: 0,
      rootDir: edRoot,
      staticDir: edStatic,
    });
    await new Promise((resolve, reject) => {
      ed.server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
    });
    assert.strictEqual(ed.server.address().address, "127.0.0.1");
    await new Promise((r) => ed.server.close(() => r()));
    console.log("EA001 http PASS");
  }

  console.log("aikido-review-dashboard-test: all PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
