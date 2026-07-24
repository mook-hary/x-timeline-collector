/**
 * EP-029 / EP-038 — Morning Brief tests (editorial paragraphs).
 * Run: node test/today-brief-test.js
 */
const assert = require("assert");
const {
  buildTodayBrief,
  buildLegacyBrief,
  BRIEF_MAX_CHARS,
} = require("../lib/today-brief");

function post(category, n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://x.com/u/status/${category}-${i}`,
    finalAnalysis: { category },
  }));
}

function charLen(lines) {
  return Array.from(lines.join("")).length;
}

const TREND_WORDS = ["増加", "減少", "増えた", "減った", "上昇", "低下", "昨日より", "前回より"];

function assertNoTrendLanguage(lines) {
  const text = lines.join("\n");
  for (const word of TREND_WORDS) {
    assert.ok(!text.includes(word), `unexpected trend word: ${word}`);
  }
}

function assertNoTitleDump(lines) {
  const text = lines.join("\n");
  assert.ok(!/https?:\/\//.test(text));
  assert.ok(!text.includes("status/"));
}

// --- AI-heavy: 3 editorial paragraphs ---
{
  const posts = [
    ...post("AI", 5),
    ...post("アニメ・漫画", 3),
    ...post("日常・雑談", 1),
    ...post("広告・PR", 10),
    ...post("その他", 8),
  ];
  const picks = [{ url: "a" }, { url: "b" }, { url: "c" }, { url: "d" }, { url: "e" }];
  const lines = buildTodayBrief(posts, picks);
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[0].includes("AI"));
  assert.ok(lines[1].length > 10);
  assert.ok(lines[2].includes("Today's Picks") || lines[2].includes("読む"));
  assert.ok(!lines.some((l) => l.includes("広告・PR")));
  assert.ok(!lines.some((l) => l.includes("その他")));
  assert.ok(!lines.some((l) => /件選びました/.test(l)));
  assert.ok(!lines.some((l) => /最も多い日です/.test(l)));
  assert.ok(charLen(lines) <= BRIEF_MAX_CHARS);
  assertNoTrendLanguage(lines);
  assertNoTitleDump(lines);
  console.log("ai-heavy editorial PASS");
}

// --- multi-category ---
{
  const posts = [
    ...post("政治・社会", 4),
    ...post("ニュース・報道", 3),
    ...post("AI", 2),
  ];
  const lines = buildTodayBrief(posts, 3);
  assert.strictEqual(lines.length, 3);
  assert.ok(charLen(lines) <= BRIEF_MAX_CHARS);
  assertNoTrendLanguage(lines);
  console.log("multi-category PASS");
}

// --- empty ---
{
  const lines = buildTodayBrief([], []);
  assert.deepStrictEqual(lines, ["条件に一致する投稿がありません"]);
  console.log("empty PASS");
}

// --- few posts → legacy fallback ---
{
  const lines = buildTodayBrief(post("AI", 1), 1);
  assert.deepStrictEqual(lines, buildLegacyBrief(post("AI", 1), 1));
  assert.ok(lines[0].includes("AI関連の投稿が最も多い日です"));
  assert.ok(lines.some((l) => l.includes("まず読む投稿を1件選びました")));
  console.log("few-posts fallback PASS");
}

// --- deterministic ---
{
  const posts = [...post("政治・社会", 2), ...post("ニュース・報道", 2)];
  const a = buildTodayBrief(posts, 2);
  const b = buildTodayBrief(posts, 2);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.length, 3);
  console.log("deterministic PASS");
}

// --- weak-only still produces brief ---
{
  const lines = buildTodayBrief([...post("その他", 3), ...post("広告・PR", 2)], 1);
  assert.ok(lines.length >= 1);
  assert.ok(lines.length <= 3);
  assert.ok(charLen(lines) <= BRIEF_MAX_CHARS || lines[0].includes("関連"));
  console.log("weak-only PASS");
}

// --- no title / pick summary copy ---
{
  const posts = [
    {
      url: "https://x.com/u/status/1",
      text: "UNIQUE_RAW_TITLE_SHOULD_NOT_APPEAR",
      finalAnalysis: { category: "AI" },
      enrichment: {
        summary: "UNIQUE_SUMMARY_SHOULD_NOT_APPEAR",
        reason: "UNIQUE_REASON_SHOULD_NOT_APPEAR",
      },
    },
    {
      url: "https://x.com/u/status/2",
      text: "another",
      finalAnalysis: { category: "プログラミング・IT" },
      enrichment: { summary: "別の要約" },
    },
  ];
  const picks = [
    {
      summary: "UNIQUE_SUMMARY_SHOULD_NOT_APPEAR",
      reason: "UNIQUE_REASON_SHOULD_NOT_APPEAR",
    },
  ];
  const lines = buildTodayBrief(posts, picks);
  const text = lines.join("\n");
  assert.ok(!text.includes("UNIQUE_RAW_TITLE_SHOULD_NOT_APPEAR"));
  assert.ok(!text.includes("UNIQUE_SUMMARY_SHOULD_NOT_APPEAR"));
  assert.ok(!text.includes("UNIQUE_REASON_SHOULD_NOT_APPEAR"));
  console.log("no-copy PASS");
}

console.log("today-brief-test: ALL PASS");
