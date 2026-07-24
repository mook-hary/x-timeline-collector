/**
 * EA-004 — Launcher Dashboard.
 * Run: node test/launcher-dashboard-test.js
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  createLauncherDashboardApi,
  DEFAULT_REVIEW_URL,
  DEFAULT_EDITORIAL_URL,
} = require("../lib/launcher-dashboard-api");
const {
  createLauncherDashboardServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
} = require("../lib/launcher-dashboard-server");
const { resolveSafeStaticPath } = require("../lib/dashboard-http");
const { createAikidoCandidateReview } = require("../lib/aikido-candidate-review");
const { createAikidoKnowledgeStore } = require("../lib/aikido-knowledge");
const { createEditorialStore } = require("../lib/editorial-store");
const { createPublishLedger } = require("../lib/publish-ledger");
const { createMorningPipeline } = require("../lib/aikido-morning-pipeline");
const { createEditorialDashboardApi } = require("../lib/editorial-dashboard-api");
const {
  createAikidoReviewDashboardApi,
} = require("../lib/aikido-review-dashboard-api");
const {
  createEditorialDashboardServer,
} = require("../lib/editorial-dashboard-server");
const {
  createAikidoReviewDashboardServer,
} = require("../lib/aikido-review-dashboard-server");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-25T07:00:00.000Z";

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
          } catch (_error) {
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

function seed(root) {
  const knowledge = createAikidoKnowledgeStore({
    rootDir: root,
    now: () => NOW,
  });
  const review = createAikidoCandidateReview({
    rootDir: root,
    now: () => NOW,
    knowledgeStore: knowledge,
  });
  const editorial = createEditorialStore({
    rootDir: root,
    now: () => NOW,
  });
  const ledger = createPublishLedger({ rootDir: root });

  knowledge.createKnowledge({
    id: "know-launcher-1",
    title: "中心",
    category: "principle",
    summary: "中心を保つ",
    content: "合気道では中心を保つ。",
    tags: ["center"],
    difficulty: 2,
    sources: ["稽古"],
  });

  review.createReview({
    candidateId: "cand-pending-1",
    title: "Pending cand",
    category: "principle",
    summary: "s",
    content: "c",
    tags: [],
    difficulty: 2,
    confidence: 0.8,
    sourceId: "src-1",
    now: NOW,
  });
  const approved = review.createReview({
    candidateId: "cand-approved-1",
    title: "Approved cand",
    category: "principle",
    summary: "s",
    content: "c",
    tags: [],
    difficulty: 2,
    confidence: 0.9,
    sourceId: "src-2",
    now: NOW,
  });
  review.approveReview(approved.id, { now: NOW });

  editorial.create({
    id: "ed-launcher-1",
    source: "aikido",
    type: "post",
    title: "Draft editorial",
    body: "本文です。",
    status: "draft",
    metadata: { knowledgeId: "know-launcher-1" },
  });

  return { knowledge, review, editorial, ledger };
}

async function main() {
  // path safety / dashboard-http reuse
  {
    const root = tmpDir("ea004-static-");
    const staticDir = path.join(root, "launcher");
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, "index.html"), "<html></html>\n");
    assert.ok(resolveSafeStaticPath(staticDir, "/index.html"));
    assert.strictEqual(resolveSafeStaticPath(staticDir, "/../../.env"), null);
    console.log("EA004 path/dashboard-http PASS");
  }

  // localhost defaults
  {
    assert.strictEqual(DEFAULT_HOST, "127.0.0.1");
    assert.strictEqual(DEFAULT_PORT, 4173);
    assert.ok(DEFAULT_REVIEW_URL.includes("4175"));
    assert.ok(DEFAULT_EDITORIAL_URL.includes("4174"));
    console.log("EA004 ports PASS");
  }

  // stats + activity via APIs
  {
    const root = tmpDir("ea004-stats-");
    const { knowledge, review, editorial, ledger } = seed(root);
    const pipeline = createMorningPipeline({
      rootDir: root,
      now: () => NOW,
      urls: [],
      collector: {
        async collectUrls() {
          return {
            results: [],
            summary: {
              createdCount: 0,
              skippedCount: 0,
              errorCount: 0,
              requestedCount: 0,
            },
          };
        },
      },
      analyzer: {
        async analyzeSources() {
          return {
            extractions: [],
            processed: 0,
            created: 0,
            skipped: 0,
            warnings: [],
            errors: [],
          };
        },
      },
      candidateCreator: {
        hasCandidatesForSource: () => true,
        createCandidates() {
          return {
            reviews: [],
            processed: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            warnings: [],
            errors: [],
          };
        },
      },
      logger: { info() {}, error() {} },
    });
    await pipeline.run({ urls: [] });

    const api = createLauncherDashboardApi({
      rootDir: root,
      now: () => NOW,
      reviewApi: createAikidoReviewDashboardApi({
        rootDir: root,
        now: () => NOW,
        knowledgeStore: knowledge,
        reviewStore: review,
      }),
      editorialApi: createEditorialDashboardApi({
        rootDir: root,
        now: () => NOW,
        editorialStore: editorial,
        knowledgeStore: knowledge,
        candidateReview: review,
        ledger,
        morningPipeline: pipeline,
        morningLogger: { info() {}, error() {} },
      }),
      morningPipeline: pipeline,
      knowledgeStore: knowledge,
      reviewUrl: "http://127.0.0.1:9",
      editorialUrl: "http://127.0.0.1:9",
    });

    const stats = api.getStats();
    assert.strictEqual(stats.ok, true);
    assert.strictEqual(stats.data.pendingCandidates, 1);
    assert.strictEqual(stats.data.approvedCandidates, 1);
    assert.strictEqual(stats.data.knowledge, 1);
    assert.strictEqual(stats.data.editorialDrafts, 1);
    assert.ok(stats.data.todaysPipeline >= 1);

    const activity = api.getActivity(20);
    assert.strictEqual(activity.ok, true);
    assert.ok(Array.isArray(activity.data.activity));
    const types = new Set(activity.data.activity.map((a) => a.type));
    assert.ok(types.has("Pipeline") || types.has("Approve") || types.has("Editorial Save"));

    const home = api.getHome();
    assert.strictEqual(home.ok, true);
    assert.strictEqual(home.data.title, "Aikido Knowledge Platform");
    assert.ok(home.data.links.review);
    assert.ok(home.data.links.editorial);
    console.log("EA004 stats/activity PASS");
  }

  // health + launcher server + pipeline run
  {
    const root = tmpDir("ea004-http-");
    const { knowledge, review, editorial, ledger } = seed(root);
    const staticDir = path.join(root, "launcher");
    fs.mkdirSync(staticDir, { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "..", "launcher", "index.html"),
      path.join(staticDir, "index.html")
    );
    fs.copyFileSync(
      path.join(__dirname, "..", "launcher", "app.js"),
      path.join(staticDir, "app.js")
    );

    const pipeline = createMorningPipeline({
      rootDir: root,
      now: () => NOW,
      urls: ["https://example.com/x"],
      collector: {
        async collectUrls(urls) {
          return {
            results: urls.map((url) => ({
              url,
              ok: true,
              skipped: true,
              created: false,
            })),
            summary: {
              requestedCount: urls.length,
              createdCount: 0,
              skippedCount: urls.length,
              errorCount: 0,
            },
          };
        },
      },
      analyzer: {
        async analyzeSources() {
          return {
            extractions: [],
            processed: 0,
            created: 0,
            skipped: 0,
            warnings: [],
            errors: [],
          };
        },
      },
      candidateCreator: {
        hasCandidatesForSource: () => true,
        createCandidates() {
          return {
            reviews: [],
            processed: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            warnings: [],
            errors: [],
          };
        },
      },
      logger: { info() {}, error() {} },
    });

    // Peer dashboards for health
    const reviewServer = createAikidoReviewDashboardServer({
      host: "127.0.0.1",
      port: 0,
      rootDir: root,
      staticDir: path.join(root, "review-dashboard"),
      api: createAikidoReviewDashboardApi({
        rootDir: root,
        now: () => NOW,
        knowledgeStore: knowledge,
        reviewStore: review,
      }),
    });
    fs.mkdirSync(path.join(root, "review-dashboard"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "review-dashboard", "index.html"),
      "<html></html>\n"
    );
    await reviewServer.listen();
    const reviewPort = reviewServer.server.address().port;

    const editorialServer = createEditorialDashboardServer({
      host: "127.0.0.1",
      port: 0,
      rootDir: root,
      staticDir: path.join(root, "dashboard"),
      api: createEditorialDashboardApi({
        rootDir: root,
        now: () => NOW,
        editorialStore: editorial,
        knowledgeStore: knowledge,
        candidateReview: review,
        ledger,
        morningPipeline: pipeline,
        morningLogger: { info() {}, error() {} },
      }),
    });
    fs.mkdirSync(path.join(root, "dashboard"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dashboard", "index.html"),
      "<html></html>\n"
    );
    await editorialServer.listen();
    const editorialPort = editorialServer.server.address().port;

    const reviewHealth = await httpRequest(reviewPort, "GET", "/health");
    assert.strictEqual(reviewHealth.status, 200);
    assert.strictEqual(reviewHealth.json.ok, true);

    const editorialHealth = await httpRequest(editorialPort, "GET", "/health");
    assert.strictEqual(editorialHealth.status, 200);
    assert.strictEqual(editorialHealth.json.ok, true);

    const api = createLauncherDashboardApi({
      rootDir: root,
      now: () => NOW,
      reviewUrl: `http://127.0.0.1:${reviewPort}`,
      editorialUrl: `http://127.0.0.1:${editorialPort}`,
      reviewApi: createAikidoReviewDashboardApi({
        rootDir: root,
        now: () => NOW,
        knowledgeStore: knowledge,
        reviewStore: review,
      }),
      editorialApi: createEditorialDashboardApi({
        rootDir: root,
        now: () => NOW,
        editorialStore: editorial,
        knowledgeStore: knowledge,
        candidateReview: review,
        ledger,
        morningPipeline: pipeline,
        morningLogger: { info() {}, error() {} },
      }),
      morningPipeline: pipeline,
      knowledgeStore: knowledge,
    });

    const launcher = createLauncherDashboardServer({
      host: "127.0.0.1",
      port: 0,
      rootDir: root,
      staticDir,
      api,
    });
    await launcher.listen();
    const port = launcher.server.address().port;
    assert.strictEqual(launcher.host, "127.0.0.1");

    const healthSelf = await httpRequest(port, "GET", "/health");
    assert.strictEqual(healthSelf.status, 200);
    assert.strictEqual(healthSelf.json.ok, true);

    const sys = await httpRequest(port, "GET", "/api/health");
    assert.strictEqual(sys.status, 200);
    assert.strictEqual(sys.json.data.review.status, "Available");
    assert.strictEqual(sys.json.data.editorial.status, "Available");
    assert.strictEqual(sys.json.data.pipeline.status, "Available");

    const stats = await httpRequest(port, "GET", "/api/stats");
    assert.strictEqual(stats.status, 200);
    assert.ok(stats.json.data.pendingCandidates >= 1);

    const activity = await httpRequest(port, "GET", "/api/activity");
    assert.strictEqual(activity.status, 200);
    assert.ok(Array.isArray(activity.json.data.activity));

    const home = await httpRequest(port, "GET", "/api/home");
    assert.strictEqual(home.status, 200);
    assert.ok(home.json.data.links.review.includes(String(reviewPort)));
    assert.ok(home.json.data.links.editorial.includes(String(editorialPort)));

    const html = await httpRequest(port, "GET", "/");
    assert.strictEqual(html.status, 200);
    assert.ok(html.text.includes("Aikido Knowledge Platform"));
    assert.ok(html.text.includes("Open Review Dashboard"));
    assert.ok(html.text.includes("Open Editorial Dashboard"));
    assert.ok(html.text.includes("Auto-refresh 30s") || html.text.includes("30"));

    const appJs = await httpRequest(port, "GET", "/app.js");
    assert.strictEqual(appJs.status, 200);
    assert.ok(appJs.text.includes("30000") || appJs.text.includes("REFRESH_MS"));

    const run = await httpRequest(port, "POST", "/api/pipeline/morning/run", {});
    assert.strictEqual(run.status, 200);
    assert.strictEqual(run.json.ok, true);

    await launcher.close();
    await reviewServer.close();
    await editorialServer.close();
    console.log("EA004 http/health/pipeline/links PASS");
  }

  console.log("launcher-dashboard-test: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
