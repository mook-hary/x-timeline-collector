/**
 * Morning Publish SLA + collect policy + picks freshness.
 * Run: node test/morning-sla-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DEFAULT_SCHEDULE_HOUR,
  DEFAULT_PUBLISH_DEADLINE_HOUR,
  DEADLINE_WARNING,
  resolveMorningSlaWindow,
  evaluatePublishDeadline,
  atLocalTime,
} = require("../lib/morning-deadline");
const {
  detectSlowStageWarnings,
  SLOW_STAGE_THRESHOLDS_MS,
} = require("../lib/morning-stage-thresholds");
const {
  shouldRetryCollect,
  isCollectAuthFailure,
  isCollectTimeout,
  isCollectCdpFailure,
  COLLECT_TIMEOUT_CODE,
  DEFAULT_COLLECT_TIMEOUT_MS,
} = require("../lib/morning-collect-policy");
const {
  buildMorningHealthReport,
  morningPublishForDashboard,
} = require("../lib/morning-health");
const { DEFAULT_HOUR } = require("../lib/morning-scheduler");
const {
  applyPreviousDayPenalties,
  computePicksFreshnessMetrics,
  isContinuationUpdate,
} = require("../lib/today-picks-freshness");
const {
  saveTodayPicksHistory,
  loadPreviousTodayPicks,
} = require("../lib/today-picks-history");
const { selectTodayPicksDetailed } = require("../lib/today-picks");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- scheduler default 03:00 ---
{
  assert.strictEqual(DEFAULT_HOUR, 3);
  assert.strictEqual(DEFAULT_SCHEDULE_HOUR, 3);
  assert.strictEqual(DEFAULT_PUBLISH_DEADLINE_HOUR, 7);
  console.log("SLA001 schedule-default PASS");
}

// --- deadline met / missed ---
{
  const base = new Date(2026, 7, 14, 3, 0, 0);
  const sla = resolveMorningSlaWindow({ now: base });
  assert.ok(sla.publishDeadline);
  const early = atLocalTime(base, 3, 12);
  const late = atLocalTime(base, 7, 1);
  assert.strictEqual(
    evaluatePublishDeadline(early, sla.publishDeadline).deadlineMet,
    true
  );
  const missed = evaluatePublishDeadline(late, sla.publishDeadline);
  assert.strictEqual(missed.deadlineMet, false);
  assert.strictEqual(missed.warning, DEADLINE_WARNING);

  const okReport = buildMorningHealthReport({
    startedAt: early.toISOString(),
    finishedAt: early.toISOString(),
    status: "SUCCESS",
    scheduledStartAt: sla.scheduledStartAt,
    publishDeadline: sla.publishDeadline,
    stages: [],
    publish: { ok: true, committed: true, pushed: true, pagesPublished: true },
  });
  assert.strictEqual(okReport.deadlineMet, true);
  assert.ok(!okReport.warnings.includes(DEADLINE_WARNING));

  const lateReport = buildMorningHealthReport({
    startedAt: base.toISOString(),
    finishedAt: late.toISOString(),
    status: "SUCCESS",
    scheduledStartAt: sla.scheduledStartAt,
    publishDeadline: sla.publishDeadline,
    stages: [],
    publish: { ok: true, committed: true, pushed: true, pagesPublished: true },
  });
  assert.strictEqual(lateReport.deadlineMet, false);
  assert.ok(lateReport.warnings.includes(DEADLINE_WARNING));
  assert.strictEqual(lateReport.status, "SUCCESS");
  console.log("SLA001 deadline PASS");
}

// --- slow stage warnings (no auto-stop) ---
{
  const warnings = detectSlowStageWarnings([
    { id: "collect", ok: true, durationMs: SLOW_STAGE_THRESHOLDS_MS.collect + 1 },
    { id: "enrich", ok: true, durationMs: 1000 },
  ]);
  assert.ok(warnings.includes("SLOW_STAGE_COLLECT"));
  assert.ok(!warnings.includes("SLOW_STAGE_ENRICH"));
  console.log("SLA001 slow-stage PASS");
}

// --- collect retry / auth / timeout ---
{
  const cdpFail = {
    status: 1,
    stdout: "",
    stderr: "Chrome への接続に失敗しました。\n接続先: http://127.0.0.1:9222\n",
  };
  assert.ok(isCollectCdpFailure(cdpFail));
  assert.ok(shouldRetryCollect(cdpFail, 0));
  assert.ok(!shouldRetryCollect(cdpFail, 1));

  const authFail = {
    status: 1,
    stdout: "",
    stderr: "ERROR: X_AUTH_REQUIRED\n",
  };
  assert.ok(isCollectAuthFailure(authFail));
  assert.ok(!shouldRetryCollect(authFail, 0));

  const timeout = {
    status: null,
    error: { code: "ETIMEDOUT", message: "Timed out" },
    stdout: "",
    stderr: "",
  };
  assert.ok(isCollectTimeout(timeout));
  assert.ok(!shouldRetryCollect(timeout, 0));
  assert.strictEqual(COLLECT_TIMEOUT_CODE, "COLLECT_TIMEOUT");
  assert.strictEqual(DEFAULT_COLLECT_TIMEOUT_MS, 15 * 60 * 1000);
  console.log("SLA001 collect-policy PASS");
}

// --- legacy history compatible (missing SLA fields) ---
{
  const legacy = morningPublishForDashboard({
    status: "SUCCESS",
    finishedAt: "2026-08-14T03:14:00.000Z",
    durationMs: 12000,
    stages: [{ id: "collect", label: "Collect", durationMs: 48000, ok: true }],
  });
  assert.strictEqual(legacy.deadline, "07:00");
  assert.ok(legacy.lastPublished);
  assert.strictEqual(legacy.deadlineMet, null);
  console.log("SLA001 legacy-compat PASS");
}

// --- previous-day picks penalty + continuation + metrics ---
{
  const article = "https://news.example.com/big-story";
  const yesterday = [
    {
      url: "https://x.com/a/status/1",
      linkedArticleKey: "link:news.example.com/big-story",
      topicKey: "tags:big-story",
      summary: "昨日の要約",
    },
  ];
  const ranked = [
    {
      post: {
        url: "https://x.com/a/status/1",
        text: `同じ ${article}`,
        enrichment: {
          summary: `同じ記事 ${article}`,
          importance: 5,
          tags: ["big-story"],
        },
        finalAnalysis: { category: "AI", tags: ["big-story"] },
      },
      editorialScore: 80,
      index: 0,
      stableId: "a",
    },
    {
      post: {
        url: "https://x.com/b/status/2",
        text: "全く新しい話題の本文です",
        enrichment: {
          summary: "全く新しい話題の要約テキストです。",
          importance: 4,
          tags: ["brand-new"],
        },
        finalAnalysis: { category: "AI", tags: ["brand-new"] },
      },
      editorialScore: 70,
      index: 1,
      stableId: "b",
    },
  ];
  const { ranked: demoted } = applyPreviousDayPenalties(ranked, yesterday);
  assert.ok(demoted[0].editorialScore < 80);
  assert.strictEqual(demoted[1].editorialScore, 70);

  const contPost = {
    url: "https://x.com/a/status/9",
    text: `続報: 本日追加発表あり ${article}`,
    enrichment: {
      summary: "続報: 本日の追加発表について。",
      importance: 5,
      tags: ["big-story"],
    },
    finalAnalysis: { category: "AI", tags: ["big-story"] },
  };
  assert.ok(
    isContinuationUpdate(contPost, {
      url: "https://x.com/a/status/1",
      linkedArticleKey: "link:news.example.com/big-story",
      summary: "昨日の要約",
    })
  );

  const metrics = computePicksFreshnessMetrics(
    [ranked[0].post, ranked[1].post],
    yesterday
  );
  assert.strictEqual(metrics.picksCount, 2);
  assert.ok(metrics.repeated >= 1);
  assert.ok(metrics.newVsYesterday >= 1);
  assert.ok(typeof metrics.repeatRate === "number");
  console.log("SLA001 picks-freshness PASS");
}

// --- selectTodayPicksDetailed uses previous picks ---
{
  const posts = [];
  for (let i = 0; i < 4; i++) {
    posts.push({
      url: `https://x.com/u/status/${100 + i}`,
      text: `本文 ${i} https://unique.example.com/p${i}`,
      postedAt: "2026-08-14T01:00:00.000Z",
      finalAnalysis: { category: "AI", tags: [`t${i}`] },
      enrichment: {
        importance: 5,
        summary: `固有要約 ${i} の十分な長さ`,
        reason: "理由",
        tags: [`t${i}`],
      },
      authorHandle: `@u${i}`,
    });
  }
  const previous = [
    {
      url: posts[0].url,
      linkedArticleKey: "link:unique.example.com/p0",
      topicKey: "tags:t0",
      summary: posts[0].enrichment.summary,
    },
  ];
  const { picks, freshness } = selectTodayPicksDetailed(posts, 3, null, {
    previousPicks: previous,
  });
  assert.ok(!picks.some((p) => p.url === posts[0].url) || picks.length === 3);
  // Prefer that demoted repeat is not first when peers exist.
  assert.notStrictEqual(picks[0].url, posts[0].url);
  assert.ok(freshness && freshness.metrics);
  assert.strictEqual(freshness.metrics.picksCount, picks.length);
  console.log("SLA001 picks-select PASS");
}

// --- history save / previous load ---
{
  const root = tmpDir("picks-hist-");
  const now = new Date(2026, 7, 14, 4, 0, 0);
  saveTodayPicksHistory(
    root,
    [{ url: "https://x.com/a/status/1", summary: "y", category: "AI" }],
    { now: new Date(2026, 7, 13, 4, 0, 0), date: "2026-08-13" }
  );
  const prev = loadPreviousTodayPicks(root, { now });
  assert.ok(prev);
  assert.strictEqual(prev.date, "2026-08-13");
  assert.strictEqual(prev.picks.length, 1);
  console.log("SLA001 picks-history PASS");
}

// --- dashboard DTO stages ---
{
  const dto = morningPublishForDashboard(
    {
      status: "SUCCESS",
      finishedAt: new Date(2026, 7, 14, 3, 12, 0).toISOString(),
      publishDeadline: new Date(2026, 7, 14, 7, 0, 0).toISOString(),
      deadlineMet: true,
      durationMs: 12 * 60 * 1000,
      stages: [
        { id: "collect", durationMs: 48000, ok: true },
        { id: "analyze-ai", durationMs: 4 * 60 * 1000, ok: true },
        { id: "enrich", durationMs: 7 * 60 * 1000, ok: true },
        { id: "publish", durationMs: 20000, ok: true },
      ],
      warnings: [],
    },
    { hour: 3, minute: 0 }
  );
  assert.strictEqual(dto.nextRun, "03:00");
  assert.strictEqual(dto.deadlineStatus, "met");
  assert.ok(dto.stages.length >= 4);
  assert.ok(dto.totalDuration.includes("m"));
  console.log("SLA001 dashboard PASS");
}

// --- runMorning: collect timeout fails; no further stages; refuse stale publish path ---
{
  const { runMorning, parseMorningArgs } = require("../scripts/morning");
  const root = tmpDir("morning-collect-to-");
  let spawnCalls = 0;
  const logs = [];
  try {
    runMorning(parseMorningArgs([]), {
      rootDir: root,
      log: (l) => logs.push(l),
      collectTimeoutMs: 50,
      collectRetryWaitMs: 0,
      sleep: () => {},
      ensureCollectorReady: () => ({
        status: "healthy",
        cdpAvailable: true,
        playwrightConnected: true,
        xHomeAvailable: true,
        chromeRestarted: false,
        attempts: 1,
      }),
      spawn: () => {
        spawnCalls += 1;
        return {
          status: null,
          error: { code: "ETIMEDOUT", message: "Timed out" },
          stdout: "",
          stderr: "",
        };
      },
    });
    assert.fail("expected throw");
  } catch (error) {
    assert.strictEqual(error.code, "COLLECT_TIMEOUT");
    assert.strictEqual(spawnCalls, 1);
    assert.ok(logs.some((l) => /COLLECT_TIMEOUT|timed out/i.test(l)));
  }
  console.log("SLA001 collect-timeout PASS");
}

// --- runMorning: CDP retry once then success; auth never retries ---
{
  const { runMorning, parseMorningArgs } = require("../scripts/morning");
  const root = tmpDir("morning-collect-retry-");
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "output", "daily-enriched.json"),
    "[]\n",
    "utf8"
  );

  let cdpCalls = 0;
  const cdpSpawn = (cmd, args) => {
    const script = String(args && args[0] ? args[0] : "");
    if (script.endsWith("connect.js")) {
      cdpCalls += 1;
      if (cdpCalls === 1) {
        return {
          status: 1,
          stdout: "",
          stderr: "Chrome への接続に失敗しました。\n接続先: http://127.0.0.1:9222\n",
        };
      }
      return {
        status: 0,
        stdout: "COLLECT_HEALTH_JSON:{\"authenticated\":true,\"status\":\"healthy\",\"totalStored\":1}\n",
        stderr: "",
      };
    }
    // skip remaining AI/reader by failing fast after collect in a dedicated skip-ai run
    return { status: 0, stdout: "", stderr: "" };
  };

  const result = runMorning(parseMorningArgs(["--skip-ai", "--skip-reader"]), {
    rootDir: root,
    log: () => {},
    collectRetryWaitMs: 0,
    sleep: () => {},
    ensureCollectorReady: () => ({
      status: "healthy",
      cdpAvailable: true,
      playwrightConnected: true,
      xHomeAvailable: true,
      chromeRestarted: false,
      attempts: 1,
    }),
    spawn: cdpSpawn,
    existsSync: (p) => fs.existsSync(p),
  });
  assert.ok(result.ok);
  assert.strictEqual(cdpCalls, 2);

  let authCalls = 0;
  try {
    runMorning(parseMorningArgs(["--skip-ai", "--skip-reader"]), {
      rootDir: root,
      log: () => {},
      collectRetryWaitMs: 0,
      sleep: () => {},
      ensureCollectorReady: () => ({
        status: "healthy",
        cdpAvailable: true,
        playwrightConnected: true,
        xHomeAvailable: true,
        chromeRestarted: false,
        attempts: 1,
      }),
      spawn: () => {
        authCalls += 1;
        return {
          status: 1,
          stdout: "",
          stderr: "ERROR: X_AUTH_REQUIRED\nCOLLECT_HEALTH_JSON:{\"authenticated\":false,\"status\":\"failed\",\"error\":\"X_AUTH_REQUIRED\"}\n",
        };
      },
    });
    assert.fail("expected auth throw");
  } catch (error) {
    assert.strictEqual(error.code, "X_AUTH_REQUIRED");
    assert.strictEqual(authCalls, 1);
  }
  console.log("SLA001 collect-retry-auth PASS");
}

console.log("morning-sla-test: ALL PASS");
