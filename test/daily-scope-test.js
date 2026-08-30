/**
 * DAILY-COLLECT-SCOPE-001 — Archive vs Daily Editorial Scope.
 * No real Chrome / X. Run: node test/daily-scope-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildDailyScope,
  saveDailyScope,
  readEditorialPosts,
  pickDailyScope,
  DAILY_SCOPE_REL,
  morningAnalyzeArgs,
} = require("../lib/daily-scope");
const { mergeWithExisting } = require("../connect");
const { parseAnalyzeArgs } = require("../analyze");
const {
  buildMorningHealthReport,
  formatMorningPipelineSummary,
} = require("../lib/morning-health");
const { buildMorningPlan, parseMorningArgs } = require("../scripts/morning");
const { buildDigestReader } = require("../lib/digest-reader");
const { mergeDigestConfig, DEFAULT_DIGEST_CONFIG } = require("../lib/digest-core");
const {
  saveTodayPicksHistory,
  loadPreviousTodayPicks,
} = require("../lib/today-picks-history");
const { selectTodayPicksDetailed } = require("../lib/today-picks");
const { DEFAULT_COLLECT_TIMEOUT_MS } = require("../lib/morning-collect-policy");
const { MAX_SCROLL_RECOVERY } = require("../lib/collect-scroll");
const { MAX_CHROME_RESTARTS } = require("../lib/collector-preflight");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function post(id, extra = {}) {
  return {
    authorName: `A${id}`,
    authorHandle: `@a${id}`,
    postedAt: extra.postedAt || "2026-08-20T01:00:00.000Z",
    text: extra.text || `text ${id}`,
    url: extra.url || `https://x.com/a/status/${id}`,
  };
}

function enriched(id, importance, extra = {}) {
  return {
    ...post(id, extra),
    finalAnalysis: {
      category: extra.category || "AI",
      tags: extra.tags || [`t${id}`],
    },
    enrichment: {
      importance,
      summary: extra.summary || `固有要約 ${id} の十分な長さです`,
      reason: "test",
      tags: extra.tags || [`t${id}`],
    },
  };
}

function main() {
  assert.strictEqual(DEFAULT_COLLECT_TIMEOUT_MS, 15 * 60 * 1000);
  assert.strictEqual(MAX_SCROLL_RECOVERY, 1);
  assert.strictEqual(MAX_CHROME_RESTARTS, 1);
  console.log("daily-scope constants PASS");

  {
    const existing = [];
    for (let i = 1; i <= 100; i++) existing.push(post(`old-${i}`));
    const fetched = [];
    for (let i = 1; i <= 12; i++) fetched.push(post(`new-${i}`));
    const merged = mergeWithExisting(
      existing,
      fetched,
      "2026-08-30T03:00:00.000Z"
    );
    assert.strictEqual(merged.addedCount, 12);
    assert.strictEqual(merged.newPosts.length, 12);
    assert.strictEqual(merged.merged.length, 112);

    const root = tmpDir("daily-scope-a-");
    const saved = saveDailyScope(
      root,
      buildDailyScope({
        collectedAt: "2026-08-30T03:00:00.000Z",
        fetchedFromScreen: 12,
        newPosts: 12,
        duplicateUrlsSkipped: 0,
        totalStored: merged.merged.length,
        posts: merged.newPosts,
      })
    );
    assert.ok(fs.existsSync(saved.path));
    const loaded = readEditorialPosts(saved.path, "daily-scope");
    assert.strictEqual(loaded.length, 12);
    const parsed = parseAnalyzeArgs([
      "--input",
      DAILY_SCOPE_REL,
      "--output",
      "output/daily-analyzed.json",
    ]);
    assert.strictEqual(parsed.input, DAILY_SCOPE_REL);
    assert.deepStrictEqual(morningAnalyzeArgs(), [
      "--input",
      DAILY_SCOPE_REL,
      "--output",
      "output/daily-analyzed.json",
    ]);
    const report = buildMorningHealthReport({
      startedAt: "2026-08-30T03:00:00.000Z",
      finishedAt: "2026-08-30T03:05:00.000Z",
      status: "SUCCESS",
      collect: {
        fetchedFromScreen: 12,
        newPosts: 12,
        duplicateUrlsSkipped: 0,
        totalStored: 112,
      },
      stages: [
        { id: "collect", ok: true, itemCount: 112 },
        { id: "analyze", ok: true, itemCount: 12 },
      ],
      publish: { ok: true, committed: true, pushed: true, pagesPublished: true },
    });
    assert.strictEqual(report.dailyScope.itemCount, 12);
    assert.strictEqual(report.archiveTotal, 112);
    assert.strictEqual(report.counts.analyze, 12);
    assert.strictEqual(report.collect.totalStored, 112);
    console.log("daily-scope case A PASS");
  }

  {
    const existing = [];
    for (let i = 1; i <= 15; i++) existing.push(post(`dup-${i}`));
    const fetched = [
      ...existing.slice(0, 15).map((p) => ({ ...p })),
      post("only-1"),
      post("only-2"),
      post("only-3"),
      post("only-4"),
      post("only-5"),
    ];
    const merged = mergeWithExisting(existing, fetched, "2026-08-30T03:00:00.000Z");
    assert.strictEqual(merged.fetchedCount, 20);
    assert.strictEqual(merged.addedCount, 5);
    assert.strictEqual(merged.duplicateCount, 15);
    const scope = buildDailyScope({
      fetchedFromScreen: merged.fetchedCount,
      newPosts: merged.addedCount,
      duplicateUrlsSkipped: merged.duplicateCount,
      totalStored: existing.length + merged.addedCount,
      posts: merged.newPosts,
    });
    assert.strictEqual(scope.itemCount, 5);
    assert.strictEqual(scope.posts.length, 5);
    console.log("daily-scope case B PASS");
  }

  {
    const existing = [post("old-1"), post("old-2")];
    const fetched = [post("old-1"), post("old-2")];
    const merged = mergeWithExisting(existing, fetched, "2026-08-30T03:00:00.000Z");
    assert.strictEqual(merged.addedCount, 0);
    const root = tmpDir("daily-scope-c-");
    saveDailyScope(
      root,
      buildDailyScope({
        collectedAt: "2026-08-30T03:00:00.000Z",
        fetchedFromScreen: 2,
        newPosts: 0,
        duplicateUrlsSkipped: 2,
        totalStored: 2,
        posts: merged.newPosts,
      })
    );
    const posts = readEditorialPosts(
      path.join(root, DAILY_SCOPE_REL),
      "daily-scope"
    );
    assert.strictEqual(posts.length, 0);
    const report = buildMorningHealthReport({
      startedAt: "2026-08-30T03:00:00.000Z",
      finishedAt: "2026-08-30T03:01:00.000Z",
      status: "SUCCESS",
      collect: {
        fetchedFromScreen: 2,
        newPosts: 0,
        duplicateUrlsSkipped: 2,
        totalStored: 2,
      },
      stages: [
        { id: "collect", ok: true, itemCount: 2 },
        { id: "analyze", ok: true, itemCount: 0 },
      ],
      publish: { ok: true, committed: false, pushed: false, pagesPublished: false },
    });
    assert.strictEqual(report.status, "SUCCESS");
    assert.strictEqual(report.dailyScope.itemCount, 0);
    assert.strictEqual(report.collect.newPosts, 0);

    const readerRoot = tmpDir("daily-scope-c-reader-");
    const reader = buildDigestReader({
      rootDir: readerRoot,
      posts: [],
      config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    });
    assert.strictEqual((reader.digest.todaysPicks || []).length, 0);
    const emptyFeed = JSON.parse(fs.readFileSync(reader.newsFeedPath, "utf8"));
    assert.strictEqual(emptyFeed.schemaVersion, 1);
    assert.strictEqual(emptyFeed.scope.itemCount, 0);
    assert.deepStrictEqual(emptyFeed.items, []);
    console.log("daily-scope case C PASS");
  }

  {
    const archiveOnly = enriched("archive-5", 5, {
      url: "https://x.com/old/status/999",
      text: "昨日の超重要投稿 https://news.example.com/old-big",
      summary: "昨日の超重要投稿の要約テキストです",
      tags: ["old-big"],
    });
    const daily = [
      enriched("today-1", 3, {
        url: "https://x.com/n/status/1",
        text: "今日の新規投稿 https://news.example.com/today-1",
        summary: "今日の新規投稿の要約テキストです",
        tags: ["today-1"],
      }),
    ];
    const root = tmpDir("daily-scope-d-");
    const reader = buildDigestReader({
      rootDir: root,
      posts: daily,
      config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    });
    const urls = (reader.digest.todaysPicks || []).map(
      (p) => (p && (p.url || (p.post && p.post.url))) || ""
    );
    assert.ok(!urls.includes(archiveOnly.url));
    assert.ok(
      !JSON.stringify(reader.digest).includes("https://x.com/old/status/999")
    );
    console.log("daily-scope case D PASS");
  }

  {
    const root = tmpDir("daily-scope-e-");
    const yesterdayPost = enriched("y1", 5, {
      url: "https://x.com/y/status/1",
      text: "昨日のピック https://unique.example.com/y1",
      summary: "昨日のピック要約の十分な長さです",
      tags: ["y1"],
    });
    saveTodayPicksHistory(root, [yesterdayPost], {
      now: new Date(2026, 7, 29, 12, 0, 0),
    });
    const previous = loadPreviousTodayPicks(root, {
      now: new Date(2026, 7, 30, 12, 0, 0),
    });
    assert.ok(previous);
    assert.ok(Array.isArray(previous.picks));
    assert.ok(previous.picks.length >= 1);

    const todayPosts = [
      yesterdayPost,
      enriched("n1", 4, {
        url: "https://x.com/n/status/8",
        text: "今日の新しい話題 https://unique.example.com/n1",
        summary: "今日の新しい話題の要約テキストです",
        tags: ["n1"],
      }),
    ];
    const detailed = selectTodayPicksDetailed(todayPosts, 2, null, {
      previousPicks: previous.picks,
    });
    assert.ok(detailed.freshness && detailed.freshness.metrics);
    assert.ok(detailed.freshness.metrics.picksCount >= 1);
    console.log("daily-scope case E PASS");
  }

  {
    const existing = [post("keep-1"), post("keep-2")];
    const fetched = [post("fresh-1")];
    const merged = mergeWithExisting(
      existing,
      fetched,
      "2026-08-30T03:00:00.000Z"
    );
    assert.strictEqual(merged.merged.length, 3);
    assert.ok(merged.merged.some((p) => p.url === "https://x.com/a/status/keep-1"));
    assert.ok(merged.merged.some((p) => p.url === "https://x.com/a/status/fresh-1"));
    const root = tmpDir("daily-scope-f-");
    const archivePath = path.join(root, "output", "timeline.json");
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, `${JSON.stringify(merged.merged)}\n`, "utf8");
    saveDailyScope(
      root,
      buildDailyScope({
        posts: merged.newPosts,
        totalStored: merged.merged.length,
        newPosts: merged.addedCount,
      })
    );
    const archive = JSON.parse(fs.readFileSync(archivePath, "utf8"));
    const scope = readEditorialPosts(path.join(root, DAILY_SCOPE_REL), "scope");
    assert.strictEqual(archive.length, 3);
    assert.strictEqual(scope.length, 1);
    console.log("daily-scope case F PASS");
  }

  {
    const plan = buildMorningPlan(parseMorningArgs([]));
    assert.ok(plan.steps.find((s) => s.id === "analyze").args.includes(DAILY_SCOPE_REL));
    assert.ok(
      plan.steps
        .find((s) => s.id === "reader")
        .args.includes("output/daily-enriched.json")
    );
    const standalone = parseAnalyzeArgs([]);
    assert.strictEqual(standalone.input, null);
    assert.strictEqual(standalone.output, null);
    const summary = formatMorningPipelineSummary(
      buildMorningHealthReport({
        startedAt: "2026-08-30T03:00:00.000Z",
        finishedAt: "2026-08-30T03:02:00.000Z",
        status: "SUCCESS",
        collect: { newPosts: 31, totalStored: 1500, fetchedFromScreen: 40 },
        stages: [{ id: "analyze", ok: true, itemCount: 31 }],
        publish: { ok: true, committed: true, pushed: true, pagesPublished: true },
      }),
      "hist.json"
    );
    assert.ok(summary.includes("Daily Scope:"));
    assert.ok(summary.includes("31 items"));
    const picked = pickDailyScope({
      collect: { newPosts: 31, totalStored: 1500 },
    });
    assert.strictEqual(picked.itemCount, 31);
    assert.strictEqual(picked.archiveTotal, 1500);
    console.log("daily-scope morning wiring PASS");
  }

  console.log("daily-scope-test: ALL PASS");
}

main();
