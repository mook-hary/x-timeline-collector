/**
 * EP-051 — Editorial similarity.
 * Run: node test/editorial-similarity-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  normalizeText,
  calculateSimilarity,
  findSimilarItems,
} = require("../lib/editorial-similarity");
const { createEditorialStore } = require("../lib/editorial-store");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function item(partial) {
  return {
    id: partial.id || "x",
    source: partial.source || "news",
    type: partial.type || "article",
    title: partial.title || "",
    summary: partial.summary || "",
    body: partial.body || "",
    tags: partial.tags || [],
    ...partial,
  };
}

// --- normalize ---
{
  assert.strictEqual(normalizeText("  Hello, WORLD!!  "), "hello world");
  assert.strictEqual(normalizeText("ＡＢＣ　１２３"), "abc 123");
  assert.strictEqual(
    normalizeText("合気道・稽古メモ！！"),
    "合気道 稽古メモ"
  );
  assert.strictEqual(normalizeText("a\n\tb   c"), "a b c");
  assert.strictEqual(normalizeText(""), "");
  assert.strictEqual(normalizeText(null), "");
  console.log("EP051 normalize PASS");
}

// --- exact / unrelated / punctuation ---
{
  const a = item({
    title: "Morning Pipeline Summary",
    body: "Collect 247 items and publish.",
  });
  const same = item({
    title: "morning pipeline summary!!!",
    body: "Collect 247 items and publish.",
  });
  const other = item({
    title: "天気は晴れ",
    body: "今日は公園で犬を散歩した。",
  });

  assert.strictEqual(calculateSimilarity(a, a), 1);
  assert.strictEqual(calculateSimilarity(a, same), 1);
  assert.ok(calculateSimilarity(a, other) < 0.3);

  // deterministic
  const s1 = calculateSimilarity(a, same);
  const s2 = calculateSimilarity(a, same);
  assert.strictEqual(s1, s2);
  console.log("EP051 similarity-basic PASS");
}

// --- Japanese ---
{
  const a = item({
    title: "合気道の朝稽古",
    summary: "体の使い方について",
    body: "相手の力を受け流す感覚を確認した。",
    tags: ["aikido", "keiko"],
  });
  const b = item({
    title: "合気道の朝稽古！",
    summary: "体の使い方について。",
    body: "相手の力を受け流す感覚を確認した",
    tags: ["aikido", "keiko"],
  });
  const c = item({
    title: "アニメ新作情報",
    body: "来週放送のエピソードまとめ",
  });
  assert.ok(calculateSimilarity(a, b) >= 0.9);
  assert.ok(calculateSimilarity(a, c) < 0.4);
  console.log("EP051 japanese PASS");
}

// --- empty not similar ---
{
  const empty = item({ title: "", summary: "", body: "", tags: [] });
  const alsoEmpty = item({ title: "   ", body: null, tags: ["", "  "] });
  const filled = item({ title: "hello world" });
  assert.strictEqual(calculateSimilarity(empty, alsoEmpty), 0);
  assert.strictEqual(calculateSimilarity(empty, filled), 0);
  assert.strictEqual(calculateSimilarity(filled, empty), 0);
  console.log("EP051 empty PASS");
}

// --- findSimilarItems options ---
{
  const target = item({
    id: "t",
    source: "news",
    type: "article",
    title: "AIニュース要約",
    body: "今日のテック動向をまとめる",
  });
  const items = [
    item({
      id: "near",
      source: "news",
      type: "article",
      title: "AIニュース要約",
      body: "今日のテック動向をまとめる",
    }),
    item({
      id: "mid",
      source: "news",
      type: "post",
      title: "AIニュース",
      body: "テック動向まとめ",
    }),
    item({
      id: "far",
      source: "aikido",
      type: "article",
      title: "稽古メモ",
      body: "受け身の練習",
    }),
    item({
      id: "self",
      source: "news",
      type: "article",
      title: "AIニュース要約",
      body: "今日のテック動向をまとめる",
    }),
  ];

  const all = findSimilarItems(target, items, { threshold: 0.5, limit: 10 });
  assert.ok(all.length >= 2);
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i - 1].similarity >= all[i].similarity);
  }
  assert.ok(all.every((r) => r.similarity >= 0.5 && r.similarity <= 1));

  const limited = findSimilarItems(target, items, {
    threshold: 0.5,
    limit: 1,
  });
  assert.strictEqual(limited.length, 1);

  const excluded = findSimilarItems(target, items, {
    threshold: 0.5,
    excludeId: "self",
  });
  assert.ok(!excluded.some((r) => r.item.id === "self"));

  const bySource = findSimilarItems(target, items, {
    threshold: 0.2,
    source: "aikido",
  });
  assert.ok(bySource.every((r) => r.item.source === "aikido"));

  const byType = findSimilarItems(target, items, {
    threshold: 0.2,
    type: "post",
  });
  assert.ok(byType.every((r) => r.item.type === "post"));

  const highOnly = findSimilarItems(target, items, { threshold: 0.99 });
  assert.ok(highOnly.every((r) => r.similarity >= 0.99));
  console.log("EP051 findSimilarItems PASS");
}

// --- store findSimilar / findSimilarById ---
{
  const store = createEditorialStore({ rootDir: tmpDir("editorial-sim-") });
  store.create({
    id: "base",
    source: "news",
    type: "article",
    title: "GitHub Pages 公開手順",
    body: "Reader を毎朝自動更新する",
    tags: ["reader", "pages"],
  });
  store.create({
    id: "dup",
    source: "news",
    type: "article",
    title: "GitHub Pages公開手順",
    body: "Readerを毎朝自動更新する",
    tags: ["reader", "pages"],
  });
  store.create({
    id: "other",
    source: "aikido",
    type: "post",
    title: "稽古日誌",
    body: "肩の力を抜く",
  });

  const hits = store.findSimilar(
    {
      title: "GitHub Pages 公開手順",
      body: "Reader を毎朝自動更新する",
      tags: ["reader"],
    },
    { threshold: 0.6 }
  );
  assert.ok(hits.some((h) => h.item.id === "base"));
  assert.ok(hits.some((h) => h.item.id === "dup"));
  assert.ok(!hits.some((h) => h.item.id === "other"));

  const byId = store.findSimilarById("base", { threshold: 0.6 });
  assert.ok(!byId.some((h) => h.item.id === "base"));
  assert.ok(byId.some((h) => h.item.id === "dup"));

  assert.throws(() => store.findSimilarById("missing"), /not found/);

  // existing APIs intact
  assert.strictEqual(store.find("base").status, "draft");
  store.transition("base", "review");
  assert.strictEqual(store.find("base").status, "review");
  console.log("EP051 store-api PASS");
}

console.log("editorial-similarity-test: all PASS");
