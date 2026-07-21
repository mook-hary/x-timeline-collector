/**
 * EP-008 — Multi-Article Writer batch tests.
 * Run: node test/writer-batch-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  runWriterBatch,
  sanitizeStoryId,
  buildArticleFileName,
} = require("../lib/writer-batch");

function story(id, marker) {
  return {
    id,
    label: id,
    description: marker || `desc-${id}`,
    concepts: [
      {
        label: id,
        summary: marker || `summary-${id}`,
        posts: [
          {
            authorHandle: `@${id}`,
            postedAt: "2026-07-15T12:00:00.000Z",
            text: marker || `text-${id}-unique`,
            url: `https://x.com/${id}/1`,
          },
        ],
        postCount: 1,
      },
    ],
    posts: [
      {
        authorHandle: `@${id}`,
        postedAt: "2026-07-15T12:00:00.000Z",
        text: marker || `text-${id}-unique`,
        url: `https://x.com/${id}/1`,
      },
    ],
    postCount: 1,
  };
}

function selected(id, position, extras = {}) {
  return {
    storyId: id,
    position,
    section: extras.section || (position === 1 ? "top" : "secondary"),
    rank: extras.rank != null ? extras.rank : position,
    score: extras.score != null ? extras.score : 100 - position,
    story: extras.story || story(id, extras.marker),
  };
}

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
    constraints: [],
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

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ep008-"));
}

function runBatch(selectedStories, opts = {}) {
  const dir = opts.dir || tmpDir();
  const articlesDir = path.join(dir, "articles");
  const manifestPath = path.join(dir, "articles-manifest.json");
  const legacyPath = path.join(dir, "article.md");
  const result = runWriterBatch({
    selectionResult: {
      ok: true,
      mode: "edition",
      selectedStories,
      warnings: [],
      summary: {
        requestedCount: selectedStories.length,
        resolvedCount: selectedStories.length,
        missingCount: 0,
        duplicateCount: 0,
      },
    },
    brief: makeBrief(),
    plan: makePlan(),
    outputDir: articlesDir,
    manifestPath,
    legacyPrimaryPath: legacyPath,
    renderFn: opts.renderFn || null,
  });
  return { ...result, dir, articlesDir, manifestPath, legacyPath };
}

function case1OneArticle() {
  const { manifest, articlesDir, legacyPath, legacyPrimaryMarkdown } = runBatch([
    selected("creative-tech", 1),
  ]);
  assert.strictEqual(manifest.summary.generatedCount, 1);
  assert.strictEqual(manifest.articles.length, 1);
  assert.strictEqual(manifest.articles[0].position, 1);
  assert.ok(fs.existsSync(path.join(articlesDir, "01-creative-tech.md")));
  assert.ok(fs.existsSync(legacyPath));
  assert.ok(legacyPrimaryMarkdown.includes("#"));
  assert.strictEqual(
    manifest.legacyPrimaryArticlePath,
    "articles/01-creative-tech.md"
  );
  console.log("PASS Case 1: selected 1");
}

function case2ThreeArticles() {
  const { manifest, articlesDir } = runBatch([
    selected("A", 1, { marker: "MARKER-A-ONLY" }),
    selected("B", 2, { marker: "MARKER-B-ONLY" }),
    selected("C", 3, { marker: "MARKER-C-ONLY" }),
  ]);
  assert.strictEqual(manifest.summary.generatedCount, 3);
  assert.deepStrictEqual(
    manifest.articles.map((a) => a.storyId),
    ["A", "B", "C"]
  );
  const a = fs.readFileSync(path.join(articlesDir, "01-a.md"), "utf8");
  const b = fs.readFileSync(path.join(articlesDir, "02-b.md"), "utf8");
  const c = fs.readFileSync(path.join(articlesDir, "03-c.md"), "utf8");
  assert.ok(a.includes("MARKER-A-ONLY"));
  assert.ok(b.includes("MARKER-B-ONLY"));
  assert.ok(c.includes("MARKER-C-ONLY"));
  console.log("PASS Case 2: selected 3 ordered");
}

function case3UnselectedNotGenerated() {
  const { manifest, articlesDir } = runBatch([
    selected("A", 1),
    selected("B", 2),
  ]);
  assert.strictEqual(manifest.articles.length, 2);
  const files = fs.readdirSync(articlesDir);
  assert.ok(!files.some((f) => f.includes("c.md") && !f.includes("tech")));
  assert.ok(!manifest.articles.some((a) => a.storyId === "C"));
  console.log("PASS Case 3: unselected not generated");
}

function case4SafeFileNames() {
  const used = new Set();
  const name = buildArticleFileName(
    1,
    "日本語 Story ID!!! with spaces",
    used
  );
  assert.ok(name.endsWith(".md"));
  assert.ok(!name.includes(" "));
  assert.ok(!name.includes("!"));
  assert.strictEqual(sanitizeStoryId(""), "story");
  assert.strictEqual(
    buildArticleFileName(1, "日本語 Story ID!!! with spaces", new Set()),
    name
  );
  console.log("PASS Case 4: safe filenames");
}

function case5NameCollision() {
  const used = new Set();
  const a = buildArticleFileName(1, "Foo Bar", used);
  const b = buildArticleFileName(1, "Foo---Bar", used);
  assert.notStrictEqual(a, b);
  assert.ok(a.endsWith(".md") && b.endsWith(".md"));
  console.log("PASS Case 5: filename collision avoided");
}

function case6EmptySelection() {
  const { manifest, articlesDir, legacyPrimaryMarkdown } = runBatch([]);
  assert.deepStrictEqual(manifest.articles, []);
  assert.strictEqual(manifest.summary.requestedCount, 0);
  assert.strictEqual(manifest.summary.generatedCount, 0);
  assert.strictEqual(legacyPrimaryMarkdown, "");
  assert.deepStrictEqual(fs.readdirSync(articlesDir), []);
  console.log("PASS Case 6: empty selection");
}

function case7IndividualFailure() {
  let calls = 0;
  const renderFn = () => {
    calls += 1;
    if (calls === 2) throw new Error("boom");
    return `# ok-${calls}\n\nbody\n`;
  };
  const { manifest } = runBatch(
    [selected("A", 1), selected("B", 2), selected("C", 3)],
    { renderFn }
  );
  assert.strictEqual(manifest.summary.generatedCount, 2);
  assert.strictEqual(manifest.summary.failedCount, 1);
  const failed = manifest.articles.find((a) => a.status === "failed");
  assert.strictEqual(failed.storyId, "B");
  assert.strictEqual(failed.errorCode, "writer-generation-failed");
  assert.ok(manifest.articles.every((a) => a.storyId !== "D"));
  console.log("PASS Case 7: individual failure continues");
}

function case8EmptyWriterOutput() {
  const renderFn = (brief, plan, opts) => {
    const id = opts.stories.stories[0].id;
    if (id === "empty") return "   \n";
    return `# ${id}\n\nbody\n`;
  };
  const { manifest, articlesDir } = runBatch(
    [selected("ok", 1), selected("empty", 2)],
    { renderFn }
  );
  assert.strictEqual(manifest.summary.generatedCount, 1);
  assert.strictEqual(manifest.summary.failedCount, 1);
  const failed = manifest.articles.find((a) => a.storyId === "empty");
  assert.strictEqual(failed.errorCode, "writer-empty-output");
  assert.ok(!fs.existsSync(path.join(articlesDir, "02-empty.md")));
  console.log("PASS Case 8: empty writer output");
}

function case9Metadata() {
  const { manifest } = runBatch([
    selected("meta", 1, { section: "top", rank: 1, score: 92 }),
  ]);
  const a = manifest.articles[0];
  assert.strictEqual(a.storyId, "meta");
  assert.strictEqual(a.position, 1);
  assert.strictEqual(a.section, "top");
  assert.strictEqual(a.rank, 1);
  assert.strictEqual(a.score, 92);
  console.log("PASS Case 9: metadata preserved");
}

function case10StoryIsolation() {
  const { articlesDir } = runBatch([
    selected("A", 1, { marker: "CLAIM-A-ONLY-XYZ" }),
    selected("B", 2, { marker: "CLAIM-B-ONLY-XYZ" }),
  ]);
  const a = fs.readFileSync(path.join(articlesDir, "01-a.md"), "utf8");
  const b = fs.readFileSync(path.join(articlesDir, "02-b.md"), "utf8");
  assert.ok(a.includes("CLAIM-A-ONLY-XYZ"));
  assert.ok(!a.includes("CLAIM-B-ONLY-XYZ"));
  assert.ok(b.includes("CLAIM-B-ONLY-XYZ"));
  assert.ok(!b.includes("CLAIM-A-ONLY-XYZ"));
  console.log("PASS Case 10: story isolation");
}

function case11Determinism() {
  const selectedStories = [
    selected("A", 1),
    selected("B", 2),
    selected("C", 3),
  ];
  const r1 = runBatch(selectedStories);
  const r2 = runBatch(selectedStories);
  assert.deepStrictEqual(
    r1.manifest.articles.map((a) => ({
      storyId: a.storyId,
      articlePath: a.articlePath,
      status: a.status,
    })),
    r2.manifest.articles.map((a) => ({
      storyId: a.storyId,
      articlePath: a.articlePath,
      status: a.status,
    }))
  );
  console.log("PASS Case 11: determinism");
}

function case12LegacyCliStillLoads() {
  const writer = require("../writer");
  assert.ok(typeof writer.printHelp === "function");
  const { renderMarkdown } = require("../lib/writer-core");
  assert.ok(typeof renderMarkdown === "function");
  console.log("PASS Case 12: legacy writer exports");
}

function case13Integration() {
  // A/B/C selected; D omitted conceptually; E hold not in selection
  const { manifest, legacyPrimaryArticlePath, articlesDir } = runBatch([
    selected("A", 1, { section: "top", marker: "INT-A" }),
    selected("B", 2, { section: "secondary", marker: "INT-B" }),
    selected("C", 3, { section: "secondary", marker: "INT-C" }),
  ]);
  assert.deepStrictEqual(
    manifest.articles.map((a) => a.storyId),
    ["A", "B", "C"]
  );
  assert.strictEqual(legacyPrimaryArticlePath, "articles/01-a.md");
  assert.ok(fs.existsSync(path.join(articlesDir, "01-a.md")));
  assert.ok(!manifest.articles.some((a) => a.storyId === "D"));
  assert.ok(!manifest.articles.some((a) => a.storyId === "E"));
  console.log("PASS Case 13: integration A/B/C primary A");
}

function main() {
  case1OneArticle();
  case2ThreeArticles();
  case3UnselectedNotGenerated();
  case4SafeFileNames();
  case5NameCollision();
  case6EmptySelection();
  case7IndividualFailure();
  case8EmptyWriterOutput();
  case9Metadata();
  case10StoryIsolation();
  case11Determinism();
  case12LegacyCliStillLoads();
  case13Integration();
  console.log("\nAll Writer Batch (EP-008) cases PASS");
}

main();
