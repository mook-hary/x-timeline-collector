/**
 * ED-001 — Today's Picks debug view.
 * Run: node test/today-picks-debug-test.js
 */
const assert = require("assert");
const {
  selectTodayPicks,
  selectTodayPicksDetailed,
} = require("../lib/today-picks");
const {
  isTodayPicksDebugEnabled,
  formatTodayPicksDebug,
  maybeLogTodayPicksDebug,
  ENV_FLAG,
} = require("../lib/today-picks-debug");

function post(overrides = {}) {
  const {
    url = "https://x.com/user/status/1",
    text = "本文",
    category = "AI",
    importance = 4,
    summary = "十分な長さのある要約テキストです。",
    reason = "注目理由あり",
    tags = ["t"],
    postedAt = "2026-07-14T12:00:00.000Z",
    authorHandle,
  } = overrides;
  return {
    postedAt,
    url,
    text,
    authorHandle,
    finalAnalysis: { category },
    enrichment: { importance, summary, reason, tags },
  };
}

// --- env gate ---
{
  assert.strictEqual(isTodayPicksDebugEnabled({}), false);
  assert.strictEqual(isTodayPicksDebugEnabled({ [ENV_FLAG]: "false" }), false);
  assert.strictEqual(isTodayPicksDebugEnabled({ [ENV_FLAG]: "true" }), true);
  assert.strictEqual(isTodayPicksDebugEnabled({ [ENV_FLAG]: "TRUE" }), true);
  console.log("ED001 env-gate PASS");
}

// --- picks have no debug fields; debug is separate ---
{
  const posts = [
    post({
      url: "https://x.com/a/status/1",
      authorHandle: "a",
      text: "AI新機能A",
      summary: "OpenAIが新機能Aを発表した公式情報。十分長い。",
      category: "AI",
      importance: 5,
    }),
    post({
      url: "https://x.com/b/status/2",
      authorHandle: "b",
      text: "AI新機能Aの紹介",
      summary: "OpenAI新機能Aの発表を紹介する投稿。十分長い。",
      category: "AI",
      importance: 5,
    }),
    post({
      url: "https://x.com/c/status/3",
      authorHandle: "c",
      text: "アニメ制作C",
      summary: "制作現場の実務に触れたレポート。十分長い。",
      category: "アニメ・漫画",
      importance: 4,
    }),
  ];

  const picks = selectTodayPicks(posts, 5);
  assert.ok(picks.length >= 1);
  for (const p of picks) {
    assert.strictEqual(p._selectionSignals, undefined);
    assert.ok(!("selectionSignals" in p));
  }

  const { picks: detailedPicks, debug } = selectTodayPicksDetailed(posts, 5);
  assert.deepStrictEqual(
    detailedPicks.map((p) => p.url),
    picks.map((p) => p.url)
  );
  assert.ok(debug);
  assert.strictEqual(debug.candidateCount, 3);
  assert.ok(debug.selectedCount >= 1);
  assert.ok(Array.isArray(debug.selected));
  assert.ok(Array.isArray(debug.rejected));
  assert.ok(debug.rejected.some((r) => r.reasons.includes("Near Duplicate")));
  console.log("ED001 separation PASS");
}

// --- format output ---
{
  const posts = [
    post({
      url: "https://x.com/a/status/1",
      authorHandle: "openai",
      text: "OpenAI 新モデル公開",
      summary: "OpenAIが新モデルを公開した公式情報。十分長い要約。",
      category: "AI",
      importance: 5,
    }),
    post({
      url: "https://x.com/b/status/2",
      authorHandle: "mirror",
      text: "OpenAI 新モデル紹介",
      summary: "OpenAI新モデル公開の紹介投稿。十分長い要約。",
      category: "AI",
      importance: 5,
    }),
    post({
      url: "https://x.com/c/status/3",
      authorHandle: "studio",
      text: "アニメ制作メモ",
      summary: "制作現場の実務メモとして十分な長さの要約。",
      category: "アニメ・漫画",
      importance: 4,
    }),
  ];
  const { debug } = selectTodayPicksDetailed(posts, 5);
  const text = formatTodayPicksDebug(debug);
  assert.ok(text.includes("Today's Picks Debug"));
  assert.ok(text.includes(`Selected: ${debug.selectedCount} / Candidates: 3`));
  assert.ok(text.includes("Selected Picks"));
  assert.ok(text.includes("Score:"));
  assert.ok(text.includes("Category:"));
  assert.ok(text.includes("Importance:"));
  assert.ok(text.includes("Source:"));
  assert.ok(text.includes("Signals:"));
  assert.ok(text.includes("✓"));
  assert.ok(text.includes("Rejected"));
  assert.ok(text.includes("Reason:"));
  assert.ok(text.includes("Near Duplicate") || text.includes("Lower Score"));
  console.log("ED001 format PASS");
}

// --- maybeLog respects env ---
{
  const logs = [];
  const logger = { log: (msg) => logs.push(String(msg)) };
  const debug = {
    candidateCount: 1,
    selectedCount: 0,
    limit: 5,
    selected: [],
    rejected: [],
  };
  assert.strictEqual(
    maybeLogTodayPicksDebug(debug, { [ENV_FLAG]: "false" }, logger),
    false
  );
  assert.strictEqual(logs.length, 0);
  assert.strictEqual(
    maybeLogTodayPicksDebug(debug, { [ENV_FLAG]: "true" }, logger),
    true
  );
  assert.strictEqual(logs.length, 1);
  assert.ok(logs[0].includes("Today's Picks Debug"));
  console.log("ED001 log-gate PASS");
}

// --- empty ---
{
  const { picks, debug } = selectTodayPicksDetailed([], 5);
  assert.deepStrictEqual(picks, []);
  const text = formatTodayPicksDebug(debug);
  assert.ok(text.includes("Selected: 0 / Candidates: 0"));
  console.log("ED001 empty PASS");
}

console.log("today-picks-debug-test: all PASS");
