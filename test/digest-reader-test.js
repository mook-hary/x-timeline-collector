/**
 * EP-022/024/028 — Digest Reader tests (incl. Today's Picks).
 * Run: node test/digest-reader-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildDigestReader,
  escapeHtml,
  formatStars,
  selectTodaysPicks,
  isNearlySameText,
  renderPickCard,
  DEFAULT_TOP,
  buildTodayBrief,
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

function dayOptions(extra = {}) {
  return {
    from: { year: 2026, month: 7, day: 14, label: "2026-07-14" },
    to: { year: 2026, month: 7, day: 14, label: "2026-07-14" },
    top: DEFAULT_TOP,
    ...extra,
  };
}

// --- helpers ---
{
  assert.strictEqual(escapeHtml(`<a href="x">`), `&lt;a href=&quot;x&quot;&gt;`);
  assert.strictEqual(formatStars(3), "★ ★ ★");
  assert.strictEqual(formatStars(0), "・");
  assert.strictEqual(DEFAULT_TOP, 5);
  assert.ok(isNearlySameText("同じ文", "同じ文"));
  assert.ok(isNearlySameText("hello world", "hello   world"));
  assert.ok(!isNearlySameText("要約A", "まったく別の本文"));
  console.log("Helpers PASS");
}

// --- Case 1: generates reader with Today's Picks ---
{
  const root = tmpDir("digest-reader-c1-");
  const out = path.join(root, "output", "digest-reader");
  const result = buildDigestReader({
    rootDir: root,
    outputDir: out,
    posts: fixturePosts(),
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: dayOptions({ top: 5 }),
  });
  assert.ok(fs.existsSync(result.htmlPath));
  assert.ok(fs.existsSync(result.cssPath));
  const html = fs.readFileSync(result.htmlPath, "utf8");

  assert.ok(html.includes("件解析"));
  assert.ok(html.includes("注目"));
  assert.ok(/約\d+分/.test(html));
  assert.ok(html.includes("Morning Brief"));
  assert.ok(html.includes("Today's Picks"));
  assert.ok(html.includes("Category Digest"));
  assert.ok(html.includes("More News"));
  assert.ok(html.includes("AI Usage Dashboard"));
  assert.ok(html.includes("Categories"));
  // EP-036 section order: Brief → Picks → Categories nav → Digest → More → Usage
  const iBrief = html.indexOf("Morning Brief");
  const iPicks = html.indexOf("Today's Picks");
  const iNav = html.indexOf('class="cat-nav"');
  const iDigest = html.indexOf("Category Digest");
  const iMore = html.indexOf("More News");
  const iUsage = html.indexOf("AI Usage Dashboard");
  assert.ok(iBrief < iPicks && iPicks < iNav && iNav < iDigest && iDigest < iMore && iMore < iUsage);
  assert.ok(html.includes('id="todays-picks"'));
  assert.ok(!html.includes("Top Stories"));
  assert.ok(!html.includes(">Overview<"));
  assert.ok(!html.includes("今日のハイライト"));
  assert.ok(!html.includes("editorialScore"));
  assert.ok(!html.includes("_editorialScore"));

  assert.ok(!html.includes('class="chip"'));
  assert.ok(Array.isArray(result.summary.brief));
  assert.ok(result.summary.brief.length >= 1);
  assert.ok(result.summary.brief.length <= 3);

  assert.ok(html.includes("Xで読む ↗"));
  assert.ok(html.includes("注目した理由"));
  assert.ok(html.includes('href="#todays-picks"'));
  const navMatch = html.match(/<ul class="cat-nav__list">([\s\S]*?)<\/ul>/);
  assert.ok(navMatch);
  assert.ok(
    navMatch[1].trimStart().startsWith('<li><a href="#todays-picks">Picks</a></li>')
  );

  assert.ok(html.includes("政治・社会"));
  assert.ok(html.includes("AI"));
  assert.ok(html.includes('id="all-categories"'));
  assert.ok(html.includes("Generated locally."));
  assert.ok(!html.includes("<script"));
  assert.ok(result.summary.picksCount >= 1);
  console.log("Case1 PASS");
}

// --- Case 2: empty state ---
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
  assert.ok(html.includes("条件に一致する投稿がありません"));
  assert.ok(html.includes("Morning Brief"));
  assert.ok(html.includes("0件解析"));
  assert.strictEqual(result.summary.total, 0);
  assert.strictEqual(result.summary.picksCount, 0);
  assert.deepStrictEqual(result.summary.brief, [
    "条件に一致する投稿がありません",
  ]);
  console.log("Case2 PASS");
}

// --- Case 3: no X link when url missing (picks) ---
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
        text: "本文のみ",
        finalAnalysis: { category: "その他" },
        enrichment: { importance: 4, summary: "urlなし" },
      },
    ],
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: dayOptions(),
  });
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  const picks = html.match(/id="todays-picks"[\s\S]*?<div id="all-categories">/);
  assert.ok(picks);
  assert.ok(!picks[0].includes("Xで読む"));
  assert.ok(!picks[0].includes("Xで開く"));
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

// --- Case 5: Morning Brief (buildTodayBrief) ---
{
  const lines = buildTodayBrief(
    [
      { finalAnalysis: { category: "AI" } },
      { finalAnalysis: { category: "AI" } },
      { finalAnalysis: { category: "アニメ・漫画" } },
    ],
    [{}, {}, {}]
  );
  assert.ok(lines.length <= 3);
  assert.ok(lines[0].includes("AI関連の投稿が最も多い日です"));
  assert.ok(lines[1].includes("アニメ・漫画関連も多く流れています"));
  assert.ok(lines[2].includes("まず読む投稿を3件選びました"));
  console.log("Case5 PASS");
}

// --- Case 6: category nav caps ---
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
    const n = cats.length - i;
    for (let j = 0; j < n; j++) {
      const hour = String(Math.floor(seq / 60) + 1).padStart(2, "0");
      const minute = String(seq % 60).padStart(2, "0");
      seq += 1;
      many.push({
        postedAt: `2026-07-14T${hour}:${minute}:00.000Z`,
        url: `https://x.com/u/status/${i}${j}`,
        text: `本文 ${cats[i]} ${j}`,
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
    digestOptions: dayOptions({ top: 8 }),
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  const nav = html.match(/<ul class="cat-nav__list">([\s\S]*?)<\/ul>/)[1];
  assert.ok([...nav.matchAll(/href="#category-\d+"/g)].length <= 5);
  assert.ok(nav.includes("すべてのカテゴリ"));
  assert.strictEqual(result.summary.picksCount, 8);
  assert.ok(result.summary.brief.length <= 3);
  assert.ok(result.summary.brief.some((l) => l.includes("まず読む投稿を8件")));
  console.log("Case6 PASS");
}

// --- EP-028: importance missing still in picks ---
{
  const root = tmpDir("digest-reader-no-imp-");
  const result = buildDigestReader({
    rootDir: root,
    outputDir: path.join(root, "out"),
    posts: [
      {
        postedAt: "2026-07-14T10:00:00.000Z",
        url: "https://x.com/u/status/100",
        text: "本文だけある投稿",
        finalAnalysis: { category: "AI", tags: ["x"] },
        enrichment: {
          summary: "要約はあるが重要度は未設定の投稿です。",
          reason: "根拠",
          tags: ["tag"],
        },
      },
    ],
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: dayOptions({ top: 5 }),
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(result.summary.picksCount >= 1);
  assert.ok(html.includes("Today's Picks（1）"));
  const picksSection = html.match(
    /id="todays-picks"[\s\S]*?(?=<div id="all-categories">)/
  )[0];
  assert.ok(!picksSection.includes("card__importance"));
  assert.ok(!picksSection.includes("重要度 -"));
  console.log("EP028 importance-missing PASS");
}

// --- EP-028: posts exist => non-zero picks ---
{
  const picks = selectTodaysPicks(
    [
      {
        url: "https://x.com/u/status/1",
        text: "a",
        finalAnalysis: { category: "日常・雑談" },
        enrichment: { summary: "短い" },
      },
      {
        url: "https://x.com/u/status/2",
        text: "b",
        finalAnalysis: { category: "日常・雑談" },
        enrichment: {},
      },
    ],
    5
  );
  assert.ok(picks.length >= 1);
  console.log("EP028 non-zero PASS");
}

// --- EP-028: --top N ---
{
  const posts = [];
  for (let i = 0; i < 10; i++) {
    posts.push({
      postedAt: `2026-07-14T10:${String(i).padStart(2, "0")}:00.000Z`,
      url: `https://x.com/u/status/${i}`,
      text: `本文${i}`,
      finalAnalysis: { category: "AI" },
      enrichment: {
        importance: 3,
        summary: `要約テキスト番号${i}は十分な長さがあります。`,
        reason: "r",
        tags: ["t"],
      },
    });
  }
  const root = tmpDir("digest-reader-topn-");
  const result = buildDigestReader({
    rootDir: root,
    outputDir: path.join(root, "out"),
    posts,
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: dayOptions({ top: 3 }),
  });
  assert.strictEqual(result.summary.picksCount, 3);
  assert.ok(result.htmlPath);
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("Today's Picks（3）"));
  console.log("EP028 top-n PASS");
}

// --- EP-028: high score first ---
{
  const ranked = selectTodaysPicks(
    [
      {
        url: "https://x.com/u/status/low",
        text: "x",
        finalAnalysis: { category: "広告・PR" },
        enrichment: { importance: 1, summary: "広告" },
      },
      {
        url: "https://x.com/u/status/high",
        text: "詳細な本文",
        finalAnalysis: { category: "AI", tags: ["LLM"] },
        enrichment: {
          importance: 5,
          summary: "高品質な要約。十分に長く加点される内容です。",
          reason: "学習に直結する根拠がある",
          tags: ["AI", "tool"],
        },
      },
    ],
    5
  );
  assert.ok(ranked[0].url.includes("high"));
  assert.ok(ranked[0]._editorialScore >= ranked[1]._editorialScore);
  console.log("EP028 high-score-first PASS");
}

// --- EP-028: duplicate URLs not shown twice ---
{
  const ranked = selectTodaysPicks(
    [
      {
        url: "https://x.com/u/status/dup",
        text: "1",
        finalAnalysis: { category: "AI" },
        enrichment: { importance: 5, summary: "同じURLの1件目" },
      },
      {
        url: "https://x.com/u/status/dup",
        text: "2",
        finalAnalysis: { category: "AI" },
        enrichment: { importance: 5, summary: "同じURLの2件目" },
      },
      {
        url: "https://x.com/u/status/other",
        text: "3",
        finalAnalysis: { category: "AI" },
        enrichment: { importance: 4, summary: "別URL" },
      },
    ],
    5
  );
  const urls = ranked.map((p) => p.url);
  assert.strictEqual(urls.length, new Set(urls).size);
  assert.strictEqual(ranked.length, 2);
  console.log("EP028 dedupe PASS");
}

// --- EP-028/036: no duplicate title/summary; why label ---
{
  const html = renderPickCard({
    category: "AI",
    summary: "同じテキスト",
    text: "同じテキスト",
    reason: "",
    importance: 3,
    url: "https://x.com/u/status/1",
  });
  assert.ok(html.includes("card__title"));
  assert.ok(!html.includes("card__summary"));
  assert.ok(!html.includes("card__body"));

  const html2 = renderPickCard({
    category: "AI",
    summary: "要約だけ",
    text: "まったく異なる本文です",
    reason: "理由あり",
    importance: null,
    url: "https://x.com/u/status/2",
  });
  assert.ok(html2.includes("card__title"));
  assert.ok(html2.includes("card__summary"));
  assert.ok(html2.includes("注目した理由"));
  assert.ok(html2.includes("card__why-text"));
  assert.ok(html2.includes("Xで読む ↗"));
  assert.ok(!html2.includes("card__body"));
  assert.ok(!html2.includes("card__reason"));
  assert.ok(!html2.includes("重要度"));
  console.log("EP028 no-double-text PASS");
}

// --- EP-028: --min-importance respected ---
{
  const root = tmpDir("digest-reader-minimp-");
  const result = buildDigestReader({
    rootDir: root,
    outputDir: path.join(root, "out"),
    posts: [
      {
        postedAt: "2026-07-14T10:00:00.000Z",
        url: "https://x.com/u/status/low",
        text: "low",
        finalAnalysis: { category: "AI" },
        enrichment: {
          importance: 2,
          summary: "低重要度だが長い要約テキストです。",
          reason: "r",
        },
      },
      {
        postedAt: "2026-07-14T11:00:00.000Z",
        url: "https://x.com/u/status/high",
        text: "high",
        finalAnalysis: { category: "日常・雑談" },
        enrichment: {
          importance: 4,
          summary: "高重要度の要約テキストです。",
          reason: "r",
        },
      },
    ],
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: dayOptions({ top: 5, minImportance: 4 }),
  });
  assert.strictEqual(result.digest.total, 1);
  assert.ok(result.digest.todaysPicks.every((p) => p.url.includes("high")));
  assert.ok(result.summary.picksCount >= 1);
  console.log("EP028 min-importance PASS");
}

// --- EP-036: more-read CTA with dynamic count ---
{
  const root = tmpDir("digest-reader-more-");
  const posts = [];
  for (let i = 0; i < 8; i++) {
    posts.push({
      authorName: `U${i}`,
      authorHandle: `@u${i}`,
      postedAt: `2026-07-14T0${i}:30:00.000Z`,
      text: `post ${i} long enough summary text`,
      url: `https://x.com/u/status/${100 + i}`,
      finalAnalysis: { category: "AI", tags: ["AI"] },
      enrichment: {
        importance: 4,
        summary: `AI要約 ${i} です。詳細な内容の要約テキスト。`,
        reason: "注目理由",
        tags: [],
      },
    });
  }
  const result = buildDigestReader({
    rootDir: root,
    outputDir: path.join(root, "out"),
    posts,
    config: mergeDigestConfig({
      ...DEFAULT_DIGEST_CONFIG,
      categoryDisplayLimit: 3,
    }),
    digestOptions: dayOptions({ top: 2 }),
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(/さらに5件読む →/.test(html));
  assert.ok(html.includes('class="more-read"'));
  assert.ok(html.includes('href="#category-digest"'));
  assert.ok(!html.includes("ほか "));
  assert.ok(html.includes("Xで読む ↗"));
  console.log("EP036 more-read PASS");
}

console.log("digest-reader-test: ALL PASS");
