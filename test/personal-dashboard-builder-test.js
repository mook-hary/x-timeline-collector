/**
 * EP-013 — Personal Dashboard builder tests.
 * Run: node test/personal-dashboard-builder-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildPersonalDashboard,
  extractArticleTitle,
  extractArticleSummary,
  selectTodaysPick,
  selectReadNext,
  buildTopics,
  safeHref,
} = require("../lib/personal-dashboard-builder");
const { DASHBOARD_CSS } = require("../lib/personal-dashboard-css");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function seed(root, {
  stories = [],
  editionDate = "2026-07-22",
  archives = [],
  writeLatestHtml = true,
  editionExtra = {},
} = {}) {
  const workDir = path.join(root, "work");
  const outputDir = path.join(root, "output");
  const previewDir = path.join(outputDir, "edition");
  const archiveRoot = path.join(outputDir, "archive");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(previewDir, { recursive: true });
  fs.mkdirSync(archiveRoot, { recursive: true });

  const edition = {
    version: "1.0",
    editionDate,
    edition: { top: [], secondary: [], brief: [] },
    summary: {
      articleCount: 0,
      sectionCounts: { top: 0, secondary: 0, brief: 0 },
      warningsCount: 0,
    },
    warnings: [],
    ...editionExtra,
  };

  for (const s of stories) {
    const aRel = s.articlePath || `articles/${s.file || `${s.id}.md`}`;
    const rRel =
      s.reportPath ||
      `article-reports/${path.basename(aRel).replace(/\.md$/, "")}.report.json`;
    if (s.writeArticle !== false) {
      write(
        path.join(workDir, aRel),
        s.markdown ||
          `# ${s.title || s.id}\n\n${s.body || `本文 ${s.id} の要約段落です。`}\n`
      );
    }
    if (s.writeReport !== false) {
      write(
        path.join(workDir, rRel),
        `${JSON.stringify(
          {
            id: `r-${s.id}`,
            article: {
              title: s.reportTitle,
              summary: s.reportSummary,
            },
            category: s.category,
            topics: s.topics,
            tags: s.tags,
          },
          null,
          2
        )}\n`
      );
    }
    edition.edition[s.section].push({
      storyId: s.id,
      position: s.position,
      section: s.section,
      rank: s.rank ?? s.position,
      score: s.score ?? 80,
      articlePath: aRel,
      reportPath: rRel,
      title: s.metaTitle,
      summary: s.metaSummary,
      category: s.entryCategory,
      topics: s.entryTopics,
      tags: s.entryTags,
      readyForAiRewrite: true,
    });
  }

  for (const section of ["top", "secondary", "brief"]) {
    edition.summary.sectionCounts[section] = edition.edition[section].length;
  }
  edition.summary.articleCount =
    edition.summary.sectionCounts.top +
    edition.summary.sectionCounts.secondary +
    edition.summary.sectionCounts.brief;

  const editionPath = path.join(workDir, "daily-edition.json");
  write(editionPath, `${JSON.stringify(edition, null, 2)}\n`);

  const latestHtmlPath = path.join(previewDir, "index.html");
  if (writeLatestHtml) {
    write(
      latestHtmlPath,
      `<!DOCTYPE html><html><body>${stories
        .map((s) => `<article id="story-${s.id}"></article>`)
        .join("")}</body></html>\n`
    );
    write(path.join(previewDir, "edition.css"), "body{}\n");
  }

  for (const a of archives) {
    const dir = path.join(archiveRoot, a.editionId || a.editionDate);
    write(
      path.join(dir, "archive-manifest.json"),
      a.raw ||
        `${JSON.stringify(
          {
            version: "1.0",
            editionId: a.editionId || a.editionDate,
            editionDate: a.editionDate,
            createdAt: "2026-07-22T00:00:00.000Z",
            source: {
              dailyEditionPath: "daily-edition.json",
              htmlPath: "index.html",
              cssPath: "edition.css",
            },
            files: {
              html: "index.html",
              css: "edition.css",
              dailyEdition: "daily-edition.json",
              articles: [],
              reports: [],
            },
            summary: {
              articleCount: a.articleCount ?? 1,
              reportCount: a.articleCount ?? 1,
              missingArticleCount: 0,
              missingReportCount: 0,
              warningsCount: a.warningsCount ?? 0,
            },
            warnings: [],
          },
          null,
          2
        )}\n`
    );
    if (a.skipHtml) continue;
    write(path.join(dir, "index.html"), "<html></html>\n");
  }

  return {
    workDir,
    outputDir,
    editionPath,
    latestHtmlPath,
    archiveRoot,
    edition,
  };
}

// --- helpers ---
{
  assert.strictEqual(
    extractArticleTitle({
      entry: {},
      markdown: "",
      metadata: { title: "Meta Title" },
    }),
    "Meta Title"
  );
  assert.strictEqual(
    extractArticleTitle({
      entry: {},
      markdown: "# Heading One\n\nbody\n",
    }),
    "Heading One"
  );
  assert.strictEqual(
    extractArticleTitle({
      entry: {},
      markdown: "First line plain\n\nmore\n",
    }),
    "First line plain"
  );
  assert.strictEqual(
    extractArticleTitle({ entry: { storyId: "sid" }, markdown: "" }),
    "sid"
  );
  assert.strictEqual(extractArticleTitle({ entry: {}, markdown: "" }), "Untitled");
  assert.ok(
    !extractArticleSummary({
      markdown: "# T\n\n**Bold** paragraph here.\n",
      maxLen: 80,
    }).includes("**")
  );
  assert.strictEqual(safeHref("javascript:alert(1)"), null);
  assert.strictEqual(safeHref("../etc/passwd"), null);
  assert.ok(safeHref("edition/index.html#story-a"));
  console.log("Helpers PASS");
}

// --- Case 1: Single article ---
{
  const root = tmpDir("dash-c1-");
  const fx = seed(root, {
    stories: [
      {
        id: "a",
        section: "top",
        position: 1,
        file: "01-a.md",
        title: "Only Story",
        body: "これは唯一の記事のリードです。",
      },
    ],
  });
  const result = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    archiveRoot: fx.archiveRoot,
    latestHtmlPath: fx.latestHtmlPath,
  });
  assert.ok(fs.existsSync(result.htmlPath));
  assert.ok(fs.existsSync(result.cssPath));
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("Only Story"));
  assert.ok(html.includes("Today’s Pick"));
  assert.ok(html.includes("今日の号を読む"));
  assert.ok(html.includes('href="edition/index.html"'));
  assert.ok(html.includes("次に読む記事はまだありません"));
  assert.ok(!html.includes("storyId"));
  assert.ok(!html.includes("articlePath"));
  console.log("Case1 PASS");
}

// --- Case 2: Multiple articles ---
{
  const root = tmpDir("dash-c2-");
  const stories = [];
  for (let i = 1; i <= 6; i += 1) {
    stories.push({
      id: `s${i}`,
      section: i === 1 ? "top" : i <= 3 ? "secondary" : "brief",
      position: i,
      file: `0${i}-s${i}.md`,
      title: `Story ${i}`,
      body: `要約 ${i}`,
    });
  }
  const fx = seed(root, { stories });
  const result = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    latestHtmlPath: fx.latestHtmlPath,
  });
  assert.strictEqual(result.summary.todayCount, 1);
  assert.strictEqual(result.summary.readNextCount, 5);
  assert.strictEqual(result.model.pick.title, "Story 1");
  assert.deepStrictEqual(
    result.model.readNext.map((c) => c.title),
    ["Story 2", "Story 3", "Story 4", "Story 5", "Story 6"]
  );
  console.log("Case2 PASS");
}

// --- Case 3: All sections pick rule ---
{
  const entries = [
    { section: "brief", storyId: "b" },
    { section: "secondary", storyId: "s" },
    { section: "top", storyId: "t" },
  ];
  // flatten order doesn't matter for selectTodaysPick — it searches by section priority
  const pick = selectTodaysPick(entries);
  assert.strictEqual(pick.storyId, "t");
  const next = selectReadNext(entries, pick);
  assert.deepStrictEqual(
    next.map((e) => e.storyId),
    ["s", "b"]
  );

  const root = tmpDir("dash-c3-");
  const fx = seed(root, {
    stories: [
      { id: "b", section: "brief", position: 3, title: "Brief" },
      { id: "s", section: "secondary", position: 2, title: "Secondary" },
      { id: "t", section: "top", position: 1, title: "Top" },
    ],
  });
  // seed pushes in array order into sections — ok
  const result = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    latestHtmlPath: fx.latestHtmlPath,
  });
  assert.strictEqual(result.model.pick.title, "Top");
  assert.deepStrictEqual(
    result.model.readNext.map((c) => c.title),
    ["Secondary", "Brief"]
  );
  console.log("Case3 PASS");
}

// --- Case 4: Title extraction order ---
{
  assert.strictEqual(
    extractArticleTitle({
      entry: { title: "Entry Title", storyId: "x" },
      markdown: "# MD\n",
      metadata: { title: "Report Title" },
    }),
    "Report Title"
  );
  assert.strictEqual(
    extractArticleTitle({
      entry: { title: "Entry Title" },
      markdown: "# MD\n",
    }),
    "Entry Title"
  );
  console.log("Case4 PASS");
}

// --- Case 5: Topics ---
{
  const cards = [
    {
      entry: { section: "top", category: "AI" },
      report: { topics: ["Animation"] },
    },
    {
      entry: { section: "secondary", tags: ["AI", "Animation"] },
      report: null,
    },
    { entry: { section: "brief" }, report: { category: "Game Development" } },
  ];
  const topics = buildTopics(cards);
  assert.ok(topics.length <= 8);
  const ai = topics.find((t) => t.name === "AI");
  assert.ok(ai && ai.count === 2);
  // no body guessing — only provided labels
  assert.ok(!topics.some((t) => /推測/.test(t.name)));

  // other-only → section fallback
  const otherOnly = buildTopics([
    { entry: { section: "top", category: "other" }, report: null },
    { entry: { section: "brief", category: "other" }, report: null },
  ]);
  assert.ok(otherOnly.some((t) => t.name === "Top"));
  assert.ok(otherOnly.some((t) => t.name === "Brief"));
  console.log("Case5 PASS");
}

// --- Case 6: Recent editions ---
{
  const root = tmpDir("dash-c6-");
  const fx = seed(root, {
    stories: [
      { id: "a", section: "top", position: 1, title: "A", body: "a" },
    ],
    archives: [
      { editionDate: "2026-07-20", editionId: "2026-07-20", articleCount: 2 },
      { editionDate: "2026-07-22", editionId: "2026-07-22", articleCount: 1 },
      { editionDate: "2026-07-21", editionId: "2026-07-21", articleCount: 3 },
    ],
  });
  const result = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    archiveRoot: fx.archiveRoot,
    latestHtmlPath: fx.latestHtmlPath,
  });
  assert.deepStrictEqual(
    result.model.recent.map((e) => e.editionDate),
    ["2026-07-22", "2026-07-21", "2026-07-20"]
  );
  assert.ok(
    result.model.recent[0].href === "archive/2026-07-22/index.html"
  );
  console.log("Case6 PASS");
}

// --- Case 7: Invalid archive ---
{
  const root = tmpDir("dash-c7-");
  const fx = seed(root, {
    stories: [{ id: "a", section: "top", position: 1, title: "A" }],
    archives: [
      { editionDate: "2026-07-22", editionId: "2026-07-22" },
      {
        editionDate: "2026-07-21",
        editionId: "2026-07-21",
        raw: "{not-json",
      },
    ],
  });
  const result = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    archiveRoot: fx.archiveRoot,
    latestHtmlPath: fx.latestHtmlPath,
  });
  assert.strictEqual(result.model.recent.length, 1);
  assert.ok(
    result.warnings.some((w) => w.code === "archive-manifest-invalid")
  );
  assert.ok(fs.existsSync(result.htmlPath));
  console.log("Case7 PASS");
}

// --- Case 8: Empty today ---
{
  const root = tmpDir("dash-c8-");
  const fx = seed(root, {
    stories: [],
    archives: [
      { editionDate: "2026-07-21", editionId: "2026-07-21", articleCount: 4 },
    ],
  });
  const result = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    archiveRoot: fx.archiveRoot,
    latestHtmlPath: fx.latestHtmlPath,
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("今日の掲載記事はありません"));
  assert.ok(html.includes("2026-07-21"));
  console.log("Case8 PASS");
}

// --- Case 9: No archives ---
{
  const root = tmpDir("dash-c9-");
  const fx = seed(root, {
    stories: [{ id: "a", section: "top", position: 1, title: "Alive" }],
    archives: [],
  });
  const result = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    archiveRoot: fx.archiveRoot,
    latestHtmlPath: fx.latestHtmlPath,
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("保存された過去号はまだありません"));
  assert.ok(html.includes("Alive"));
  console.log("Case9 PASS");
}

// --- Case 10: Missing latest HTML ---
{
  const root = tmpDir("dash-c10-");
  const fx = seed(root, {
    stories: [{ id: "a", section: "top", position: 1, title: "NoHtml" }],
    writeLatestHtml: false,
  });
  const result = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    archiveRoot: fx.archiveRoot,
    latestHtmlPath: fx.latestHtmlPath,
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(!html.includes("今日の号を読む"));
  assert.ok(html.includes("NoHtml"));
  assert.ok(
    result.warnings.some((w) => w.code === "latest-html-missing")
  );
  console.log("Case10 PASS");
}

// --- Case 11: XSS ---
{
  const root = tmpDir("dash-c11-");
  const fx = seed(root, {
    stories: [
      {
        id: "xss",
        section: "top",
        position: 1,
        title: '<script>alert(1)</script>',
        markdown:
          '# <script>alert(1)</script>\n\n<script>alert(2)</script> body\n',
      },
    ],
  });
  const result = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    latestHtmlPath: fx.latestHtmlPath,
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("javascript:"));
  console.log("Case11 PASS");
}

// --- Case 12: Responsive / dark / focus / a11y ---
{
  assert.ok(DASHBOARD_CSS.includes("prefers-color-scheme: dark"));
  assert.ok(DASHBOARD_CSS.includes("@media (max-width"));
  assert.ok(DASHBOARD_CSS.includes("focus-visible"));
  assert.ok(DASHBOARD_CSS.includes("overflow-x: hidden"));
  assert.ok(DASHBOARD_CSS.includes("overflow-wrap"));
  assert.ok(DASHBOARD_CSS.includes("prefers-reduced-motion"));
  assert.ok(DASHBOARD_CSS.includes("--tap"));
  assert.ok(DASHBOARD_CSS.includes("min-height: var(--tap)"));
  console.log("Case12 PASS");
}

// --- Case 13: Determinism ---
{
  const root = tmpDir("dash-c13-");
  const fx = seed(root, {
    stories: [
      { id: "a", section: "top", position: 1, title: "A", body: "one" },
      { id: "b", section: "brief", position: 2, title: "B", body: "two" },
    ],
    archives: [
      { editionDate: "2026-07-21", editionId: "2026-07-21" },
      { editionDate: "2026-07-20", editionId: "2026-07-20" },
    ],
  });
  const a = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: path.join(root, "out-a"),
    archiveRoot: fx.archiveRoot,
    latestHtmlPath: fx.latestHtmlPath,
  });
  fs.mkdirSync(path.join(root, "out-b", "edition"), { recursive: true });
  fs.copyFileSync(
    fx.latestHtmlPath,
    path.join(root, "out-b", "edition", "index.html")
  );
  const b = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: path.join(root, "out-b"),
    archiveRoot: fx.archiveRoot,
    latestHtmlPath: path.join(root, "out-b", "edition", "index.html"),
  });
  assert.strictEqual(a.html, b.html);
  assert.strictEqual(a.css, b.css);
  console.log("Case13 PASS");
}

// --- EP-015 polish: page container / gutters ---
{
  assert.ok(DASHBOARD_CSS.includes("--max: 1120px"));
  assert.ok(DASHBOARD_CSS.includes("margin-inline: auto"));
  assert.ok(DASHBOARD_CSS.includes("--gutter: 16px"));
  assert.ok(DASHBOARD_CSS.includes("--gutter: 24px"));
  assert.ok(DASHBOARD_CSS.includes("--gutter: 32px"));
  assert.ok(DASHBOARD_CSS.includes("calc(100% - 2 * var(--gutter))"));
  console.log("PolishContainer PASS");
}

// --- EP-015: denser header / today / pick ---
{
  assert.ok(DASHBOARD_CSS.includes(".site-header"));
  assert.ok(/\.site-header\s*\{[^}]*padding:\s*1\.15rem/s.test(DASHBOARD_CSS));
  assert.ok(DASHBOARD_CSS.includes("card--today"));
  assert.ok(DASHBOARD_CSS.includes("flex-wrap: wrap"));
  assert.ok(DASHBOARD_CSS.includes(".pick__title"));
  assert.ok(DASHBOARD_CSS.includes("--measure"));
  assert.ok(DASHBOARD_CSS.includes("max-width: var(--measure)"));
  console.log("PolishDensity PASS");
}

// --- EP-015: empty compact + score hidden + topics wrap ---
{
  const root = tmpDir("dash-polish-");
  const fx = seed(root, {
    stories: [
      {
        id: "a",
        section: "top",
        position: 1,
        title: "Pick Story",
        score: 94,
        body: "summary text",
      },
    ],
  });
  const result = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    latestHtmlPath: fx.latestHtmlPath,
  });
  const html = result.html;
  assert.ok(!html.includes("score 94"));
  assert.ok(!/\bscore\b/i.test(html));
  assert.ok(html.includes("次に読む記事はまだありません"));
  assert.ok(DASHBOARD_CSS.includes(".empty"));
  assert.ok(/\.empty\s*\{[^}]*border:\s*0/s.test(DASHBOARD_CSS));
  assert.ok(DASHBOARD_CSS.includes("flex-wrap: wrap"));
  assert.ok(html.includes("archive/") || html.includes("保存された過去号"));
  assert.ok(html.includes('class="pick__title"'));
  assert.ok(html.includes('class="pick__summary"') || html.includes("Pick Story"));
  console.log("PolishScoreEmpty PASS");
}

// --- EP-015: site CSS sync ---
{
  const root = tmpDir("dash-site-sync-");
  const fx = seed(root, {
    stories: [{ id: "a", section: "top", position: 1, title: "Sync" }],
  });
  buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    latestHtmlPath: fx.latestHtmlPath,
  });
  const { buildSite } = require("../lib/site-builder");
  buildSite({
    outputRoot: fx.outputDir,
    siteRoot: path.join(root, "site"),
  });
  const outCss = fs.readFileSync(path.join(fx.outputDir, "dashboard.css"), "utf8");
  const siteCss = fs.readFileSync(path.join(root, "site", "dashboard.css"), "utf8");
  assert.strictEqual(outCss, siteCss);
  assert.ok(outCss.includes("--max: 1120px"));
  const siteHtml = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
  assert.ok(siteHtml.includes('href="dashboard.css"'));
  assert.ok(siteHtml.includes('rel="manifest"'));
  console.log("PolishSiteSync PASS");
}

// --- reader-facing: no internal dump ---
{
  const root = tmpDir("dash-rf-");
  const fx = seed(root, {
    stories: [{ id: "a", section: "top", position: 1, title: "Clean" }],
  });
  const result = buildPersonalDashboard({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    outputDir: fx.outputDir,
    latestHtmlPath: fx.latestHtmlPath,
  });
  const html = result.html;
  assert.ok(html.includes("<h1 class=\"site-header__title\">Personal Timeline</h1>"));
  assert.ok(!/EP-013/.test(html));
  assert.ok(!html.includes("readyForAiRewrite"));
  assert.ok(!html.includes("confidence"));
  assert.ok(html.includes('href="dashboard.css"'));
  assert.ok(!html.includes("fonts.googleapis.com"));
  console.log("ReaderFacing PASS");
}

console.log("All personal-dashboard-builder tests PASS");
