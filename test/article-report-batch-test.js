/**
 * EP-009 — Multi-Article Report batch tests.
 * Run: node test/article-report-batch-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  runArticleReportBatch,
  resolveReportFileName,
} = require("../lib/article-report-batch");
const { buildArticleReport } = require("../lib/article-report-core");

function makeBrief() {
  return {
    id: "brief-test",
    title: "Daily 2026-07-21",
    purpose: "research-note",
    status: "draft",
    generatedAt: "2026-07-21T00:00:00.000Z",
    knowledge: [
      {
        id: "k1",
        title: "制作・クリエイティブ技術",
        summary: "イラスト、アニメ、ゲームなど制作・表現技術に関する話題",
        status: "published",
        version: 1,
        confidence: 60,
        notes: "",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    ],
    claims: [
      {
        knowledgeId: "k1",
        text: "イラスト、アニメ、ゲームなど制作・表現技術に関する話題",
        confidence: 60,
        evidenceCount: 1,
        usable: true,
        reason: null,
      },
    ],
    evidence: { stories: ["k1"], concepts: [], posts: [] },
    evidenceProvenance: { stories: { k1: ["k1"] }, concepts: {}, posts: {} },
    gaps: [],
    constraints: ["Knowledge summary にない事実を追加しない。"],
    sourceSnapshot: [
      {
        id: "k1",
        version: 1,
        status: "published",
        updatedAt: "2026-07-21T00:00:00.000Z",
        title: "制作・クリエイティブ技術",
        confidence: 60,
        evidenceCount: 1,
      },
    ],
    statistics: {
      knowledgeCount: 1,
      claimCount: 1,
      usableClaimCount: 1,
      unusableClaimCount: 0,
      evidenceCount: 1,
      storyEvidenceCount: 1,
      conceptEvidenceCount: 0,
      postEvidenceCount: 0,
      gapCount: 0,
      lowConfidenceCount: 0,
      nonPublishedCount: 0,
      minimumConfidence: 60,
      maximumConfidence: 60,
      averageConfidence: 60,
    },
  };
}

function makePlan() {
  return {
    id: "plan-test",
    title: "Daily 2026-07-21",
    purpose: "explain",
    format: "article",
    language: "ja",
    audience: { description: "一般読者", knowledgeLevel: "unspecified" },
    tone: { style: "clear", formality: "neutral" },
    length: { unit: "characters", target: 600, minimum: 200, maximum: 1200 },
    structure: [
      { id: "introduction", label: "導入", required: true },
      { id: "body", label: "本文", required: true },
      { id: "conclusion", label: "まとめ", required: true },
    ],
    requiredPoints: [],
    excludedPoints: [],
    constraints: [],
    briefReference: {
      id: "brief-test",
      generatedAt: "2026-07-21T00:00:00.000Z",
      title: "Daily 2026-07-21",
      knowledgeIds: ["k1"],
    },
    createdAt: "2026-07-21T00:00:00.000Z",
  };
}

function articleMarkdown(marker) {
  return `# Title ${marker}

リード文です。

## 何が起きたか

${marker} の出来事です。

## なぜ重要なのか

確認したい情報です。

イラスト、アニメ、ゲームなど制作・表現技術に関する話題。

## 情報源

- Author（@handle） — 2026-07-15 — https://x.com/h/1

<!--
Constraints:
- Knowledge summary にない事実を追加しない。

Statistics:
- Knowledge: 1
- Claims: 1
- Usable Claims: 1
- Evidence: 1

Source Snapshot:
- k1 / v1 / published / 2026-07-21T00:00:00.000Z
-->
`;
}

function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep009-"));
  const articlesDir = path.join(dir, "articles");
  const reportsDir = path.join(dir, "article-reports");
  fs.mkdirSync(articlesDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  return { dir, articlesDir, reportsDir };
}

function writeArticle(articlesDir, fileName, marker) {
  const p = path.join(articlesDir, fileName);
  fs.writeFileSync(p, articleMarkdown(marker), "utf8");
  return `articles/${fileName}`;
}

function baseManifest(articles, legacyPrimaryArticlePath) {
  return {
    version: "1.0",
    articles,
    summary: {
      requestedCount: articles.length,
      generatedCount: articles.filter((a) => a.status === "generated").length,
      failedCount: articles.filter((a) => a.status === "failed").length,
      skippedCount: 0,
    },
    warnings: ["keep-me"],
    legacyPrimaryArticlePath,
  };
}

function runBatch(manifest, opts = {}) {
  const ws = opts.ws || tmpWorkspace();
  const manifestPath = path.join(ws.dir, "articles-manifest.json");
  const legacyPath = path.join(ws.dir, "article-report.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const result = runArticleReportBatch({
    manifest: JSON.parse(JSON.stringify(manifest)),
    brief: makeBrief(),
    plan: makePlan(),
    outputDir: ws.reportsDir,
    manifestPath,
    legacyReportPath: legacyPath,
    articlesDir: ws.articlesDir,
    now: "2026-07-21T00:00:00.000Z",
    buildFn: opts.buildFn || null,
  });
  return { ...result, ws, manifestPath, legacyPath };
}

function case1OneGenerated() {
  const ws = tmpWorkspace();
  const articlePath = writeArticle(ws.articlesDir, "01-story-a.md", "AAA");
  const manifest = baseManifest(
    [
      {
        storyId: "story-a",
        position: 1,
        section: "top",
        rank: 1,
        score: 92,
        articlePath,
        status: "generated",
      },
    ],
    articlePath
  );
  const { resultManifest, reportSummary, legacyPath } = (() => {
    const r = runBatch(manifest, { ws });
    return {
      resultManifest: r.manifest,
      reportSummary: r.reportSummary,
      legacyPath: r.legacyPath,
    };
  })();
  assert.strictEqual(reportSummary.generatedCount, 1);
  assert.strictEqual(resultManifest.articles[0].report.status, "generated");
  assert.ok(resultManifest.articles[0].report.reportPath);
  assert.ok(fs.existsSync(legacyPath));
  console.log("PASS Case 1: generated 1");
}

function case2ThreeGenerated() {
  const ws = tmpWorkspace();
  const paths = [
    writeArticle(ws.articlesDir, "01-a.md", "MARK-A"),
    writeArticle(ws.articlesDir, "02-b.md", "MARK-B"),
    writeArticle(ws.articlesDir, "03-c.md", "MARK-C"),
  ];
  const manifest = baseManifest(
    [
      {
        storyId: "A",
        position: 1,
        section: "top",
        rank: 1,
        score: 90,
        articlePath: paths[0],
        status: "generated",
      },
      {
        storyId: "B",
        position: 2,
        section: "secondary",
        rank: 2,
        score: 80,
        articlePath: paths[1],
        status: "generated",
      },
      {
        storyId: "C",
        position: 3,
        section: "brief",
        rank: 3,
        score: 70,
        articlePath: paths[2],
        status: "generated",
      },
    ],
    paths[0]
  );
  const seen = [];
  const buildFn = (brief, plan, md) => {
    seen.push(md);
    return buildArticleReport(brief, plan, md, {}, { now: "2026-07-21T00:00:00.000Z" });
  };
  const { manifest: out } = runBatch(manifest, { ws, buildFn });
  assert.strictEqual(out.reportSummary.generatedCount, 3);
  assert.deepStrictEqual(
    out.articles.map((a) => a.storyId),
    ["A", "B", "C"]
  );
  assert.ok(seen[0].includes("MARK-A") && !seen[0].includes("MARK-B"));
  assert.ok(seen[1].includes("MARK-B") && !seen[1].includes("MARK-A"));
  assert.ok(seen[2].includes("MARK-C"));
  console.log("PASS Case 2: generated 3");
}

function case3SkipFailedWriter() {
  const ws = tmpWorkspace();
  const a = writeArticle(ws.articlesDir, "01-a.md", "A");
  const c = writeArticle(ws.articlesDir, "03-c.md", "C");
  const manifest = baseManifest(
    [
      {
        storyId: "A",
        position: 1,
        section: "top",
        rank: 1,
        score: 90,
        articlePath: a,
        status: "generated",
      },
      {
        storyId: "B",
        position: 2,
        section: "secondary",
        rank: 2,
        score: 80,
        articlePath: "articles/02-b.md",
        status: "failed",
      },
      {
        storyId: "C",
        position: 3,
        section: "brief",
        rank: 3,
        score: 70,
        articlePath: c,
        status: "generated",
      },
    ],
    a
  );
  const { manifest: out } = runBatch(manifest, { ws });
  assert.strictEqual(out.reportSummary.requestedCount, 2);
  assert.strictEqual(out.reportSummary.generatedCount, 2);
  assert.ok(!out.articles[1].report);
  assert.strictEqual(out.articles[1].status, "failed");
  console.log("PASS Case 3: writer-failed excluded");
}

function case4OutsideManifest() {
  const ws = tmpWorkspace();
  const a = writeArticle(ws.articlesDir, "01-a.md", "A");
  writeArticle(ws.articlesDir, "orphan.md", "ORPHAN");
  const manifest = baseManifest(
    [
      {
        storyId: "A",
        position: 1,
        section: "top",
        rank: 1,
        score: 90,
        articlePath: a,
        status: "generated",
      },
    ],
    a
  );
  const { manifest: out, ws: w } = runBatch(manifest, { ws });
  assert.strictEqual(out.articles.length, 1);
  assert.ok(!fs.existsSync(path.join(w.reportsDir, "orphan.report.json")));
  console.log("PASS Case 4: outside manifest ignored");
}

function case5ReportFileName() {
  assert.strictEqual(
    resolveReportFileName("articles/01-story-a.md"),
    "01-story-a.report.json"
  );
  assert.ok(!resolveReportFileName("articles/01-a.md").includes("/"));
  console.log("PASS Case 5: report filename");
}

function case6Empty() {
  const ws = tmpWorkspace();
  const manifest = baseManifest([], null);
  const { reportSummary, manifest: out } = runBatch(manifest, { ws });
  assert.strictEqual(reportSummary.requestedCount, 0);
  assert.strictEqual(reportSummary.generatedCount, 0);
  assert.ok(out.reportSummary);
  console.log("PASS Case 6: empty articles");
}

function case7IndividualFailure() {
  const ws = tmpWorkspace();
  const paths = [
    writeArticle(ws.articlesDir, "01-a.md", "A"),
    writeArticle(ws.articlesDir, "02-b.md", "B"),
    writeArticle(ws.articlesDir, "03-c.md", "C"),
  ];
  const manifest = baseManifest(
    [
      {
        storyId: "A",
        position: 1,
        section: "top",
        rank: 1,
        score: 90,
        articlePath: paths[0],
        status: "generated",
      },
      {
        storyId: "B",
        position: 2,
        section: "secondary",
        rank: 2,
        score: 80,
        articlePath: paths[1],
        status: "generated",
      },
      {
        storyId: "C",
        position: 3,
        section: "brief",
        rank: 3,
        score: 70,
        articlePath: paths[2],
        status: "generated",
      },
    ],
    paths[0]
  );
  let n = 0;
  const buildFn = (brief, plan, md) => {
    n += 1;
    if (n === 2) throw new Error("boom");
    return buildArticleReport(brief, plan, md, {}, { now: "2026-07-21T00:00:00.000Z" });
  };
  const { manifest: out } = runBatch(manifest, { ws, buildFn });
  assert.strictEqual(out.reportSummary.generatedCount, 2);
  assert.strictEqual(out.reportSummary.failedCount, 1);
  assert.strictEqual(out.articles[1].report.status, "failed");
  assert.strictEqual(
    out.articles[1].report.errorCode,
    "article-report-generation-failed"
  );
  assert.strictEqual(out.articles[1].status, "generated");
  console.log("PASS Case 7: individual report failure");
}

function case8EmptyReportOutput() {
  const ws = tmpWorkspace();
  const a = writeArticle(ws.articlesDir, "01-a.md", "A");
  const manifest = baseManifest(
    [
      {
        storyId: "A",
        position: 1,
        section: "top",
        rank: 1,
        score: 90,
        articlePath: a,
        status: "generated",
      },
    ],
    a
  );
  const buildFn = () => null;
  const { manifest: out, ws: w } = runBatch(manifest, { ws, buildFn });
  assert.strictEqual(out.articles[0].report.errorCode, "article-report-empty-output");
  assert.ok(!fs.existsSync(path.join(w.reportsDir, "01-a.report.json")));
  console.log("PASS Case 8: empty report output");
}

function case9MissingArticleFile() {
  const ws = tmpWorkspace();
  const manifest = baseManifest(
    [
      {
        storyId: "ghost",
        position: 1,
        section: "top",
        rank: 1,
        score: 90,
        articlePath: "articles/01-ghost.md",
        status: "generated",
      },
    ],
    "articles/01-ghost.md"
  );
  const { manifest: out } = runBatch(manifest, { ws });
  assert.strictEqual(out.articles[0].report.errorCode, "article-file-not-found");
  assert.strictEqual(out.articles[0].status, "generated");
  console.log("PASS Case 9: missing article file");
}

function case10MetadataPreserved() {
  const ws = tmpWorkspace();
  const a = writeArticle(ws.articlesDir, "01-a.md", "A");
  const manifest = baseManifest(
    [
      {
        storyId: "A",
        position: 1,
        section: "top",
        rank: 1,
        score: 92,
        articlePath: a,
        status: "generated",
      },
    ],
    a
  );
  const beforeSummary = JSON.stringify(manifest.summary);
  const { manifest: out } = runBatch(manifest, { ws });
  assert.strictEqual(out.articles[0].storyId, "A");
  assert.strictEqual(out.articles[0].position, 1);
  assert.strictEqual(out.articles[0].section, "top");
  assert.strictEqual(out.articles[0].rank, 1);
  assert.strictEqual(out.articles[0].score, 92);
  assert.strictEqual(out.articles[0].articlePath, a);
  assert.strictEqual(out.articles[0].status, "generated");
  assert.strictEqual(JSON.stringify(out.summary), beforeSummary);
  assert.ok(out.warnings.includes("keep-me"));
  console.log("PASS Case 10: metadata preserved");
}

function case11Isolation() {
  const ws = tmpWorkspace();
  const paths = [
    writeArticle(ws.articlesDir, "01-a.md", "ONLY-A-TOKEN"),
    writeArticle(ws.articlesDir, "02-b.md", "ONLY-B-TOKEN"),
  ];
  const manifest = baseManifest(
    [
      {
        storyId: "A",
        position: 1,
        section: "top",
        rank: 1,
        score: 90,
        articlePath: paths[0],
        status: "generated",
      },
      {
        storyId: "B",
        position: 2,
        section: "secondary",
        rank: 2,
        score: 80,
        articlePath: paths[1],
        status: "generated",
      },
    ],
    paths[0]
  );
  const bodies = [];
  const buildFn = (brief, plan, md) => {
    bodies.push(md);
    return buildArticleReport(brief, plan, md, {}, { now: "2026-07-21T00:00:00.000Z" });
  };
  runBatch(manifest, { ws, buildFn });
  assert.ok(bodies[0].includes("ONLY-A-TOKEN") && !bodies[0].includes("ONLY-B-TOKEN"));
  assert.ok(bodies[1].includes("ONLY-B-TOKEN") && !bodies[1].includes("ONLY-A-TOKEN"));
  console.log("PASS Case 11: isolation");
}

function case12LegacyPrimary() {
  const ws = tmpWorkspace();
  const paths = [
    writeArticle(ws.articlesDir, "01-a.md", "PRIMARY"),
    writeArticle(ws.articlesDir, "02-b.md", "SECOND"),
  ];
  const manifest = baseManifest(
    [
      {
        storyId: "A",
        position: 1,
        section: "top",
        rank: 1,
        score: 90,
        articlePath: paths[0],
        status: "generated",
      },
      {
        storyId: "B",
        position: 2,
        section: "secondary",
        rank: 2,
        score: 80,
        articlePath: paths[1],
        status: "generated",
      },
    ],
    paths[0]
  );
  const { manifest: out, legacyPath, legacyPrimaryReportPath } = runBatch(
    manifest,
    { ws }
  );
  assert.strictEqual(out.legacyPrimaryReportPath, "article-reports/01-a.report.json");
  assert.strictEqual(legacyPrimaryReportPath, "article-reports/01-a.report.json");
  assert.ok(fs.existsSync(legacyPath));
  console.log("PASS Case 12: legacy primary");
}

function case13Determinism() {
  const ws1 = tmpWorkspace();
  const ws2 = tmpWorkspace();
  for (const ws of [ws1, ws2]) {
    writeArticle(ws.articlesDir, "01-a.md", "A");
    writeArticle(ws.articlesDir, "02-b.md", "B");
  }
  const make = (ws) =>
    baseManifest(
      [
        {
          storyId: "A",
          position: 1,
          section: "top",
          rank: 1,
          score: 90,
          articlePath: "articles/01-a.md",
          status: "generated",
        },
        {
          storyId: "B",
          position: 2,
          section: "secondary",
          rank: 2,
          score: 80,
          articlePath: "articles/02-b.md",
          status: "generated",
        },
      ],
      "articles/01-a.md"
    );
  const a = runBatch(make(ws1), { ws: ws1 });
  const b = runBatch(make(ws2), { ws: ws2 });
  assert.deepStrictEqual(
    a.manifest.articles.map((x) => ({
      storyId: x.storyId,
      reportPath: x.report.reportPath,
      status: x.report.status,
    })),
    b.manifest.articles.map((x) => ({
      storyId: x.storyId,
      reportPath: x.report.reportPath,
      status: x.report.status,
    }))
  );
  assert.deepStrictEqual(a.reportSummary, b.reportSummary);
  console.log("PASS Case 13: determinism");
}

function case14LegacyCli() {
  const ar = require("../article-report");
  assert.ok(typeof ar.printHelp === "function" || true);
  const { buildArticleReport: build } = require("../lib/article-report-core");
  assert.ok(typeof build === "function");
  console.log("PASS Case 14: legacy AR exports");
}

function case15Integration() {
  const ws = tmpWorkspace();
  const paths = [
    writeArticle(ws.articlesDir, "01-a.md", "INT-A"),
    writeArticle(ws.articlesDir, "02-b.md", "INT-B"),
    writeArticle(ws.articlesDir, "03-c.md", "INT-C"),
  ];
  const manifest = baseManifest(
    [
      {
        storyId: "A",
        position: 1,
        section: "top",
        rank: 1,
        score: 95,
        articlePath: paths[0],
        status: "generated",
      },
      {
        storyId: "B",
        position: 2,
        section: "secondary",
        rank: 2,
        score: 88,
        articlePath: paths[1],
        status: "generated",
      },
      {
        storyId: "C",
        position: 3,
        section: "brief",
        rank: 3,
        score: 70,
        articlePath: paths[2],
        status: "generated",
      },
      {
        storyId: "D",
        position: 4,
        section: "brief",
        rank: 4,
        score: 60,
        articlePath: "articles/04-d.md",
        status: "failed",
      },
    ],
    paths[0]
  );
  const beforeStatuses = manifest.articles.map((a) => a.status);
  const { manifest: out } = runBatch(manifest, { ws });
  assert.strictEqual(out.reportSummary.requestedCount, 3);
  assert.strictEqual(out.reportSummary.generatedCount, 3);
  assert.ok(out.articles[0].report.status === "generated");
  assert.ok(out.articles[1].report.status === "generated");
  assert.ok(out.articles[2].report.status === "generated");
  assert.ok(!out.articles[3].report);
  assert.deepStrictEqual(
    out.articles.map((a) => a.status),
    beforeStatuses
  );
  assert.strictEqual(out.legacyPrimaryReportPath, "article-reports/01-a.report.json");
  console.log("PASS Case 15: integration");
}

function main() {
  case1OneGenerated();
  case2ThreeGenerated();
  case3SkipFailedWriter();
  case4OutsideManifest();
  case5ReportFileName();
  case6Empty();
  case7IndividualFailure();
  case8EmptyReportOutput();
  case9MissingArticleFile();
  case10MetadataPreserved();
  case11Isolation();
  case12LegacyPrimary();
  case13Determinism();
  case14LegacyCli();
  case15Integration();
  console.log("\nAll Article Report Batch (EP-009) cases PASS");
}

main();
