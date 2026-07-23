/**
 * EP-022/024 — Digest Reader tests.
 * Run: node test/digest-reader-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildDigestReader,
  buildHighlights,
  escapeHtml,
  formatStars,
  estimateReadingMinutes,
} = require("../lib/digest-reader");
const { mergeDigestConfig, DEFAULT_DIGEST_CONFIG } = require("../lib/digest-core");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixturePosts() {
  return [
    {
      authorName: "A",
      authorHandle: "@a",
      postedAt: "2026-07-14T10:00:00.000Z",
      text: "raw a",
      url: "https://x.com/a/status/1",
      finalAnalysis: { category: "政治・社会", tags: ["政治"] },
      enrichment: {
        importance: 4,
        summary: "政治の要約A",
        tags: [],
        reason: "test",
      },
    },
    {
      authorName: "B",
      authorHandle: "@b",
      postedAt: "2026-07-14T11:00:00.000Z",
      text: "raw b",
      url: "https://x.com/b/status/2",
      finalAnalysis: { category: "AI", tags: ["AI"] },
      enrichment: {
        importance: 5,
        summary: "AIの要約B",
        tags: [],
        reason: "test",
      },
    },
    {
      authorName: "C",
      authorHandle: "@c",
      postedAt: "2026-07-14T12:00:00.000Z",
      text: "raw c",
      url: "https://x.com/c/status/3",
      finalAnalysis: { category: "アニメ・漫画", tags: ["アニメ"] },
      enrichment: {
        importance: 4,
        summary: "アニメの要約C",
        tags: [],
        reason: "test",
      },
    },
    {
      authorName: "D",
      authorHandle: "@d",
      postedAt: "2026-07-14T13:00:00.000Z",
      text: "raw d",
      url: "",
      finalAnalysis: { category: "イラスト・美術", tags: [] },
      enrichment: {
        importance: 3,
        summary: "イラストの要約D",
        tags: [],
        reason: "test",
      },
    },
    {
      authorName: "E",
      authorHandle: "@e",
      postedAt: "2026-07-14T14:00:00.000Z",
      text: "promo",
      url: "https://x.com/e/status/5",
      finalAnalysis: { category: "広告・PR", tags: [] },
      enrichment: {
        importance: 5,
        summary: "広告は除外対象",
        tags: [],
        reason: "test",
      },
    },
  ];
}

const TREND_WORDS = ["増加", "減少", "増えた", "減った", "上昇", "低下", "昨日より", "前回より"];

function assertNoTrendLanguage(text) {
  for (const word of TREND_WORDS) {
    assert.ok(!text.includes(word), `unexpected trend word: ${word}`);
  }
}

// --- helpers ---
{
  assert.strictEqual(escapeHtml(`<a href="x">`), `&lt;a href=&quot;x&quot;&gt;`);
  assert.strictEqual(formatStars(3), "★ ★ ★");
  assert.strictEqual(formatStars(0), "・");
  console.log("Helpers PASS");
}

// --- Case 1: generates reader with hierarchy ---
{
  const root = tmpDir("digest-reader-c1-");
  const out = path.join(root, "output", "digest-reader");
  const result = buildDigestReader({
    rootDir: root,
    outputDir: out,
    posts: fixturePosts(),
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: {
      from: { year: 2026, month: 7, day: 14, label: "2026-07-14" },
      to: { year: 2026, month: 7, day: 14, label: "2026-07-14" },
      top: 8,
    },
  });
  assert.ok(fs.existsSync(result.htmlPath));
  assert.ok(fs.existsSync(result.cssPath));
  const html = fs.readFileSync(result.htmlPath, "utf8");

  // Header metrics
  assert.ok(html.includes("件解析"));
  assert.ok(html.includes("注目"));
  assert.ok(/約\d+分/.test(html));
  assert.ok(html.includes('aria-label="主要指標"'));
  assert.ok(html.includes("Local Private Digest"));
  assert.ok(html.includes("生成:"));

  // No Overview category chips (class chip must not appear)
  assert.ok(!html.includes('class="chip"'));
  assert.ok(!html.includes("chips"));
  assert.ok(html.includes("今日のハイライト"));
  assert.ok(html.includes('class="highlights"'));

  // Highlights max 3
  const highlightMatches = html.match(/<ul class="highlights">([\s\S]*?)<\/ul>/);
  assert.ok(highlightMatches);
  const highlightItems = [...highlightMatches[1].matchAll(/<li>/g)];
  assert.ok(highlightItems.length <= 3);
  assert.ok(highlightItems.length >= 1);
  assertNoTrendLanguage(highlightMatches[1]);

  // Top Stories link + importance label
  assert.ok(html.includes("Xで開く ↗"));
  assert.ok(html.includes('aria-label="元の投稿をXで開く"'));
  assert.ok(html.includes("重要度"));
  assert.ok(html.includes("★"));
  assert.ok(!html.includes("元ポストを見る"));
  assert.ok(!html.includes("personalScore"));

  // Category nav: Top first
  const navMatch = html.match(/<ul class="cat-nav__list">([\s\S]*?)<\/ul>/);
  assert.ok(navMatch);
  assert.ok(navMatch[1].trimStart().startsWith('<li><a href="#top-stories">Top</a></li>'));

  // All category sections retained
  assert.ok(html.includes("政治・社会"));
  assert.ok(html.includes("AI"));
  assert.ok(html.includes("アニメ・漫画"));
  assert.ok(html.includes('id="all-categories"'));

  assert.ok(html.includes("Timeline Digest"));
  assert.ok(html.includes("Top Stories"));
  assert.ok(html.includes('href="style.css"'));
  assert.ok(html.includes("Generated locally."));
  assert.ok(html.includes("Not published."));
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("/Users/"));
  assert.ok(!html.includes("timeline_enriched.json"));
  console.log("Case1 PASS");
}

// --- Case 2: empty state Overview does not break ---
{
  const root = tmpDir("digest-reader-c2-");
  const out = path.join(root, "out");
  const result = buildDigestReader({
    rootDir: root,
    outputDir: out,
    posts: [],
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: { top: 5 },
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("条件に一致する投稿はありませんでした"));
  assert.ok(html.includes("0件解析"));
  assert.ok(html.includes("注目0件"));
  assert.ok(/約\d+分/.test(html));
  assert.ok(!html.includes('class="chip"'));
  assert.strictEqual(result.summary.total, 0);
  console.log("Case2 PASS");
}

// --- Case 3: no source link when url missing ---
{
  const root = tmpDir("digest-reader-c3-");
  const out = path.join(root, "out");
  buildDigestReader({
    rootDir: root,
    outputDir: out,
    posts: [
      {
        postedAt: "2026-07-14T10:00:00.000Z",
        url: "",
        finalAnalysis: { category: "その他" },
        enrichment: { importance: 4, summary: "urlなし" },
      },
    ],
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: {
      from: { year: 2026, month: 7, day: 14, label: "2026-07-14" },
      to: { year: 2026, month: 7, day: 14, label: "2026-07-14" },
      top: 5,
    },
  });
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  assert.ok(html.includes("リンクなし"));
  assert.ok(!html.includes("Xで開く"));
  console.log("Case3 PASS");
}

// --- Case 4: does not write site/ ---
{
  const root = tmpDir("digest-reader-c4-");
  const site = path.join(root, "site");
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, "marker.txt"), "keep\n", "utf8");
  buildDigestReader({
    rootDir: root,
    outputDir: path.join(root, "output", "digest-reader"),
    posts: fixturePosts(),
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: { top: 5 },
  });
  assert.strictEqual(
    fs.readFileSync(path.join(site, "marker.txt"), "utf8"),
    "keep\n"
  );
  assert.ok(!fs.existsSync(path.join(site, "index.html")));
  console.log("Case4 PASS");
}

// --- Case 5: highlights for unknown / few categories ---
{
  const highlights = buildHighlights(
    {
      total: 2,
      topPosts: [{ category: "謎カテゴリ", summary: "x", importance: 4 }],
      categories: [{ category: "謎カテゴリ", count: 2, posts: [] }],
    },
    { overviewSelected: 1 },
    3
  );
  assert.ok(highlights.length <= 3);
  assert.ok(highlights[0].includes("謎カテゴリ"));
  assert.ok(highlights.some((h) => h.includes("注目1件")));
  assertNoTrendLanguage(highlights.join("\n"));

  const emptyHighlights = buildHighlights(
    { total: 0, topPosts: [], categories: [] },
    { overviewSelected: 0 },
    1
  );
  assert.deepStrictEqual(emptyHighlights, []);
  console.log("Case5 PASS");
}

// --- Case 6: category nav caps at 5 + helper link ---
{
  const root = tmpDir("digest-reader-c6-");
  const out = path.join(root, "out");
  const many = [];
  const cats = [
    "政治・社会",
    "AI",
    "アニメ・漫画",
    "イラスト・美術",
    "ゲーム・ゲーム開発",
    "プログラミング・IT",
    "ニュース・報道",
    "日常・雑談",
  ];
  let seq = 0;
  for (let i = 0; i < cats.length; i++) {
    const n = cats.length - i; // 8..1 so counts differ
    for (let j = 0; j < n; j++) {
      const hour = String(Math.floor(seq / 60) + 1).padStart(2, "0");
      const minute = String(seq % 60).padStart(2, "0");
      seq += 1;
      many.push({
        postedAt: `2026-07-14T${hour}:${minute}:00.000Z`,
        url: `https://x.com/u/status/${i}${j}`,
        finalAnalysis: { category: cats[i], tags: [] },
        enrichment: {
          importance: 4,
          summary: `要約 ${cats[i]} ${j}`,
          tags: [],
          reason: "test",
        },
      });
    }
  }
  const result = buildDigestReader({
    rootDir: root,
    outputDir: out,
    posts: many,
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: {
      from: { year: 2026, month: 7, day: 14, label: "2026-07-14" },
      to: { year: 2026, month: 7, day: 14, label: "2026-07-14" },
      top: 8,
    },
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  const nav = html.match(/<ul class="cat-nav__list">([\s\S]*?)<\/ul>/)[1];
  const catLinks = [...nav.matchAll(/href="#category-\d+"/g)];
  assert.ok(catLinks.length <= 5);
  assert.ok(nav.includes("すべてのカテゴリ"));
  assert.ok(html.includes('id="all-categories"'));
  const sectionCount = [...html.matchAll(/id="category-\d+"/g)].length;
  assert.ok(sectionCount >= 6, `expected all category sections, got ${sectionCount}`);
  for (const c of cats) {
    assert.ok(html.includes(c), `missing section for ${c}`);
  }
  assert.ok(result.summary.highlights.length <= 3);
  assertNoTrendLanguage(result.summary.highlights.join("\n"));
  console.log("Case6 PASS");
}

console.log("digest-reader-test: ALL PASS");
