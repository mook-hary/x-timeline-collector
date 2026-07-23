/**
 * EP-029 — Today's Brief tests.
 * Run: node test/today-brief-test.js
 */
const assert = require("assert");
const { buildTodayBrief } = require("../lib/today-brief");

function post(category, n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://x.com/u/status/${category}-${i}`,
    finalAnalysis: { category },
  }));
}

// --- top + second + picks ---
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
  assert.ok(lines[0].includes("AI関連の投稿が最も多い日です"));
  assert.ok(lines[1].includes("アニメ・漫画関連も多く流れています"));
  assert.ok(lines[2].includes("まず読む投稿を5件選びました"));
  // weak categories ignored when majors exist
  assert.ok(!lines.some((l) => l.includes("広告・PR")));
  assert.ok(!lines.some((l) => l.includes("その他")));
  console.log("top-second-picks PASS");
}

// --- empty ---
{
  const lines = buildTodayBrief([], []);
  assert.deepStrictEqual(lines, ["条件に一致する投稿がありません"]);
  console.log("empty PASS");
}

// --- deterministic ---
{
  const posts = [...post("政治・社会", 2), ...post("ニュース・報道", 2)];
  const a = buildTodayBrief(posts, 2);
  const b = buildTodayBrief(posts, 2);
  assert.deepStrictEqual(a, b);
  // tie-break by category name (ja)
  assert.ok(a[0].includes("ニュース・報道") || a[0].includes("政治・社会"));
  console.log("deterministic PASS");
}

// --- only weak categories allowed when no majors ---
{
  const lines = buildTodayBrief([...post("その他", 3), ...post("広告・PR", 1)], 1);
  assert.ok(lines[0].includes("その他関連の投稿が最も多い日です"));
  assert.ok(lines[1].includes("広告・PR関連も多く流れています"));
  assert.ok(lines[2].includes("まず読む投稿を1件選びました"));
  console.log("weak-only PASS");
}

console.log("today-brief-test: ALL PASS");
