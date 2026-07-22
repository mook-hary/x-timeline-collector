/**
 * EP-012 — Edition Archive Builder tests.
 * Run: node test/edition-archive-builder-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildEditionArchive,
  sanitizeEditionId,
  resolveSafeUnderRoot,
} = require("../lib/edition-archive-builder");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function seedFixture(root, {
  editionDate = "2026-07-22",
  stories = [],
  html = null,
  css = null,
  editionExtra = {},
} = {}) {
  const workDir = path.join(root, "work");
  const outputDir = path.join(root, "output");
  const previewDir = path.join(outputDir, "edition");
  ensure(workDir);
  ensure(previewDir);

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
    legacyPrimaryArticlePath: null,
    legacyPrimaryReportPath: null,
    ...editionExtra,
  };

  for (const s of stories) {
    const aRel = s.articlePath || `articles/${s.file || `${s.id}.md`}`;
    const rRel =
      s.reportPath || `article-reports/${s.file || `${s.id}.report.json`}`.replace(
        /\.md$/,
        ".report.json"
      );
    // normalize report default
    const reportRel =
      s.reportPath ||
      `article-reports/${path.basename(aRel).replace(/\.md$/, "")}.report.json`;

    if (s.writeArticle !== false) {
      write(
        path.join(workDir, aRel),
        s.markdown || `# ${s.title || s.id}\n\nbody ${s.id}\n`
      );
    }
    if (s.writeReport !== false) {
      write(
        path.join(workDir, reportRel),
        `${JSON.stringify({ id: `r-${s.id}`, readyForAiRewrite: true }, null, 2)}\n`
      );
    }
    edition.edition[s.section].push({
      storyId: s.id,
      position: s.position,
      section: s.section,
      rank: s.rank ?? s.position,
      score: s.score ?? 80,
      articlePath: aRel,
      reportPath: reportRel,
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
  if (stories[0]) {
    const first = edition.edition[stories[0].section][0];
    edition.legacyPrimaryArticlePath = first.articlePath;
    edition.legacyPrimaryReportPath = first.reportPath;
  }

  const editionPath = path.join(workDir, "daily-edition.json");
  write(editionPath, `${JSON.stringify(edition, null, 2)}\n`);

  const htmlPath = path.join(previewDir, "index.html");
  const cssPath = path.join(previewDir, "edition.css");
  write(
    htmlPath,
    html ||
      `<!DOCTYPE html><html><head><link rel="stylesheet" href="edition.css"><title>Daily Edition</title></head><body>
${stories
  .map(
    (s) => {
      const a =
        s.articlePath ||
        `articles/${s.file || `${s.id}.md`}`;
      const r =
        s.reportPath ||
        `article-reports/${path.basename(a).replace(/\.md$/, "")}.report.json`;
      return `<dt>articlePath</dt><dd>${a}</dd><dt>reportPath</dt><dd>${r}</dd>`;
    }
  )
  .join("\n")}
</body></html>`
  );
  write(cssPath, css || "body{color:#111}\n");

  return {
    workDir,
    outputDir,
    editionPath,
    htmlPath,
    cssPath,
    edition,
  };
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listArchiveDirs(archiveRoot) {
  if (!fs.existsSync(archiveRoot)) return [];
  return fs
    .readdirSync(archiveRoot)
    .filter((name) => !name.startsWith("."))
    .filter((name) =>
      fs.statSync(path.join(archiveRoot, name)).isDirectory()
    );
}

// --- sanitize ---
{
  assert.strictEqual(sanitizeEditionId("2026-07-22"), "2026-07-22");
  assert.strictEqual(sanitizeEditionId("../etc"), null);
  assert.strictEqual(sanitizeEditionId("2026-07-22-final"), null);
  assert.strictEqual(sanitizeEditionId("2026-07-22T12:00:00Z"), null);
  console.log("Sanitize PASS");
}

// --- Case 1: Single article ---
{
  const root = tmpDir("arc-c1-");
  const fx = seedFixture(root, {
    stories: [
      {
        id: "a",
        section: "top",
        position: 1,
        file: "01-a.md",
        title: "A",
      },
    ],
  });
  const result = buildEditionArchive({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    htmlPath: fx.htmlPath,
    cssPath: fx.cssPath,
    outputRoot: fx.outputDir,
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  assert.strictEqual(result.editionId, "2026-07-22");
  assert.ok(fs.existsSync(path.join(result.archiveDir, "index.html")));
  assert.ok(fs.existsSync(path.join(result.archiveDir, "edition.css")));
  assert.ok(fs.existsSync(path.join(result.archiveDir, "daily-edition.json")));
  assert.ok(fs.existsSync(path.join(result.archiveDir, "archive-manifest.json")));
  assert.ok(
    fs.existsSync(path.join(result.archiveDir, "articles", "01-a.md"))
  );
  assert.ok(
    fs.existsSync(
      path.join(result.archiveDir, "article-reports", "01-a.report.json")
    )
  );
  assert.strictEqual(result.manifest.summary.articleCount, 1);
  assert.strictEqual(result.manifest.summary.reportCount, 1);
  console.log("Case1 PASS");
}

// --- Case 2: Multiple sections; unpublished not copied ---
{
  const root = tmpDir("arc-c2-");
  const workDir = path.join(root, "work");
  ensure(workDir);
  // unpublished article sitting in work dir
  write(path.join(workDir, "articles", "99-skip.md"), "# skip\n");
  write(
    path.join(workDir, "article-reports", "99-skip.report.json"),
    "{}\n"
  );
  const fx = seedFixture(root, {
    stories: [
      { id: "a", section: "top", position: 1, file: "01-a.md" },
      { id: "b", section: "secondary", position: 2, file: "02-b.md" },
      { id: "c", section: "brief", position: 3, file: "03-c.md" },
    ],
  });
  // re-write unpublished into same work
  write(path.join(fx.workDir, "articles", "99-skip.md"), "# skip\n");
  write(
    path.join(fx.workDir, "article-reports", "99-skip.report.json"),
    "{}\n"
  );
  const result = buildEditionArchive({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    htmlPath: fx.htmlPath,
    cssPath: fx.cssPath,
    outputRoot: fx.outputDir,
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  assert.strictEqual(result.manifest.summary.articleCount, 3);
  assert.ok(
    !fs.existsSync(path.join(result.archiveDir, "articles", "99-skip.md"))
  );
  const archived = JSON.parse(
    fs.readFileSync(path.join(result.archiveDir, "daily-edition.json"), "utf8")
  );
  assert.strictEqual(archived.edition.top[0].storyId, "a");
  assert.strictEqual(archived.edition.secondary[0].storyId, "b");
  assert.strictEqual(archived.edition.brief[0].storyId, "c");
  console.log("Case2 PASS");
}

// --- Case 3: Missing article ---
{
  const root = tmpDir("arc-c3-");
  const fx = seedFixture(root, {
    stories: [
      {
        id: "a",
        section: "top",
        position: 1,
        file: "01-a.md",
        writeArticle: false,
      },
    ],
  });
  const result = buildEditionArchive({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    htmlPath: fx.htmlPath,
    cssPath: fx.cssPath,
    outputRoot: fx.outputDir,
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  assert.ok(
    result.warnings.some((w) => w.code === "article-file-not-found")
  );
  assert.strictEqual(result.manifest.summary.articleCount, 0);
  assert.strictEqual(result.manifest.summary.reportCount, 1);
  assert.ok(fs.existsSync(path.join(result.archiveDir, "index.html")));
  console.log("Case3 PASS");
}

// --- Case 4: Missing report ---
{
  const root = tmpDir("arc-c4-");
  const fx = seedFixture(root, {
    stories: [
      {
        id: "a",
        section: "top",
        position: 1,
        file: "01-a.md",
        writeReport: false,
      },
    ],
  });
  const result = buildEditionArchive({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    htmlPath: fx.htmlPath,
    cssPath: fx.cssPath,
    outputRoot: fx.outputDir,
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  assert.ok(
    result.warnings.some((w) => w.code === "report-file-not-found")
  );
  assert.strictEqual(result.manifest.summary.articleCount, 1);
  assert.strictEqual(result.manifest.summary.reportCount, 0);
  console.log("Case4 PASS");
}

// --- Case 5: Empty edition ---
{
  const root = tmpDir("arc-c5-");
  const fx = seedFixture(root, { stories: [] });
  const result = buildEditionArchive({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    htmlPath: fx.htmlPath,
    cssPath: fx.cssPath,
    outputRoot: fx.outputDir,
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  assert.strictEqual(result.manifest.summary.articleCount, 0);
  assert.strictEqual(result.manifest.summary.reportCount, 0);
  assert.ok(fs.existsSync(path.join(result.archiveDir, "articles")));
  assert.ok(fs.existsSync(path.join(result.archiveDir, "article-reports")));
  console.log("Case5 PASS");
}

// --- Case 6: Invalid daily edition ---
{
  const root = tmpDir("arc-c6-");
  const fx = seedFixture(root, { stories: [] });
  write(fx.editionPath, "[1,2,3]\n");
  let threw = false;
  try {
    buildEditionArchive({
      edition: fx.editionPath,
      workRoot: fx.workDir,
      htmlPath: fx.htmlPath,
      cssPath: fx.cssPath,
      outputRoot: fx.outputDir,
    });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.code, "edition-invalid");
  }
  assert.ok(threw);
  assert.deepStrictEqual(listArchiveDirs(path.join(fx.outputDir, "archive")), []);
  console.log("Case6 PASS");
}

// --- Case 7: Missing HTML / CSS ---
{
  const root = tmpDir("arc-c7-");
  const fx = seedFixture(root, {
    stories: [{ id: "a", section: "top", position: 1, file: "01-a.md" }],
  });
  fs.unlinkSync(fx.htmlPath);
  let threwHtml = false;
  try {
    buildEditionArchive({
      edition: fx.editionPath,
      workRoot: fx.workDir,
      htmlPath: fx.htmlPath,
      cssPath: fx.cssPath,
      outputRoot: fx.outputDir,
    });
  } catch (e) {
    threwHtml = true;
    assert.strictEqual(e.code, "html-missing");
  }
  assert.ok(threwHtml);

  // restore html, remove css
  write(fx.htmlPath, "<html></html>\n");
  fs.unlinkSync(fx.cssPath);
  let threwCss = false;
  try {
    buildEditionArchive({
      edition: fx.editionPath,
      workRoot: fx.workDir,
      htmlPath: fx.htmlPath,
      cssPath: fx.cssPath,
      outputRoot: fx.outputDir,
    });
  } catch (e) {
    threwCss = true;
    assert.strictEqual(e.code, "css-missing");
  }
  assert.ok(threwCss);
  assert.deepStrictEqual(listArchiveDirs(path.join(fx.outputDir, "archive")), []);
  console.log("Case7 PASS");
}

// --- Case 8: Idempotent rebuild ---
{
  const root = tmpDir("arc-c8-");
  const fx = seedFixture(root, {
    stories: [{ id: "a", section: "top", position: 1, file: "01-a.md" }],
  });
  const opts = {
    edition: fx.editionPath,
    workRoot: fx.workDir,
    htmlPath: fx.htmlPath,
    cssPath: fx.cssPath,
    outputRoot: fx.outputDir,
    createdAt: "2026-07-22T00:00:00.000Z",
  };
  const first = buildEditionArchive(opts);
  write(path.join(first.archiveDir, "stale-leftover.txt"), "old\n");
  // change article content and rebuild
  write(
    path.join(fx.workDir, "articles", "01-a.md"),
    "# Updated\n\nnew body\n"
  );
  write(fx.htmlPath, "<html><body>updated preview</body></html>\n");
  const second = buildEditionArchive({
    ...opts,
    createdAt: "2026-07-22T01:00:00.000Z",
  });
  assert.strictEqual(first.archiveDir, second.archiveDir);
  assert.deepStrictEqual(listArchiveDirs(path.join(fx.outputDir, "archive")), [
    "2026-07-22",
  ]);
  assert.ok(!fs.existsSync(path.join(second.archiveDir, "stale-leftover.txt")));
  const md = fs.readFileSync(
    path.join(second.archiveDir, "articles", "01-a.md"),
    "utf8"
  );
  assert.ok(md.includes("Updated"));
  const html = fs.readFileSync(
    path.join(second.archiveDir, "index.html"),
    "utf8"
  );
  assert.ok(html.includes("updated preview"));
  console.log("Case8 PASS");
}

// --- Case 9: Relative links ---
{
  const root = tmpDir("arc-c9-");
  const fx = seedFixture(root, {
    stories: [{ id: "a", section: "top", position: 1, file: "01-a.md" }],
  });
  const result = buildEditionArchive({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    htmlPath: fx.htmlPath,
    cssPath: fx.cssPath,
    outputRoot: fx.outputDir,
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  const html = fs.readFileSync(
    path.join(result.archiveDir, "index.html"),
    "utf8"
  );
  assert.ok(html.includes('href="edition.css"'));
  assert.ok(html.includes('href="articles/01-a.md"'));
  assert.ok(html.includes('href="article-reports/01-a.report.json"'));
  assert.ok(!html.includes(".pipeline-work"));
  const archived = JSON.parse(
    fs.readFileSync(path.join(result.archiveDir, "daily-edition.json"), "utf8")
  );
  assert.strictEqual(archived.edition.top[0].articlePath, "articles/01-a.md");
  assert.strictEqual(
    archived.edition.top[0].reportPath,
    "article-reports/01-a.report.json"
  );
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(result.archiveDir, "archive-manifest.json"),
      "utf8"
    )
  );
  const asJson = JSON.stringify(manifest);
  assert.ok(!path.isAbsolute(manifest.files.html));
  assert.ok(!asJson.includes(root));
  console.log("Case9 PASS");
}

// --- Case 10: Path traversal ---
{
  const root = tmpDir("arc-c10-");
  const fx = seedFixture(root, {
    stories: [{ id: "a", section: "top", position: 1, file: "01-a.md" }],
    editionExtra: { editionDate: "../evil" },
  });
  let threw = false;
  try {
    buildEditionArchive({
      edition: fx.editionPath,
      workRoot: fx.workDir,
      htmlPath: fx.htmlPath,
      cssPath: fx.cssPath,
      outputRoot: fx.outputDir,
      editionDate: "../evil",
    });
  } catch (e) {
    threw = true;
    assert.ok(
      e.code === "invalid-edition-id" || e.message.includes("editionId")
    );
  }
  assert.ok(threw);

  // entry path with ..
  const fx2 = seedFixture(root + "-b", {
    editionDate: "2026-07-22",
    stories: [
      {
        id: "evil",
        section: "top",
        position: 1,
        articlePath: "../outside.md",
        reportPath: "article-reports/ok.report.json",
        writeArticle: false,
        writeReport: true,
      },
    ],
  });
  // write report with basename path used above - seed may not write due to custom paths
  write(
    path.join(fx2.workDir, "article-reports", "ok.report.json"),
    "{}\n"
  );
  write(path.join(path.dirname(fx2.workDir), "outside.md"), "nope\n");
  const result = buildEditionArchive({
    edition: fx2.editionPath,
    workRoot: fx2.workDir,
    htmlPath: fx2.htmlPath,
    cssPath: fx2.cssPath,
    outputRoot: fx2.outputDir,
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  assert.ok(result.warnings.length >= 1);
  assert.ok(
    !fs.existsSync(path.join(result.archiveDir, "outside.md"))
  );
  assert.strictEqual(
    resolveSafeUnderRoot(fx2.workDir, "../outside.md"),
    null
  );
  console.log("Case10 PASS");
}

// --- Case 11: Determinism (excluding createdAt) ---
{
  const root = tmpDir("arc-c11-");
  const fx = seedFixture(root, {
    stories: [
      { id: "a", section: "top", position: 1, file: "01-a.md" },
      { id: "b", section: "brief", position: 2, file: "02-b.md" },
    ],
  });
  const a = buildEditionArchive({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    htmlPath: fx.htmlPath,
    cssPath: fx.cssPath,
    outputRoot: path.join(root, "out-a"),
    // copy preview into out-a/edition
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  // prepare second output root with same preview
  const outB = path.join(root, "out-b");
  ensure(path.join(outB, "edition"));
  fs.copyFileSync(fx.htmlPath, path.join(outB, "edition", "index.html"));
  fs.copyFileSync(fx.cssPath, path.join(outB, "edition", "edition.css"));
  const b = buildEditionArchive({
    edition: fx.editionPath,
    workRoot: fx.workDir,
    htmlPath: path.join(outB, "edition", "index.html"),
    cssPath: path.join(outB, "edition", "edition.css"),
    outputRoot: outB,
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  const files = ["index.html", "edition.css", "daily-edition.json"];
  for (const f of files) {
    assert.strictEqual(
      fs.readFileSync(path.join(a.archiveDir, f), "utf8"),
      fs.readFileSync(path.join(b.archiveDir, f), "utf8")
    );
  }
  const ma = JSON.parse(
    fs.readFileSync(path.join(a.archiveDir, "archive-manifest.json"), "utf8")
  );
  const mb = JSON.parse(
    fs.readFileSync(path.join(b.archiveDir, "archive-manifest.json"), "utf8")
  );
  delete ma.createdAt;
  delete mb.createdAt;
  assert.deepStrictEqual(ma, mb);
  console.log("Case11 PASS");
}

console.log("All edition-archive-builder tests PASS");
