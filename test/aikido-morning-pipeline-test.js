/**
 * EA-003 — Aikido Morning Pipeline.
 * Run: node test/aikido-morning-pipeline-test.js
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  createMorningPipeline,
  ERROR_CODES,
  LOG_DIR_REL,
  LOCK_REL,
  listPipelineLogs,
} = require("../lib/aikido-morning-pipeline");
const {
  createEditorialDashboardApi,
  ERROR_CODES: DASH_CODES,
} = require("../lib/editorial-dashboard-api");
const {
  createEditorialDashboardServer,
} = require("../lib/editorial-dashboard-server");
const { createEditorialStore } = require("../lib/editorial-store");
const { createAikidoSourceIntake } = require("../lib/aikido-source-intake");
const { createAikidoCandidateReview } = require("../lib/aikido-candidate-review");
const { createPublishLedger } = require("../lib/publish-ledger");
const { createXPostFormatter } = require("../lib/x-post-formatter");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-25T06:00:00.000Z";

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

function makeFakes(root) {
  const intake = createAikidoSourceIntake({ rootDir: root, now: () => NOW });
  const review = createAikidoCandidateReview({
    rootDir: root,
    now: () => NOW,
  });

  const collectCalls = [];
  const analyzeCalls = [];
  const candidateCalls = [];

  const collector = {
    async collectUrls(urls) {
      collectCalls.push(urls);
      const results = [];
      for (const url of urls) {
        const source = intake.createSource({
          sourceType: "article",
          title: `Page ${url}`,
          url,
          rawText:
            "合気道では中心を保つ。力を抜いて相手とつながる。稽古の基本である。".repeat(
              2
            ),
          language: "ja",
          allowDuplicateUrl: false,
          now: NOW,
        });
        results.push({ url, ok: true, source, created: true, warnings: [] });
      }
      return {
        results,
        summary: {
          requestedCount: urls.length,
          createdCount: results.length,
          skippedCount: 0,
          errorCount: 0,
        },
      };
    },
  };

  const analyzer = {
    async analyzeSources(sources, opts = {}) {
      analyzeCalls.push(sources.map((s) => s.id));
      const extractions = [];
      let skipped = 0;
      let processed = 0;
      let created = 0;
      for (const source of sources) {
        if (opts.shouldSkipSource && opts.shouldSkipSource(source)) {
          skipped += 1;
          continue;
        }
        processed += 1;
        const candidates = [
          {
            candidateId: `cand-fixed-${source.id}`,
            title: "中心を保つ",
            category: "principle",
            summary: "合気道では中心を保つ。",
            content: "力を抜いて相手とつながる。",
            tags: ["center"],
            difficulty: 2,
            confidence: 0.9,
            sourceId: source.id,
            warnings: [],
            sourceReferences: [],
            metadata: { provider: "fake" },
          },
        ];
        created += candidates.length;
        extractions.push({
          sourceId: source.id,
          candidates,
          errors: [],
          warnings: [],
          metadata: { provider: "fake", extractedAt: NOW },
        });
      }
      return { extractions, processed, created, skipped, warnings: [], errors: [] };
    },
  };

  const candidateCreator = {
    hasCandidatesForSource(sourceId) {
      return review.listReviews({ sourceId }).length > 0;
    },
    createCandidates(extractions, callOptions = {}) {
      candidateCalls.push(extractions.length);
      let processed = 0;
      let created = 0;
      let skipped = 0;
      const warnings = [];
      const errors = [];
      const reviews = [];
      for (const extraction of extractions) {
        processed += 1;
        if (
          extraction.sourceId &&
          candidateCreator.hasCandidatesForSource(extraction.sourceId)
        ) {
          skipped += 1;
          warnings.push(`skipped existing candidates for source: ${extraction.sourceId}`);
          continue;
        }
        const out = review.createReviews(extraction, callOptions);
        reviews.push(...out.reviews);
        created += out.summary.createdCount;
        skipped += out.summary.skippedCount;
      }
      return {
        reviews,
        processed,
        created,
        updated: 0,
        skipped,
        warnings,
        errors,
      };
    },
  };

  return {
    intake,
    review,
    collector,
    analyzer,
    candidateCreator,
    collectCalls,
    analyzeCalls,
    candidateCalls,
  };
}

async function main() {
  // 1 create pipeline
  {
    const root = tmpDir("ea003-create-");
    const fakes = makeFakes(root);
    const pipeline = createMorningPipeline({
      rootDir: root,
      now: () => NOW,
      collector: fakes.collector,
      analyzer: fakes.analyzer,
      candidateCreator: fakes.candidateCreator,
      sourceIntake: fakes.intake,
      urls: ["https://example.com/a"],
      logger: { info() {}, error() {} },
    });
    assert.ok(pipeline);
    assert.strictEqual(typeof pipeline.run, "function");
    assert.strictEqual(pipeline.getStatus().status, "Idle");
    console.log("EA003 create PASS");
  }

  // 2-4 collect / analyze / candidate called in order
  {
    const root = tmpDir("ea003-order-");
    const fakes = makeFakes(root);
    const order = [];
    const pipeline = createMorningPipeline({
      rootDir: root,
      now: () => NOW,
      urls: ["https://example.com/a"],
      sourceIntake: fakes.intake,
      collector: {
        async collectUrls(urls) {
          order.push("Collect");
          return fakes.collector.collectUrls(urls);
        },
      },
      analyzer: {
        async analyzeSources(sources, opts) {
          order.push("Analyze");
          return fakes.analyzer.analyzeSources(sources, opts);
        },
      },
      candidateCreator: {
        hasCandidatesForSource: fakes.candidateCreator.hasCandidatesForSource,
        createCandidates(extractions, opts) {
          order.push("Candidate");
          return fakes.candidateCreator.createCandidates(extractions, opts);
        },
      },
      logger: { info() {}, error() {} },
    });

    const result = await pipeline.run({ dryRun: false });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(order, ["Collect", "Analyze", "Candidate"]);
    assert.strictEqual(result.steps.length, 3);
    assert.strictEqual(result.steps[0].name, "Collect");
    assert.strictEqual(result.steps[0].created, 1);
    assert.strictEqual(result.steps[2].created, 1);
    assert.strictEqual(fakes.review.listReviews({}).length, 1);
    console.log("EA003 step order PASS");
  }

  // 5 dry run — no collect / no candidate / no log
  {
    const root = tmpDir("ea003-dry-");
    const fakes = makeFakes(root);
    let collect = 0;
    let candidate = 0;
    const pipeline = createMorningPipeline({
      rootDir: root,
      now: () => NOW,
      urls: ["https://example.com/a"],
      sourceIntake: fakes.intake,
      collector: {
        async collectUrls() {
          collect += 1;
          return { results: [], summary: { createdCount: 0, skippedCount: 0, errorCount: 0 } };
        },
      },
      analyzer: fakes.analyzer,
      candidateCreator: {
        hasCandidatesForSource: () => false,
        createCandidates() {
          candidate += 1;
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

    const result = await pipeline.run({ dryRun: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(collect, 0);
    assert.strictEqual(candidate, 0);
    assert.strictEqual(listPipelineLogs(root).length, 0);
    assert.strictEqual(pipeline.getStatus().status, "Dry Run");
    assert.strictEqual(pipeline.getHistory().length, 0);
    console.log("EA003 dry-run PASS");
  }

  // 6 continue on error — collect fail stops later steps
  {
    const root = tmpDir("ea003-coe-");
    const fakes = makeFakes(root);
    let analyze = 0;
    let candidate = 0;
    const pipeline = createMorningPipeline({
      rootDir: root,
      now: () => NOW,
      urls: ["https://example.com/a"],
      sourceIntake: fakes.intake,
      collector: {
        async collectUrls() {
          return {
            results: [
              {
                url: "https://example.com/a",
                ok: false,
                skipped: false,
                error: { message: "boom" },
              },
            ],
            summary: {
              requestedCount: 1,
              createdCount: 0,
              skippedCount: 0,
              errorCount: 1,
            },
          };
        },
      },
      analyzer: {
        async analyzeSources() {
          analyze += 1;
          return { extractions: [], processed: 0, created: 0, skipped: 0, warnings: [], errors: [] };
        },
      },
      candidateCreator: {
        hasCandidatesForSource: () => false,
        createCandidates() {
          candidate += 1;
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

    const result = await pipeline.run();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, ERROR_CODES.COLLECT_FAILED);
    assert.strictEqual(analyze, 0);
    assert.strictEqual(candidate, 0);
    const names = result.steps.map((s) => s.name);
    assert.ok(names.includes("Analyze"));
    assert.ok(names.includes("Candidate"));
    assert.strictEqual(
      result.steps.find((s) => s.name === "Analyze").status,
      "skipped"
    );
    console.log("EA003 continue-on-error PASS");
  }

  // 7 log generated
  {
    const root = tmpDir("ea003-log-");
    const fakes = makeFakes(root);
    const pipeline = createMorningPipeline({
      rootDir: root,
      now: () => NOW,
      urls: ["https://example.com/a"],
      sourceIntake: fakes.intake,
      collector: fakes.collector,
      analyzer: fakes.analyzer,
      candidateCreator: fakes.candidateCreator,
      logger: { info() {}, error() {} },
    });
    await pipeline.run();
    const logs = listPipelineLogs(root);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].success, true);
    assert.ok(logs[0].version);
    assert.ok(Array.isArray(logs[0].steps));
    const dir = path.join(root, LOG_DIR_REL);
    assert.ok(fs.existsSync(dir));
    console.log("EA003 log PASS");
  }

  // 8 lock
  {
    const root = tmpDir("ea003-lock-");
    const fakes = makeFakes(root);
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const pipeline = createMorningPipeline({
      rootDir: root,
      now: () => NOW,
      urls: ["https://example.com/a"],
      sourceIntake: fakes.intake,
      collector: {
        async collectUrls(urls) {
          await gate;
          return fakes.collector.collectUrls(urls);
        },
      },
      analyzer: fakes.analyzer,
      candidateCreator: fakes.candidateCreator,
      logger: { info() {}, error() {} },
    });

    const p1 = pipeline.run();
    // wait until running
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(pipeline.isRunning(), true);
    let locked = null;
    try {
      await pipeline.run();
    } catch (error) {
      locked = error;
    }
    assert.ok(locked);
    assert.strictEqual(locked.code, ERROR_CODES.PIPELINE_ALREADY_RUNNING);
    releaseGate();
    const result = await p1;
    assert.strictEqual(result.success, true);
    console.log("EA003 lock PASS");
  }

  // 9 history
  {
    const root = tmpDir("ea003-hist-");
    const fakes = makeFakes(root);
    const pipeline = createMorningPipeline({
      rootDir: root,
      now: () => NOW,
      urls: ["https://example.com/a"],
      sourceIntake: fakes.intake,
      collector: fakes.collector,
      analyzer: fakes.analyzer,
      candidateCreator: fakes.candidateCreator,
      logger: { info() {}, error() {} },
    });
    await pipeline.run();
    // second run will skip candidates for same source
    await pipeline.run({ urls: [] });
    const history = pipeline.getHistory(20);
    assert.ok(history.length >= 1);
    assert.ok(history[0].startedAt);
    assert.ok("collected" in history[0]);
    assert.ok("candidates" in history[0]);
    console.log("EA003 history PASS");
  }

  // 12 duplicate candidate prevention
  {
    const root = tmpDir("ea003-dup-");
    const fakes = makeFakes(root);
    const pipeline = createMorningPipeline({
      rootDir: root,
      now: () => NOW,
      urls: ["https://example.com/dup"],
      sourceIntake: fakes.intake,
      collector: fakes.collector,
      analyzer: fakes.analyzer,
      candidateCreator: fakes.candidateCreator,
      logger: { info() {}, error() {} },
    });
    const first = await pipeline.run();
    assert.strictEqual(first.steps.find((s) => s.name === "Candidate").created, 1);
    const before = fakes.review.listReviews({});
    assert.strictEqual(before.length, 1);
    const bodyBefore = JSON.stringify(before[0]);

    // Re-run with empty collect; existing collected source should skip at analyze/candidate
    const second = await pipeline.run({ urls: [] });
    assert.strictEqual(second.success, true);
    const after = fakes.review.listReviews({});
    assert.strictEqual(after.length, 1);
    assert.strictEqual(JSON.stringify(after[0]), bodyBefore);
    console.log("EA003 duplicate PASS");
  }

  // 10 dashboard API
  {
    const root = tmpDir("ea003-api-");
    const fakes = makeFakes(root);
    const api = createEditorialDashboardApi({
      rootDir: root,
      editorialStore: createEditorialStore({ rootDir: root, now: () => NOW }),
      ledger: createPublishLedger({ rootDir: root }),
      formatter: createXPostFormatter({ now: NOW }),
      sourceIntake: fakes.intake,
      candidateReview: fakes.review,
      morningCollector: fakes.collector,
      morningAnalyzer: fakes.analyzer,
      morningCandidateCreator: fakes.candidateCreator,
      morningUrls: ["https://example.com/dash"],
      morningLogger: { info() {}, error() {} },
      now: () => NOW,
    });

    const status = api.getMorningPipelineStatus();
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.data.status, "Idle");

    const run = await api.runMorningPipeline({});
    assert.strictEqual(run.ok, true);
    assert.strictEqual(run.data.result.success, true);
    assert.ok(Array.isArray(run.data.history));
    assert.ok(run.data.candidateCount >= 1);

    const hist = api.getMorningPipelineHistory({ limit: 20 });
    assert.strictEqual(hist.ok, true);
    assert.ok(hist.data.history.length >= 1);
    console.log("EA003 dashboard API PASS");
  }

  // 10b HTTP routes
  {
    const root = tmpDir("ea003-http-");
    const staticDir = path.join(root, "dashboard");
    fs.mkdirSync(staticDir, { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "..", "dashboard", "index.html"),
      path.join(staticDir, "index.html")
    );
    const fakes = makeFakes(root);
    const api = createEditorialDashboardApi({
      rootDir: root,
      editorialStore: createEditorialStore({ rootDir: root, now: () => NOW }),
      ledger: createPublishLedger({ rootDir: root }),
      formatter: createXPostFormatter({ now: NOW }),
      sourceIntake: fakes.intake,
      candidateReview: fakes.review,
      morningCollector: fakes.collector,
      morningAnalyzer: fakes.analyzer,
      morningCandidateCreator: fakes.candidateCreator,
      morningUrls: ["https://example.com/http"],
      morningLogger: { info() {}, error() {} },
      now: () => NOW,
    });
    const server = createEditorialDashboardServer({
      host: "127.0.0.1",
      port: 0,
      rootDir: root,
      staticDir,
      api,
    });
    await new Promise((resolve, reject) => {
      server.server.listen(0, "127.0.0.1", resolve);
      server.server.once("error", reject);
    });
    const port = server.server.address().port;

    const st = await httpRequest(port, "GET", "/api/pipeline/morning/status");
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.json.ok, true);

    const run = await httpRequest(port, "POST", "/api/pipeline/morning/run", {});
    assert.strictEqual(run.status, 200);
    assert.strictEqual(run.json.ok, true);

    const hist = await httpRequest(port, "GET", "/api/pipeline/morning/history");
    assert.strictEqual(hist.status, 200);
    assert.ok(hist.json.data.history.length >= 1);

    const html = await httpRequest(port, "GET", "/");
    assert.ok(html.text.includes("Morning Pipeline"));

    await new Promise((resolve) => server.server.close(resolve));
    console.log("EA003 http PASS");
  }

  // lock file path uses aikido-morning.lock not EP-046 lock
  {
    assert.ok(LOCK_REL.includes("aikido-morning.lock"));
    assert.ok(!LOCK_REL.includes("morning-pipeline.lock"));
    console.log("EA003 lock path PASS");
  }

  console.log("aikido-morning-pipeline-test: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
