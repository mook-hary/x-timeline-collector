/**
 * EP-048 — Morning health report.
 * Run: node test/morning-health-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  HISTORY_DIR_REL,
  formatHistoryFilename,
  formatDurationMs,
  parseStageItemCount,
  buildMorningHealthReport,
  saveMorningHealthReport,
  publishResultFromRunner,
  formatMorningPipelineSummary,
} = require("../lib/morning-health");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- filename ---
{
  const local = new Date(2026, 6, 24, 7, 12, 33);
  assert.strictEqual(formatHistoryFilename(local), "2026-07-24-071233.json");
  console.log("EP048 filename PASS");
}

// --- duration ---
{
  assert.strictEqual(formatDurationMs(252000), "4m 12s");
  assert.strictEqual(formatDurationMs(45000), "45s");
  assert.strictEqual(formatDurationMs(3723000), "1h 2m 3s");
  assert.strictEqual(formatDurationMs(0), "0s");
  console.log("EP048 duration PASS");
}

// --- parse counts ---
{
  assert.strictEqual(
    parseStageItemCount(
      "collect",
      "Total posts after save: 247\n今回新しく追加した件数: 12\n"
    ),
    247
  );
  assert.strictEqual(
    parseStageItemCount("analyze", "分析対象: 1200 件\n"),
    1200
  );
  assert.strictEqual(
    parseStageItemCount("analyze-ai", "今回処理する件数: 50\n"),
    50
  );
  assert.strictEqual(
    parseStageItemCount("enrich", "今回処理する件数: 50\n"),
    50
  );
  console.log("EP048 parse-counts PASS");
}

// --- report + save ---
{
  const root = tmpDir("morning-health-");
  const startedAt = "2026-07-24T07:00:00.000Z";
  const finishedAt = "2026-07-24T07:04:12.000Z";
  const report = buildMorningHealthReport({
    startedAt,
    finishedAt,
    status: "SUCCESS",
    stages: [
      {
        id: "collect",
        label: "Collect",
        startedAt,
        finishedAt: "2026-07-24T07:01:00.000Z",
        ok: true,
        itemCount: 247,
      },
      {
        id: "analyze-ai",
        label: "AI Analyze",
        startedAt: "2026-07-24T07:02:00.000Z",
        finishedAt: "2026-07-24T07:03:00.000Z",
        ok: true,
        itemCount: 50,
      },
      {
        id: "enrich",
        label: "AI Enrich",
        startedAt: "2026-07-24T07:03:00.000Z",
        finishedAt: "2026-07-24T07:04:00.000Z",
        ok: true,
        itemCount: 50,
      },
      {
        id: "publish",
        label: "Publish Digest Reader",
        startedAt: "2026-07-24T07:04:00.000Z",
        finishedAt,
        ok: true,
        itemCount: null,
      },
    ],
    publish: {
      ok: true,
      committed: true,
      pushed: true,
      pagesPublished: true,
    },
  });
  assert.strictEqual(report.status, "SUCCESS");
  assert.strictEqual(report.durationMs, 252000);
  assert.strictEqual(report.counts.collect, 247);
  assert.strictEqual(report.counts.analyzeAi, 50);
  assert.strictEqual(report.failure, null);

  const saved = saveMorningHealthReport(root, report, {
    now: () => new Date(2026, 6, 24, 7, 12, 33),
  });
  assert.ok(saved.relativePath.startsWith(HISTORY_DIR_REL));
  assert.ok(saved.relativePath.endsWith("2026-07-24-071233.json"));
  assert.ok(fs.existsSync(saved.path));
  const loaded = JSON.parse(fs.readFileSync(saved.path, "utf8"));
  assert.strictEqual(loaded.status, "SUCCESS");
  assert.strictEqual(loaded.publish.pushed, true);

  const summary = formatMorningPipelineSummary(report, saved.relativePath);
  assert.ok(summary.includes("Morning Pipeline Summary"));
  assert.ok(summary.includes("Status: SUCCESS"));
  assert.ok(summary.includes("4m 12s"));
  assert.ok(summary.includes("247 items"));
  assert.ok(summary.includes("AI Analyze:"));
  assert.ok(summary.includes("Publish:"));
  assert.ok(summary.includes("Success"));
  assert.ok(summary.includes(saved.relativePath));
  console.log("EP048 report-save PASS");
}

// --- failure report ---
{
  const report = buildMorningHealthReport({
    startedAt: "2026-07-24T07:00:00.000Z",
    finishedAt: "2026-07-24T07:00:05.000Z",
    status: "FAILED",
    stages: [
      {
        id: "collect",
        label: "Collect",
        startedAt: "2026-07-24T07:00:00.000Z",
        finishedAt: "2026-07-24T07:00:05.000Z",
        ok: false,
        itemCount: null,
      },
    ],
    failure: {
      stage: "Collect",
      error: "boom",
      stack: "Error: boom\n    at x",
    },
  });
  assert.strictEqual(report.status, "FAILED");
  assert.strictEqual(report.failure.stage, "Collect");
  assert.strictEqual(report.failure.error, "boom");
  assert.ok(report.failure.stack.includes("Error: boom"));
  console.log("EP048 failure PASS");
}

// --- publishResultFromRunner ---
{
  assert.deepStrictEqual(
    publishResultFromRunner({
      ok: true,
      committed: true,
      skippedPush: false,
    }),
    {
      ok: true,
      committed: true,
      pushed: true,
      pagesPublished: true,
    }
  );
  assert.deepStrictEqual(
    publishResultFromRunner({
      ok: true,
      committed: false,
      skippedPush: true,
    }),
    {
      ok: true,
      committed: false,
      pushed: false,
      pagesPublished: false,
    }
  );
  console.log("EP048 publish-flags PASS");
}

console.log("morning-health-test: all PASS");
