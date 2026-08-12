/**
 * COLLECT-HEALTH-001 — X collector session / metrics / freshness.
 * Run: node test/x-collector-health-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  AUTH_ERROR,
  STALE_WARNING,
  assessXSession,
  buildCollectMetrics,
  newestPostedAt,
  assessTimelineFreshness,
  buildCollectorHealth,
  formatCollectHealthLine,
  parseCollectHealthFromOutput,
  collectDetailFromHealth,
} = require("../lib/x-collector-health");
const {
  buildMorningHealthReport,
  formatMorningPipelineSummary,
  parseStageItemCount,
  saveMorningHealthReport,
  loadLatestMorningHealthReport,
  collectorHealthForDashboard,
} = require("../lib/morning-health");
const { runMorning } = require("../scripts/morning");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makePage(opts = {}) {
  const url = opts.url || "https://x.com/home";
  const probe = opts.probe || {
    hasArticles: true,
    loginHints: false,
    homeChrome: true,
  };
  return {
    url: () => url,
    evaluate: async () => probe,
    waitForSelector: async () => {
      if (opts.waitFail) throw new Error("timeout");
      return true;
    },
  };
}

async function main() {
  // --- login OK continues ---
  {
    const page = makePage({
      url: "https://x.com/home",
      probe: { hasArticles: true, loginHints: false, homeChrome: true },
    });
    const session = await assessXSession(page);
    assert.strictEqual(session.authenticated, true);
    assert.strictEqual(session.timelineAvailable, true);
    assert.strictEqual(session.error, null);
    console.log("CH001 login-ok PASS");
  }

  // --- logout / login URL → X_AUTH_REQUIRED ---
  {
    const page = makePage({
      url: "https://x.com/i/flow/login",
      probe: { hasArticles: false, loginHints: true, homeChrome: false },
    });
    const session = await assessXSession(page);
    assert.strictEqual(session.authenticated, false);
    assert.strictEqual(session.error, AUTH_ERROR);
    console.log("CH001 logout-url PASS");
  }

  // --- login UI without articles ---
  {
    const page = makePage({
      url: "https://x.com/home",
      probe: { hasArticles: false, loginHints: true, homeChrome: false },
      waitFail: true,
    });
    const session = await assessXSession(page, { waitTimeoutMs: 10 });
    assert.strictEqual(session.authenticated, false);
    assert.strictEqual(session.error, AUTH_ERROR);
    console.log("CH001 login-ui PASS");
  }

  // --- newPosts=0 alone is not failed ---
  {
    const collect = buildCollectMetrics({
      fetchedFromScreen: 20,
      newPosts: 0,
      duplicateUrlsSkipped: 20,
      totalStored: 600,
      missingPostedAt: 0,
      newestPostAt: new Date().toISOString(),
    });
    const freshness = assessTimelineFreshness(
      collect.newestPostAt,
      new Date(),
      24 * 60 * 60 * 1000
    );
    const health = buildCollectorHealth({
      authenticated: true,
      timelineAvailable: true,
      collect,
      warnings: freshness.warnings,
    });
    assert.strictEqual(health.status, "healthy");
    assert.strictEqual(health.newPosts, 0);
    assert.ok(health.authenticated);
    console.log("CH001 zero-new-ok PASS");
  }

  // --- stale → warning only ---
  {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const freshness = assessTimelineFreshness(
      old,
      new Date(),
      24 * 60 * 60 * 1000
    );
    assert.ok(freshness.warnings.includes(STALE_WARNING));
    const health = buildCollectorHealth({
      authenticated: true,
      timelineAvailable: true,
      collect: buildCollectMetrics({
        fetchedFromScreen: 5,
        newPosts: 0,
        totalStored: 100,
        newestPostAt: old,
      }),
      warnings: freshness.warnings,
    });
    assert.strictEqual(health.status, "warning");
    assert.ok(health.warnings.includes(STALE_WARNING));
    console.log("CH001 stale-warning PASS");
  }

  // --- history stores collectorHealth; counts.collect kept ---
  {
    const health = buildCollectorHealth({
      authenticated: true,
      timelineAvailable: true,
      collect: {
        fetchedFromScreen: 35,
        newPosts: 34,
        duplicateUrlsSkipped: 1,
        totalStored: 638,
        missingPostedAt: 5,
        newestPostAt: "2026-08-12T01:00:00.000Z",
      },
    });
    const report = buildMorningHealthReport({
      startedAt: "2026-08-12T01:00:00.000Z",
      finishedAt: "2026-08-12T01:05:00.000Z",
      status: "SUCCESS",
      stages: [
        {
          id: "collect",
          label: "Collect",
          ok: true,
          itemCount: 638,
          collectorHealth: health,
          collect: collectDetailFromHealth(health),
        },
      ],
      publish: {
        ok: true,
        committed: true,
        pushed: true,
        pagesPublished: true,
      },
    });
    assert.strictEqual(report.counts.collect, 638);
    assert.ok(report.collect);
    assert.strictEqual(report.collect.newPosts, 34);
    assert.strictEqual(report.collect.fetchedFromScreen, 35);
    assert.strictEqual(report.collectorHealth.status, "healthy");
    assert.strictEqual(report.collectorHealth.authenticated, true);

    const summary = formatMorningPipelineSummary(report, "hist.json");
    assert.ok(summary.includes("X Collector"));
    assert.ok(summary.includes("Login: OK"));
    assert.ok(summary.includes("Fetched: 35"));
    assert.ok(summary.includes("New: 34"));
    assert.ok(summary.includes("Total: 638"));
    assert.ok(summary.includes("Freshness: OK"));
    console.log("CH001 history-health PASS");
  }

  // --- auth failure history ---
  {
    const report = buildMorningHealthReport({
      startedAt: "2026-08-12T01:00:00.000Z",
      finishedAt: "2026-08-12T01:00:05.000Z",
      status: "FAILED",
      stages: [
        {
          id: "collect",
          label: "Collect",
          ok: false,
          itemCount: null,
          collectorHealth: buildCollectorHealth({
            authenticated: false,
            timelineAvailable: false,
            status: "failed",
            error: AUTH_ERROR,
          }),
        },
      ],
      failure: {
        stage: "Collect",
        error: "Collect failed: X_AUTH_REQUIRED",
        stack: null,
      },
    });
    assert.strictEqual(report.collectorHealth.status, "failed");
    assert.strictEqual(report.collectorHealth.error, AUTH_ERROR);
    const summary = formatMorningPipelineSummary(report, null);
    assert.ok(summary.includes("Login: FAILED"));
    assert.ok(summary.includes("X_AUTH_REQUIRED"));
    console.log("CH001 auth-fail-history PASS");
  }

  // --- parse health line + stage item count ---
  {
    const health = buildCollectorHealth({
      authenticated: true,
      timelineAvailable: true,
      collect: {
        fetchedFromScreen: 35,
        newPosts: 34,
        totalStored: 638,
        newestPostAt: "2026-08-12T01:00:00.000Z",
      },
    });
    const line = formatCollectHealthLine(health);
    const out = `Total posts after save: 638\n${line}\n`;
    assert.strictEqual(parseStageItemCount("collect", out), 638);
    const parsed = parseCollectHealthFromOutput(out);
    assert.strictEqual(parsed.totalStored, 638);
    assert.strictEqual(parsed.newPosts, 34);
    console.log("CH001 parse-line PASS");
  }

  // --- logout does not continue morning after collect ---
  {
    const root = tmpDir("ch001-auth-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    const healthLib = path.join(__dirname, "..", "lib", "x-collector-health.js");
    fs.writeFileSync(
      path.join(root, "connect.js"),
      `
const { buildCollectorHealth, formatCollectHealthLine, AUTH_ERROR } = require(${JSON.stringify(
        healthLib
      )});
const health = buildCollectorHealth({
  authenticated: false,
  timelineAvailable: false,
  status: "failed",
  error: AUTH_ERROR,
});
console.error(formatCollectHealthLine(health));
console.error("ERROR: " + AUTH_ERROR);
process.exit(1);
`,
      "utf8"
    );
    fs.mkdirSync(path.join(root, "output"), { recursive: true });
    const timelinePath = path.join(root, "output", "timeline.json");
    fs.writeFileSync(
      timelinePath,
      JSON.stringify([
        {
          url: "https://x.com/a/status/1",
          postedAt: "2020-01-01T00:00:00.000Z",
        },
      ]),
      "utf8"
    );
    const before = fs.readFileSync(timelinePath, "utf8");

    let threw = null;
    try {
      runMorning(
        {
          help: false,
          skipCollect: false,
          // Keep AI/reader off the path after collect; do not set skipAi
          // (that requires timeline_enriched.json before any steps run).
          skipAi: false,
          skipReader: true,
          fromEnriched: false,
          open: false,
          readerArgs: [],
        },
        {
          rootDir: root,
          log: () => {},
          spawn: (cmd, args, opts) =>
            spawnSync(cmd, args, {
              cwd: opts.cwd || root,
              encoding: "utf8",
              env: opts.env || process.env,
            }),
        }
      );
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, "expected collect failure");
    assert.ok(
      threw.code === AUTH_ERROR || /X_AUTH_REQUIRED/.test(threw.message)
    );
    assert.ok(Array.isArray(threw.stages));
    assert.strictEqual(threw.stages[0].ok, false);
    assert.ok(threw.collectorHealth);
    assert.strictEqual(threw.collectorHealth.error, AUTH_ERROR);
    assert.strictEqual(fs.readFileSync(timelinePath, "utf8"), before);
    assert.ok(!threw.stages.some((s) => s.id === "analyze"));
    console.log("CH001 no-continue-on-auth PASS");
  }

  // --- dashboard helper + load latest ---
  {
    const root = tmpDir("ch001-dash-");
    const health = buildCollectorHealth({
      authenticated: true,
      timelineAvailable: true,
      collect: {
        fetchedFromScreen: 10,
        newPosts: 3,
        totalStored: 50,
        newestPostAt: "2026-08-12T02:00:00.000Z",
      },
    });
    const report = buildMorningHealthReport({
      startedAt: "2026-08-12T02:00:00.000Z",
      finishedAt: "2026-08-12T02:01:00.000Z",
      status: "SUCCESS",
      stages: [
        {
          id: "collect",
          ok: true,
          itemCount: 50,
          collectorHealth: health,
        },
      ],
      publish: {
        ok: true,
        committed: false,
        pushed: false,
        pagesPublished: false,
      },
    });
    saveMorningHealthReport(root, report, {
      now: () => new Date(2026, 7, 12, 11, 0, 0),
    });
    const loaded = loadLatestMorningHealthReport(root);
    assert.ok(loaded);
    assert.strictEqual(loaded.collectorHealth.newPosts, 3);
    const dash = collectorHealthForDashboard(loaded);
    assert.strictEqual(dash.xLogin, "OK");
    assert.strictEqual(dash.newPosts, 3);
    assert.strictEqual(dash.status, "healthy");
    assert.strictEqual(dash.latestPost, "2026-08-12T02:00:00.000Z");
    console.log("CH001 dashboard-shape PASS");
  }

  // --- newestPostedAt helper ---
  {
    assert.strictEqual(
      newestPostedAt([
        { postedAt: "2026-01-01T00:00:00.000Z" },
        { postedAt: "2026-08-01T00:00:00.000Z" },
        { postedAt: "" },
      ]),
      "2026-08-01T00:00:00.000Z"
    );
    console.log("CH001 newest PASS");
  }

  // --- legacy report without collectorHealth still builds ---
  {
    const report = buildMorningHealthReport({
      startedAt: "2026-07-24T07:00:00.000Z",
      finishedAt: "2026-07-24T07:04:12.000Z",
      status: "SUCCESS",
      stages: [
        { id: "collect", ok: true, itemCount: 247 },
      ],
      publish: { ok: true, committed: true, pushed: true, pagesPublished: true },
    });
    assert.strictEqual(report.counts.collect, 247);
    assert.strictEqual(report.collect.totalStored, 247);
    assert.strictEqual(report.collectorHealth, null);
    const summary = formatMorningPipelineSummary(report, "x.json");
    assert.ok(summary.includes("247 items"));
    console.log("CH001 legacy-compat PASS");
  }

  console.log("x-collector-health-test: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
