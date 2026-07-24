/**
 * EP-034 — Usage Dashboard tests (no OpenAI / no Morning).
 * Run: node test/usage-dashboard-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildMorningHistoryEntry } = require("../lib/api-usage-history");
const {
  formatTokenCount,
  formatDashboardCost,
  selectLastNRuns,
  filterEntriesForLocalToday,
  summarizeWithAverages,
  buildUsageDashboard,
  renderUsageDashboard,
} = require("../lib/usage-dashboard");
const { buildDigestReader } = require("../lib/digest-reader");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function entryAt(localY, localM, localD, hour, usage) {
  const finished = new Date(localY, localM - 1, localD, hour, 0, 0, 0);
  const started = new Date(localY, localM - 1, localD, hour - 1, 0, 0, 0);
  return buildMorningHistoryEntry({
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    model: "gpt-5-mini",
    analyze: {
      requests: usage.requests,
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.input + usage.output,
    },
    enrich: {
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  });
}

{
  assert.strictEqual(formatTokenCount(12345), "12,345");
  assert.strictEqual(formatTokenCount(0), "0");
  assert.strictEqual(formatDashboardCost(0.1166855), "$0.1167");
  assert.strictEqual(formatDashboardCost(0), "$0.0000");
  console.log("format PASS");
}

{
  const dash = buildUsageDashboard([], { available: false });
  assert.strictEqual(dash.available, false);
  const html = renderUsageDashboard(dash);
  assert.ok(html.includes("AI Usage Dashboard"));
  assert.ok(html.includes("No usage history available."));
  assert.ok(!html.includes("Today's Run"));
  console.log("history missing PASS");
}

{
  const now = new Date(2026, 6, 23, 16, 0, 0);
  const today = entryAt(2026, 7, 23, 10, {
    requests: 2,
    input: 1000,
    output: 500,
  });
  const dash = buildUsageDashboard([today], { now, available: true });
  assert.strictEqual(dash.available, true);
  assert.strictEqual(dash.today.empty, false);
  assert.strictEqual(dash.today.runs, 1);
  assert.strictEqual(dash.today.model, "gpt-5-mini");
  assert.strictEqual(dash.today.requests, 2);
  assert.strictEqual(dash.today.inputTokens, 1000);
  assert.strictEqual(dash.today.outputTokens, 500);
  assert.ok(dash.today.estimatedCostUsd.total > 0);
  const html = renderUsageDashboard(dash);
  assert.ok(html.includes("Today's Run"));
  assert.ok(html.includes("gpt-5-mini"));
  assert.ok(html.includes("1,000") || html.includes("1000"));
  assert.ok(!html.includes("No usage today."));
  console.log("today 1 run PASS");
}

{
  const now = new Date(2026, 6, 23, 16, 0, 0);
  const yesterday = entryAt(2026, 7, 22, 10, {
    requests: 5,
    input: 2000,
    output: 1000,
  });
  const dash = buildUsageDashboard([yesterday], { now, available: true });
  assert.strictEqual(dash.today.empty, true);
  assert.strictEqual(dash.today.runs, 0);
  assert.strictEqual(dash.allTime.runs, 1);
  const html = renderUsageDashboard(dash);
  assert.ok(html.includes("No usage today."));
  assert.ok(html.includes("Last 7 Runs"));
  assert.ok(html.includes("All Time"));
  console.log("today 0 runs PASS");
}

{
  const now = new Date(2026, 6, 23, 16, 0, 0);
  const seven = [];
  for (let i = 0; i < 7; i++) {
    seven.push(
      entryAt(2026, 7, 17 + i, 10, {
        requests: 10,
        input: 1000,
        output: 500,
      })
    );
  }
  const dash = buildUsageDashboard(seven, { now, available: true });
  assert.strictEqual(dash.last7.runs, 7);
  assert.strictEqual(dash.last7.requests, 70);
  assert.strictEqual(dash.last7.inputTokens, 7000);
  assert.strictEqual(dash.last7.outputTokens, 3500);
  assert.strictEqual(dash.last7.totalTokens, 10500);
  assert.ok(Math.abs(dash.last7.averageTokensPerRun - 1500) < 1e-9);
  assert.ok(dash.last7.averageCostPerRun > 0);
  console.log("last 7 aggregate PASS");
}

{
  const now = new Date(2026, 6, 23, 16, 0, 0);
  const twenty = [];
  for (let day = 1; day <= 20; day++) {
    twenty.push(
      entryAt(2026, 7, day, 10, {
        requests: 1,
        input: 100,
        output: 50,
      })
    );
  }
  const last7 = selectLastNRuns(twenty, 7);
  assert.strictEqual(last7.length, 7);
  assert.strictEqual(last7[0].finishedAt >= last7[6].finishedAt, true);

  const dash = buildUsageDashboard(twenty, { now, available: true });
  assert.strictEqual(dash.last7.runs, 7);
  assert.strictEqual(dash.allTime.runs, 20);
  assert.strictEqual(dash.allTime.requests, 20);
  assert.strictEqual(dash.allTime.inputTokens, 2000);
  assert.strictEqual(dash.allTime.outputTokens, 1000);
  assert.strictEqual(dash.allTime.totalTokens, 3000);
  assert.ok(Math.abs(dash.allTime.averageTokensPerRun - 150) < 1e-9);
  assert.ok(
    Math.abs(
      dash.allTime.averageCostPerRun - dash.allTime.estimatedCostUsd.total / 20
    ) < 1e-12
  );

  const original = JSON.parse(JSON.stringify(twenty));
  buildUsageDashboard(twenty, { now, available: true });
  selectLastNRuns(twenty, 7);
  filterEntriesForLocalToday(twenty, now);
  assert.deepStrictEqual(twenty, original);

  const a = buildUsageDashboard(twenty, { now, available: true });
  const b = buildUsageDashboard(twenty, { now, available: true });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(renderUsageDashboard(a), renderUsageDashboard(b));
  console.log("20 entries + averages + determinism PASS");
}

{
  const summary = summarizeWithAverages([]);
  assert.deepStrictEqual(summary.estimatedCostUsd, {
    input: 0,
    output: 0,
    total: 0,
  });
  assert.strictEqual(summary.averageCostPerRun, 0);
  assert.strictEqual(summary.averageTokensPerRun, 0);
  console.log("empty averages PASS");
}

{
  const root = tmpDir("usage-dash-reader-");
  const result = buildDigestReader({
    rootDir: root,
    posts: [],
    outputDir: path.join(root, "out"),
    usageEntries: [],
    now: new Date(2026, 6, 23, 12, 0, 0),
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("AI Usage Dashboard"));
  assert.ok(html.includes("No usage today."));
  assert.ok(html.includes("Last 7 Runs"));
  assert.ok(html.indexOf("AI Usage Dashboard") > html.indexOf("Morning Brief"));
  console.log("reader empty entries PASS");
}

{
  const root = tmpDir("usage-dash-reader-missing-");
  const result = buildDigestReader({
    rootDir: root,
    posts: [],
    outputDir: path.join(root, "out"),
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("No usage history available."));
  console.log("reader missing history PASS");
}

{
  const root = tmpDir("usage-dash-reader-today-");
  const now = new Date(2026, 6, 23, 16, 0, 0);
  const today = entryAt(2026, 7, 23, 11, {
    requests: 99,
    input: 78814,
    output: 48491,
  });
  const result = buildDigestReader({
    rootDir: root,
    posts: [],
    outputDir: path.join(root, "out"),
    usageEntries: [today],
    now,
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("AI Usage Dashboard"));
  assert.ok(html.includes("Today's Run"));
  assert.ok(html.includes("78,814"));
  assert.ok(html.includes("48,491"));
  assert.ok(html.includes("$0.1167"));
  assert.ok(html.includes("gpt-5-mini"));
  const css = fs.readFileSync(result.cssPath, "utf8");
  assert.ok(css.includes("usage-dash"));
  console.log("reader display PASS");
}

console.log("usage-dashboard-test: ALL PASS");
