/**
 * EP-011 — Daily Edition HTML preview tests.
 * Run: node test/daily-edition-html-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildDailyEditionHtml,
} = require("../lib/daily-edition-html");
const { markdownToHtml, escapeHtml } = require("../lib/edition-markdown-html");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function seedWork(workDir, stories) {
  const edition = {
    version: "1.0",
    edition: { top: [], secondary: [], brief: [] },
    summary: {
      articleCount: 0,
      sectionCounts: { top: 0, secondary: 0, brief: 0 },
      warningsCount: 0,
    },
    warnings: [],
    legacyPrimaryArticlePath: null,
    legacyPrimaryReportPath: null,
  };

  for (const s of stories) {
    const aRel = s.articlePath || `articles/${s.id}.md`;
    const rRel = s.reportPath || `article-reports/${s.id}.report.json`;
    if (s.writeArticle !== false) {
      write(
        path.join(workDir, aRel),
        s.markdown ||
          `# ${s.title || s.id}\n\nリード文です。\n\n## 何が起きたか\n\n本文 ${s.id}。\n`
      );
    }
    if (s.writeReport !== false) {
      write(
        path.join(workDir, rRel),
        `${JSON.stringify(
          s.report || {
            id: `report-${s.id}`,
            generatedAt: "2026-07-21T00:00:00.000Z",
            article: {
              title: s.title || s.id,
              actualLength: 100,
            },
            claims: { total: 1, usable: 1 },
            confidence: { average: 60 },
            reviewSummary: {
              status: s.status || "pass",
              errorCount: 0,
              warningCount: s.status === "warning" ? 1 : 0,
            },
            readyForAiRewrite: s.readyForAiRewrite !== false,
          },
          null,
          2
        )}\n`
      );
    }
    const entry = {
      storyId: s.id,
      position: s.position,
      section: s.section,
      rank: s.rank ?? s.position,
      score: s.score ?? 80,
      articlePath: aRel,
      reportPath: rRel,
      readyForAiRewrite: s.readyForAiRewrite !== false,
    };
    edition.edition[s.section].push(entry);
  }

  for (const section of ["top", "secondary", "brief"]) {
    edition.summary.sectionCounts[section] = edition.edition[section].length;
  }
  edition.summary.articleCount =
    edition.summary.sectionCounts.top +
    edition.summary.sectionCounts.secondary +
    edition.summary.sectionCounts.brief;
  if (stories[0]) {
    edition.legacyPrimaryArticlePath =
      stories[0].articlePath || `articles/${stories[0].id}.md`;
    edition.legacyPrimaryReportPath =
      stories[0].reportPath || `article-reports/${stories[0].id}.report.json`;
  }

  const editionPath = path.join(workDir, "daily-edition.json");
  write(editionPath, `${JSON.stringify(edition, null, 2)}\n`);
  return { editionPath, edition };
}

// --- markdown helpers ---
{
  assert.ok(markdownToHtml("# Hello\n\nWorld").includes("<h1>Hello</h1>"));
  assert.ok(markdownToHtml("# Hello\n\nWorld").includes("<p>World</p>"));
  assert.strictEqual(escapeHtml("<script>"), "&lt;script&gt;");
  assert.ok(
    markdownToHtml("[x](https://example.com)").includes(
      'href="https://example.com"'
    )
  );
  assert.ok(
    !markdownToHtml("[x](javascript:alert(1))").includes('href="javascript:')
  );
  console.log("Helpers PASS");
}

// --- Case 1: single top article ---
{
  const workDir = tmpDir("de-html-c1-");
  const outDir = path.join(workDir, "output", "edition");
  const { editionPath } = seedWork(workDir, [
    {
      id: "a",
      section: "top",
      position: 1,
      title: "Top Story",
    },
  ]);
  const result = buildDailyEditionHtml({
    edition: editionPath,
    outputDir: outDir,
    date: "2026-07-21",
  });
  assert.ok(fs.existsSync(result.htmlPath));
  assert.ok(fs.existsSync(result.cssPath));
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("Top Story"));
  assert.ok(html.includes('class="section section--top"'));
  assert.ok(html.includes("edition.css"));
  assert.ok(html.includes('name="color-scheme"'));
  console.log("Case1 PASS");
}

// --- Case 2: all sections ---
{
  const workDir = tmpDir("de-html-c2-");
  const outDir = path.join(workDir, "out");
  const { editionPath } = seedWork(workDir, [
    { id: "a", section: "top", position: 1, title: "A" },
    { id: "b", section: "secondary", position: 2, title: "B" },
    { id: "c", section: "secondary", position: 3, title: "C" },
    { id: "d", section: "brief", position: 4, title: "D" },
    { id: "e", section: "brief", position: 5, title: "E" },
  ]);
  const result = buildDailyEditionHtml({
    edition: editionPath,
    outputDir: outDir,
    date: "2026-07-21",
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes(">A<") || html.includes("A</h2>"));
  assert.ok(html.includes("B</h2>") || html.includes(">B<"));
  assert.ok(html.includes('section--secondary'));
  assert.ok(html.includes('section--brief'));
  assert.ok(html.includes("5 articles") || html.includes(">5<"));
  console.log("Case2 PASS");
}

// --- Case 3: report info rendered ---
{
  const workDir = tmpDir("de-html-c3-");
  const outDir = path.join(workDir, "out");
  const { editionPath } = seedWork(workDir, [
    {
      id: "a",
      section: "top",
      position: 1,
      title: "Report Story",
      status: "warning",
      readyForAiRewrite: true,
    },
  ]);
  const result = buildDailyEditionHtml({
    edition: editionPath,
    outputDir: outDir,
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("warning"));
  assert.ok(html.includes("readyForAiRewrite"));
  assert.ok(html.includes("rewrite-ready") || html.includes("true"));
  assert.ok(html.includes("story__report"));
  console.log("Case3 PASS");
}

// --- Case 4: missing article → warning, page still built ---
{
  const workDir = tmpDir("de-html-c4-");
  const outDir = path.join(workDir, "out");
  const { editionPath } = seedWork(workDir, [
    {
      id: "missing",
      section: "top",
      position: 1,
      title: "Missing",
      writeArticle: false,
    },
  ]);
  const result = buildDailyEditionHtml({
    edition: editionPath,
    outputDir: outDir,
  });
  assert.ok(result.warnings.some((w) => w.code === "article-file-not-found"));
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("記事ファイルが見つかりません"));
  console.log("Case4 PASS");
}

// --- Case 5: empty edition ---
{
  const workDir = tmpDir("de-html-c5-");
  const outDir = path.join(workDir, "out");
  const { editionPath } = seedWork(workDir, []);
  const result = buildDailyEditionHtml({
    edition: editionPath,
    outputDir: outDir,
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("掲載記事はありません"));
  assert.ok(fs.existsSync(result.cssPath));
  console.log("Case5 PASS");
}

// --- Case 6: metadata footer ---
{
  const workDir = tmpDir("de-html-c6-");
  const outDir = path.join(workDir, "out");
  const { editionPath } = seedWork(workDir, [
    { id: "a", section: "top", position: 1, title: "Meta" },
  ]);
  const result = buildDailyEditionHtml({
    edition: editionPath,
    outputDir: outDir,
    date: "2026-07-21",
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes("Edition Metadata"));
  assert.ok(html.includes("legacyPrimaryArticlePath"));
  assert.ok(html.includes("2026-07-21"));
  assert.ok(html.includes("articleCount"));
  console.log("Case6 PASS");
}

// --- Case 7: dark mode + responsive CSS present ---
{
  const workDir = tmpDir("de-html-c7-");
  const outDir = path.join(workDir, "out");
  const { editionPath } = seedWork(workDir, [
    { id: "a", section: "top", position: 1 },
  ]);
  const result = buildDailyEditionHtml({
    edition: editionPath,
    outputDir: outDir,
  });
  const css = fs.readFileSync(result.cssPath, "utf8");
  assert.ok(css.includes("prefers-color-scheme: dark"));
  assert.ok(css.includes("@media (max-width"));
  assert.ok(css.includes("@media (min-width"));
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes('name="viewport"'));
  console.log("Case7 PASS");
}

// --- Case 8: deterministic ---
{
  const workDir = tmpDir("de-html-c8-");
  const outA = path.join(workDir, "a");
  const outB = path.join(workDir, "b");
  const { editionPath } = seedWork(workDir, [
    { id: "a", section: "top", position: 1, title: "Det" },
    { id: "b", section: "brief", position: 2, title: "Det2" },
  ]);
  const a = buildDailyEditionHtml({
    edition: editionPath,
    outputDir: outA,
    date: "2026-07-21",
    title: "Daily Edition",
  });
  const b = buildDailyEditionHtml({
    edition: editionPath,
    outputDir: outB,
    date: "2026-07-21",
    title: "Daily Edition",
  });
  assert.strictEqual(a.html, b.html);
  console.log("Case8 PASS");
}

// --- Case 9: HTML escapes dangerous content ---
{
  const workDir = tmpDir("de-html-c9-");
  const outDir = path.join(workDir, "out");
  const { editionPath } = seedWork(workDir, [
    {
      id: "xss",
      section: "top",
      position: 1,
      title: '<script>alert(1)</script>',
      markdown:
        '# <script>alert(1)</script>\n\n<script>alert(2)</script>\n\nSafe text.\n',
    },
  ]);
  const result = buildDailyEditionHtml({
    edition: editionPath,
    outputDir: outDir,
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  console.log("Case9 PASS");
}

// --- Case 10: relative CSS for GitHub Pages ---
{
  const workDir = tmpDir("de-html-c10-");
  const outDir = path.join(workDir, "out");
  const { editionPath } = seedWork(workDir, [
    { id: "a", section: "top", position: 1 },
  ]);
  const result = buildDailyEditionHtml({
    edition: editionPath,
    outputDir: outDir,
  });
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(html.includes('href="edition.css"'));
  assert.ok(!html.includes("file://"));
  assert.ok(!/#\{/.test(html)); // no template engine leftovers
  console.log("Case10 PASS");
}

console.log("All daily-edition-html tests PASS");
