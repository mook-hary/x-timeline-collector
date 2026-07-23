/**
 * EP-033 — API usage history module tests (no OpenAI / no Morning spawn).
 * Run: node test/api-usage-history-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createEmptyHistory,
  loadHistory,
  saveHistory,
  appendEntry,
  recordMorningUsage,
  buildMorningHistoryEntry,
  summarizeUsageEntries,
  filterEntriesSince,
  filterEntriesInRange,
  normalizeEntry,
} = require("../lib/api-usage-history");

function tmpFile(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, "api-usage-history.json");
}

{
  const filePath = tmpFile("usage-hist-missing-");
  const hist = loadHistory(filePath);
  assert.deepStrictEqual(hist, createEmptyHistory());
  assert.deepStrictEqual(hist, { version: 1, entries: [] });
  console.log("missing file → empty PASS");
}

{
  const filePath = tmpFile("usage-hist-roundtrip-");
  const entry = buildMorningHistoryEntry({
    startedAt: "2026-07-23T04:27:01.000Z",
    finishedAt: "2026-07-23T04:30:15.123Z",
    model: "gpt-5-mini",
    analyze: {
      requests: 49,
      input_tokens: 38200,
      output_tokens: 21110,
      total_tokens: 59310,
    },
    enrich: {
      requests: 50,
      input_tokens: 40614,
      output_tokens: 27381,
      total_tokens: 67995,
    },
    runOptions: { skipCollect: true, skipAi: false, fromEnriched: false },
  });
  assert.strictEqual(entry.id, "2026-07-23T04:30:15.123Z");
  assert.strictEqual(entry.status, "success");
  assert.strictEqual(entry.total.requests, 99);
  assert.strictEqual(entry.total.inputTokens, 78814);
  assert.strictEqual(entry.total.outputTokens, 48491);
  assert.strictEqual(entry.total.totalTokens, 127305);
  assert.ok(Math.abs(entry.estimatedCostUsd.input - 0.0197035) < 1e-12);
  assert.ok(Math.abs(entry.estimatedCostUsd.output - 0.096982) < 1e-12);
  assert.ok(Math.abs(entry.estimatedCostUsd.total - 0.1166855) < 1e-12);

  const saved = recordMorningUsage(filePath, entry);
  assert.strictEqual(saved.added, true);
  const loaded = loadHistory(filePath);
  assert.strictEqual(loaded.entries.length, 1);
  assert.deepStrictEqual(loaded.entries[0], entry);
  console.log("build/save/load PASS");
}

{
  const filePath = tmpFile("usage-hist-dup-");
  const entry = buildMorningHistoryEntry({
    startedAt: "2026-07-23T01:00:00.000Z",
    finishedAt: "2026-07-23T01:01:00.000Z",
    model: "gpt-5-mini",
    analyze: { requests: 1, input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    enrich: emptyish(),
  });
  recordMorningUsage(filePath, entry);
  const before = fs.readFileSync(filePath, "utf8");
  const again = recordMorningUsage(filePath, {
    ...entry,
    analyze: { requests: 999, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
  assert.strictEqual(again.added, false);
  assert.strictEqual(fs.readFileSync(filePath, "utf8"), before);
  assert.strictEqual(loadHistory(filePath).entries.length, 1);
  assert.strictEqual(loadHistory(filePath).entries[0].analyze.requests, 1);
  console.log("duplicate id PASS");
}

function emptyish() {
  return { requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

{
  const filePath = tmpFile("usage-hist-multi-");
  const a = buildMorningHistoryEntry({
    finishedAt: "2026-07-21T10:00:00.000Z",
    startedAt: "2026-07-21T09:00:00.000Z",
    model: "gpt-5-mini",
    analyze: { requests: 1, input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    enrich: emptyish(),
  });
  const b = buildMorningHistoryEntry({
    finishedAt: "2026-07-22T10:00:00.000Z",
    startedAt: "2026-07-22T09:00:00.000Z",
    model: "gpt-5-mini",
    analyze: emptyish(),
    enrich: { requests: 2, input_tokens: 200, output_tokens: 20, total_tokens: 220 },
  });
  const zero = buildMorningHistoryEntry({
    finishedAt: "2026-07-23T10:00:00.000Z",
    startedAt: "2026-07-23T09:00:00.000Z",
    model: "gpt-5-mini",
    analyze: emptyish(),
    enrich: emptyish(),
    runOptions: { skipAi: true },
  });
  recordMorningUsage(filePath, a);
  recordMorningUsage(filePath, b);
  recordMorningUsage(filePath, zero);
  const hist = loadHistory(filePath);
  assert.strictEqual(hist.entries.length, 3);
  assert.strictEqual(hist.entries[2].total.requests, 0);
  assert.deepStrictEqual(hist.entries[2].estimatedCostUsd, {
    input: 0,
    output: 0,
    total: 0,
  });
  assert.strictEqual(hist.entries[2].runOptions.skipAi, true);
  console.log("multi + zero PASS");
}

{
  const filePath = tmpFile("usage-hist-corrupt-");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{not-json", "utf8");
  const before = fs.readFileSync(filePath, "utf8");
  assert.throws(() => loadHistory(filePath), /corrupt|refusing/);
  assert.throws(
    () =>
      recordMorningUsage(
        filePath,
        buildMorningHistoryEntry({
          finishedAt: "2026-07-23T12:00:00.000Z",
          analyze: emptyish(),
          enrich: emptyish(),
        })
      ),
    /corrupt|refusing/
  );
  assert.strictEqual(fs.readFileSync(filePath, "utf8"), before);
  console.log("corrupt refuse overwrite PASS");
}

{
  const entries = [
    buildMorningHistoryEntry({
      finishedAt: "2026-07-21T10:00:00.000Z",
      startedAt: "2026-07-21T09:00:00.000Z",
      model: "gpt-5-mini",
      analyze: {
        requests: 1,
        input_tokens: 1000000,
        output_tokens: 0,
        total_tokens: 1000000,
      },
      enrich: emptyish(),
    }),
    buildMorningHistoryEntry({
      finishedAt: "2026-07-22T10:00:00.000Z",
      startedAt: "2026-07-22T09:00:00.000Z",
      model: "gpt-5-mini",
      analyze: emptyish(),
      enrich: {
        requests: 2,
        input_tokens: 0,
        output_tokens: 1000000,
        total_tokens: 1000000,
      },
    }),
  ];
  const original = JSON.parse(JSON.stringify(entries));
  const summary = summarizeUsageEntries(entries);
  assert.deepStrictEqual(summary, {
    runs: 2,
    requests: 3,
    inputTokens: 1000000,
    outputTokens: 1000000,
    totalTokens: 2000000,
    estimatedCostUsd: {
      input: 0.25,
      output: 2.0,
      total: 2.25,
    },
  });
  assert.deepStrictEqual(entries, original);

  const since = filterEntriesSince(entries, "2026-07-22T00:00:00.000Z");
  assert.strictEqual(since.length, 1);
  assert.strictEqual(since[0].id, "2026-07-22T10:00:00.000Z");
  assert.deepStrictEqual(entries, original);

  const ranged = filterEntriesInRange(
    entries,
    "2026-07-21T00:00:00.000Z",
    "2026-07-21T23:59:59.999Z"
  );
  assert.strictEqual(ranged.length, 1);
  assert.strictEqual(ranged[0].id, "2026-07-21T10:00:00.000Z");
  assert.deepStrictEqual(entries, original);

  const again = summarizeUsageEntries(entries);
  assert.deepStrictEqual(again, summary);
  console.log("summarize/filter/determinism PASS");
}

{
  const { history, added } = appendEntry(createEmptyHistory(), {
    id: "x",
    finishedAt: "x",
    startedAt: "x",
    model: "gpt-5-mini",
    analyze: emptyish(),
    enrich: emptyish(),
    total: emptyish(),
    estimatedCostUsd: { input: 0, output: 0, total: 0 },
    status: "success",
    runOptions: {},
  });
  assert.strictEqual(added, true);
  assert.strictEqual(normalizeEntry(history.entries[0]).id, "x");
  console.log("append empty PASS");
}

{
  const filePath = tmpFile("usage-hist-pretty-");
  saveHistory(filePath, createEmptyHistory());
  const text = fs.readFileSync(filePath, "utf8");
  assert.ok(text.includes('\n  "version": 1'));
  assert.ok(text.includes('"entries": []'));
  console.log("pretty json PASS");
}

console.log("api-usage-history-test: ALL PASS");
