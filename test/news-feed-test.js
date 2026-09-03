/**
 * NEWS-FEED-EXPORT-001 — Public news-feed.json from Daily Enriched.
 * Run: node test/news-feed-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  SCHEMA_VERSION,
  FEED_SOURCE,
  NEWS_FEED_REL,
  NEWS_FEED_BASENAME,
  buildNewsFeed,
  writeNewsFeed,
  parseNewsFeedFromOutput,
  formatNewsFeedBuildLine,
  loadNewsFeedSummary,
} = require("../lib/news-feed");
const { buildDigestReader, selectTodaysPicks } = require("../lib/digest-reader");
const { scoreEditorialPost } = require("../lib/editorial-score");
const { mergeDigestConfig, DEFAULT_DIGEST_CONFIG, getPersonalScore } = require("../lib/digest-core");
const { finalizeHealth } = require("../lib/morning-pipeline");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function axisEnrichment(overrides = {}) {
  return {
    informationValue: 4,
    personalRelevance: 3,
    impact: 4,
    attentionSignal: 2,
    importance: 4,
    summary: "編集済みタイトル相当の要約です",
    reason: "test",
    tags: ["test"],
    ...overrides,
  };
}

function dailyPost(index, extra = {}) {
  const id = extra.statusId || String(1000 + index);
  return {
    ...(extra.id ? { id: extra.id } : {}),
    authorName: extra.authorName || `Author ${index}`,
    authorHandle: extra.authorHandle || `@user${index}`,
    postedAt: extra.postedAt || `2026-08-30T0${index % 9}:00:00.000Z`,
    collectedAt: extra.collectedAt || "2026-08-30T03:00:00.000Z",
    text:
      extra.text ||
      `full x body ${index} must not be copied ${extra.secretText || ""}`,
    url: extra.url || `https://x.com/user${index}/status/${id}`,
    finalAnalysis: extra.finalAnalysis || { category: extra.category || "AI" },
    enrichment: extra.enrichment || axisEnrichment(
      extra.summary ? { summary: extra.summary } : {}
    ),
    ...(extra.media ? { media: extra.media } : {}),
  };
}

const config = mergeDigestConfig(DEFAULT_DIGEST_CONFIG);

function sortOnlyUrls(posts) {
  return posts
    .map((post, index) => ({
      url: post.url,
      index,
      editorialScore: scoreEditorialPost(post, {
        personalScore: getPersonalScore(post, config),
      }),
    }))
    .sort((a, b) => {
      if (a.editorialScore !== b.editorialScore) {
        return b.editorialScore - a.editorialScore;
      }
      return a.index - b.index;
    })
    .map((row) => row.url);
}

// --- parse / format helpers ---
{
  assert.strictEqual(NEWS_FEED_BASENAME, "news-feed.json");
  assert.strictEqual(
    NEWS_FEED_REL,
    path.join("output", "digest-reader", "news-feed.json")
  );
  const line = formatNewsFeedBuildLine({ itemCount: 33 });
  assert.strictEqual(
    line,
    "[build:digest-reader] news-feed items=33 path=output/digest-reader/news-feed.json"
  );
  assert.deepStrictEqual(parseNewsFeedFromOutput(`${line}\n`), {
    generated: true,
    itemCount: 33,
    path: "output/digest-reader/news-feed.json",
  });
  const skippedLine = formatNewsFeedBuildLine({
    generated: false,
    itemCount: 0,
  });
  assert.strictEqual(
    skippedLine,
    "[build:digest-reader] news-feed skipped path=output/digest-reader/news-feed.json"
  );
  assert.deepStrictEqual(parseNewsFeedFromOutput(`${skippedLine}\n`), {
    generated: false,
    itemCount: 0,
    path: "output/digest-reader/news-feed.json",
  });
  console.log("news-feed helpers PASS");
}

// --- Case A: 10 Daily Enriched → 10 feed items ---
{
  const posts = Array.from({ length: 10 }, (_, i) => dailyPost(i));
  const feed = buildNewsFeed(posts, {
    generatedAt: "2026-08-30T03:50:00.000Z",
    config,
  });
  assert.strictEqual(feed.schemaVersion, SCHEMA_VERSION);
  assert.strictEqual(feed.source, FEED_SOURCE);
  assert.strictEqual(feed.generatedAt, "2026-08-30T03:50:00.000Z");
  assert.deepStrictEqual(feed.scope, { type: "collect-run", itemCount: 10 });
  assert.strictEqual(feed.items.length, 10);
  assert.strictEqual(feed.scope.itemCount, posts.length);
  for (const item of feed.items) {
    assert.deepStrictEqual(item.media, []);
  }
  console.log("news-feed case A PASS");
}

// --- Case B: Archive must not mix into Daily Scope feed ---
{
  const archive = Array.from({ length: 20 }, (_, i) =>
    dailyPost(i, {
      statusId: String(9000 + i),
      url: `https://x.com/old/status/${9000 + i}`,
      summary: `archive-only ${i}`,
    })
  );
  const daily = Array.from({ length: 33 }, (_, i) =>
    dailyPost(i, { statusId: String(2000 + i) })
  );
  const feed = buildNewsFeed(daily, { config });
  assert.strictEqual(feed.scope.itemCount, 33);
  assert.strictEqual(feed.items.length, 33);
  const ids = new Set(feed.items.map((item) => item.id));
  const urls = new Set(feed.items.map((item) => item.sourceUrl));
  for (const post of archive) {
    assert.ok(!urls.has(post.url), `archive url leaked: ${post.url}`);
    const archiveId = String(post.url).match(/status\/(\d+)/)[1];
    assert.ok(!ids.has(archiveId), `archive id leaked: ${archiveId}`);
  }
  for (const post of daily) {
    assert.ok(urls.has(post.url), `daily url missing: ${post.url}`);
  }
  console.log("news-feed case B PASS");
}

// --- Case C: empty Daily Scope overwrites stale feed ---
{
  const root = tmpDir("news-feed-c-");
  const out = path.join(root, "output", "digest-reader");
  fs.mkdirSync(out, { recursive: true });
  const feedPath = path.join(out, "news-feed.json");
  fs.writeFileSync(
    feedPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        source: "x-timeline-collector",
        generatedAt: "2026-08-29T03:00:00.000Z",
        scope: { type: "collect-run", itemCount: 99 },
        items: [{ id: "stale", title: "yesterday" }],
      },
      null,
      2
    ),
    "utf8"
  );
  const result = buildDigestReader({
    rootDir: root,
    outputDir: out,
    posts: [],
    config,
    now: () => new Date("2026-08-30T03:50:00.000Z"),
    profile: false,
  });
  const feed = JSON.parse(fs.readFileSync(result.newsFeedPath, "utf8"));
  assert.strictEqual(feed.scope.itemCount, 0);
  assert.deepStrictEqual(feed.items, []);
  assert.ok(!JSON.stringify(feed).includes("yesterday"));
  assert.ok(!JSON.stringify(feed).includes("stale"));
  console.log("news-feed case C PASS");
}

// --- Case D + E: scores / mapping from existing fields ---
{
  const post = dailyPost(1, {
    statusId: "555",
    category: "政治・社会",
    authorName: "News Desk",
    authorHandle: "@desk",
    postedAt: "2026-08-29T12:00:00.000Z",
    collectedAt: "2026-08-30T03:10:00.000Z",
    summary: "既存summaryをtitle/summaryに使う",
    enrichment: axisEnrichment({
      informationValue: 5,
      personalRelevance: 4,
      impact: 4,
      attentionSignal: 2,
      importance: 5,
      summary: "既存summaryをtitle/summaryに使う",
    }),
  });
  const [item] = buildNewsFeed([post], { config }).items;
  assert.strictEqual(item.id, "555");
  assert.strictEqual(item.title, "既存summaryをtitle/summaryに使う");
  assert.strictEqual(item.summary, "既存summaryをtitle/summaryに使う");
  assert.strictEqual(item.category, "政治・社会");
  assert.strictEqual(item.sourceType, "x");
  assert.strictEqual(item.sourceUrl, "https://x.com/user1/status/555");
  assert.strictEqual(item.postedAt, "2026-08-29T12:00:00.000Z");
  assert.strictEqual(item.collectedAt, "2026-08-30T03:10:00.000Z");
  assert.deepStrictEqual(item.author, { name: "News Desk", handle: "@desk" });
  assert.deepStrictEqual(item.scores, {
    informationValue: 5,
    personalRelevance: 4,
    impact: 4,
    attentionSignal: 2,
    importance: 5,
  });
  assert.deepStrictEqual(item.media, []);
  console.log("news-feed case D/E PASS");
}

// --- Case F: missing fields are null; JSON still valid ---
{
  const feed = buildNewsFeed([{}], { generatedAt: "2026-08-30T00:00:00.000Z" });
  assert.strictEqual(feed.items.length, 1);
  const item = feed.items[0];
  assert.strictEqual(item.id, null);
  assert.strictEqual(item.title, null);
  assert.strictEqual(item.summary, null);
  assert.strictEqual(item.sourceUrl, null);
  assert.strictEqual(item.postedAt, null);
  assert.strictEqual(item.collectedAt, null);
  assert.deepStrictEqual(item.author, { name: null, handle: null });
  assert.deepStrictEqual(item.scores, {
    informationValue: null,
    personalRelevance: null,
    impact: null,
    attentionSignal: null,
    importance: null,
  });
  assert.deepStrictEqual(item.media, []);
  const raw = JSON.stringify(feed);
  JSON.parse(raw);
  console.log("news-feed case F PASS");
}

// --- Case G: secrets / absolute local paths stay out of the feed ---
{
  const post = dailyPost(2, {
    text: "leak OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789 and /Users/erefanto/x-timeline-chrome",
    summary: "公開してよい要約だけ",
  });
  const root = tmpDir("news-feed-g-");
  const out = path.join(root, "output", "digest-reader");
  const result = buildDigestReader({
    rootDir: root,
    outputDir: out,
    posts: [post],
    config,
    profile: false,
  });
  const raw = fs.readFileSync(result.newsFeedPath, "utf8");
  assert.ok(!raw.includes("OPENAI_API_KEY"));
  assert.ok(!raw.includes("sk-abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!raw.includes("/Users/"));
  assert.ok(!raw.includes("x-timeline-chrome"));
  assert.ok(!raw.includes(root));
  const feed = JSON.parse(raw);
  assert.ok(!JSON.stringify(feed.items[0]).includes("full x body"));
  console.log("news-feed case G PASS");
}

// --- ranking matches existing editorialScore order ---
{
  const posts = [
    dailyPost(1, {
      category: "日常・雑談",
      enrichment: axisEnrichment({
        informationValue: 1,
        personalRelevance: 1,
        impact: 1,
        importance: 1,
        summary: "low",
      }),
    }),
    dailyPost(2, {
      category: "AI",
      enrichment: axisEnrichment({
        informationValue: 5,
        personalRelevance: 5,
        impact: 5,
        importance: 5,
        summary: "high",
      }),
    }),
  ];
  const feed = buildNewsFeed(posts, { config });
  assert.deepStrictEqual(
    feed.items.map((item) => item.sourceUrl),
    sortOnlyUrls(posts)
  );
  console.log("news-feed ranking PASS");
}

// --- Case L: same sourceUrl, different id/author — both kept ---
{
  const sharedUrl = "https://x.com/shared/status/777";
  const posts = [
    ...Array.from({ length: 8 }, (_, i) => dailyPost(i)),
    dailyPost(8, {
      id: "item-alpha",
      authorName: "Alpha",
      authorHandle: "@alpha",
      url: sharedUrl,
      summary: "同一URLの1件目",
    }),
    dailyPost(9, {
      id: "item-beta",
      authorName: "Beta",
      authorHandle: "@beta",
      url: sharedUrl,
      summary: "同一URLの2件目",
    }),
  ];
  assert.strictEqual(posts.length, 10);

  const feed = buildNewsFeed(posts, { config });
  assert.strictEqual(feed.scope.itemCount, 10);
  assert.strictEqual(feed.items.length, 10);
  assert.strictEqual(feed.scope.itemCount, posts.length);

  const shared = feed.items.filter((item) => item.sourceUrl === sharedUrl);
  assert.strictEqual(shared.length, 2);
  assert.deepStrictEqual(
    shared.map((item) => item.id).sort(),
    ["item-alpha", "item-beta"]
  );
  assert.deepStrictEqual(
    shared.map((item) => item.author.handle).sort(),
    ["@alpha", "@beta"]
  );

  const readerDedupe = selectTodaysPicks(
    [
      posts[8],
      posts[9],
      dailyPost(7, { url: "https://x.com/other/status/888" }),
    ],
    5,
    config
  );
  const readerUrls = readerDedupe.map((p) => p.url);
  assert.strictEqual(readerUrls.length, new Set(readerUrls).size);
  assert.strictEqual(readerDedupe.length, 2);
  assert.strictEqual(
    readerDedupe.filter((p) => p.url === sharedUrl).length,
    1
  );

  const root = tmpDir("news-feed-l-");
  const result = buildDigestReader({
    rootDir: root,
    outputDir: path.join(root, "output", "digest-reader"),
    posts,
    config,
    profile: false,
  });
  const written = JSON.parse(fs.readFileSync(result.newsFeedPath, "utf8"));
  assert.strictEqual(written.items.length, 10);
  assert.strictEqual(
    written.items.filter((item) => item.sourceUrl === sharedUrl).length,
    2
  );
  console.log("news-feed case L PASS");
}

// --- serialize failure is explicit ---
{
  const filePath = path.join(tmpDir("news-feed-ser-"), "news-feed.json");
  const circular = { schemaVersion: 1, items: [] };
  circular.self = circular;
  assert.throws(() => writeNewsFeed(filePath, circular), /serialization failed/);
  console.log("news-feed serialize-fail PASS");
}

// --- Case I: Morning health SUCCESS loads feed; FAILED ignores stale feed ---
{
  const okRoot = tmpDir("news-feed-i-ok-");
  const okDir = path.join(okRoot, "output", "digest-reader");
  fs.mkdirSync(okDir, { recursive: true });
  const okFeed = buildNewsFeed(
    Array.from({ length: 3 }, (_, i) => dailyPost(i)),
    { generatedAt: "2026-08-30T03:50:00.000Z", config }
  );
  writeNewsFeed(path.join(okDir, "news-feed.json"), okFeed);
  const ok = finalizeHealth(
    okRoot,
    {
      startedAt: "2026-08-30T03:00:00.000Z",
      finishedAt: "2026-08-30T03:50:00.000Z",
      status: "SUCCESS",
      stages: [],
    },
    { historyNow: () => new Date(2026, 7, 30, 12, 0, 0) },
    () => {}
  );
  assert.ok(ok.report.newsFeed);
  assert.strictEqual(ok.report.newsFeed.generated, true);
  assert.strictEqual(ok.report.newsFeed.itemCount, 3);
  assert.strictEqual(ok.report.newsFeed.path, NEWS_FEED_REL);

  const failRoot = tmpDir("news-feed-i-fail-");
  const failDir = path.join(failRoot, "output", "digest-reader");
  fs.mkdirSync(failDir, { recursive: true });
  writeNewsFeed(path.join(failDir, "news-feed.json"), okFeed);
  const failed = finalizeHealth(
    failRoot,
    {
      startedAt: "2026-08-30T03:00:00.000Z",
      finishedAt: "2026-08-30T03:01:00.000Z",
      status: "FAILED",
      stages: [],
      failure: { stage: "Publish Digest Reader", error: "boom" },
    },
    { historyNow: () => new Date(2026, 7, 30, 12, 0, 1) },
    () => {}
  );
  assert.strictEqual(failed.report.newsFeed, null);
  console.log("news-feed case I PASS");
}

{
  assert.deepStrictEqual(
    loadNewsFeedSummary(tmpDir("news-feed-missing-")),
    null
  );
  console.log("news-feed load-missing PASS");
}

// --- archive input must not overwrite the public Daily Scope feed ---
{
  const root = tmpDir("news-feed-archive-guard-");
  const outputDir = path.join(root, "output", "digest-reader");
  fs.mkdirSync(outputDir, { recursive: true });
  const archivePath = path.join(root, "output", "timeline_enriched.json");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const archivePosts = [
    dailyPost(1, {
      url: "https://x.com/old/status/9001",
      summary: "archive must not publish",
    }),
  ];
  fs.writeFileSync(archivePath, JSON.stringify(archivePosts, null, 2), "utf8");
  const stale = {
    schemaVersion: 1,
    source: "x-timeline-collector",
    generatedAt: "2026-08-29T03:00:00.000Z",
    scope: { type: "collect-run", itemCount: 0 },
    items: [],
  };
  fs.writeFileSync(
    path.join(outputDir, "news-feed.json"),
    JSON.stringify(stale, null, 2),
    "utf8"
  );
  const archiveResult = buildDigestReader({
    rootDir: root,
    inputPath: archivePath,
    outputDir,
    config,
    profile: false,
  });
  const kept = JSON.parse(
    fs.readFileSync(path.join(outputDir, "news-feed.json"), "utf8")
  );
  assert.deepStrictEqual(kept.items, []);
  assert.ok(!JSON.stringify(kept).includes("archive must not publish"));
  assert.strictEqual(archiveResult.newsFeed.generated, false);
  const skippedLine = formatNewsFeedBuildLine(archiveResult.newsFeed);
  assert.match(skippedLine, /news-feed skipped/);
  assert.deepStrictEqual(parseNewsFeedFromOutput(skippedLine), {
    generated: false,
    itemCount: 0,
    path: NEWS_FEED_REL,
  });
  console.log("news-feed archive-input-guard PASS");
}

// --- Case M: Archive input skips Feed; parser reports generated=false ---
{
  const root = tmpDir("news-feed-m-");
  const outputDir = path.join(root, "output", "digest-reader");
  const archivePath = path.join(root, "output", "timeline_enriched.json");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(
    archivePath,
    JSON.stringify(
      [dailyPost(1, { url: "https://x.com/old/status/9001" })],
      null,
      2
    ),
    "utf8"
  );
  const result = buildDigestReader({
    rootDir: root,
    inputPath: archivePath,
    outputDir,
    config,
    profile: false,
  });
  assert.strictEqual(result.newsFeed.generated, false);
  assert.ok(!fs.existsSync(path.join(outputDir, "news-feed.json")));
  const parsed = parseNewsFeedFromOutput(
    formatNewsFeedBuildLine(result.newsFeed)
  );
  assert.strictEqual(parsed.generated, false);
  assert.strictEqual(parsed.itemCount, 0);
  console.log("news-feed case M PASS");
}

// --- Case N: Daily Enriched input writes Feed; parser reports generated=true ---
{
  const root = tmpDir("news-feed-n-");
  const outputDir = path.join(root, "output", "digest-reader");
  const dailyPath = path.join(root, "output", "daily-enriched.json");
  const posts = Array.from({ length: 7 }, (_, i) => dailyPost(i));
  fs.mkdirSync(path.dirname(dailyPath), { recursive: true });
  fs.writeFileSync(dailyPath, JSON.stringify(posts, null, 2), "utf8");
  const result = buildDigestReader({
    rootDir: root,
    inputPath: dailyPath,
    outputDir,
    config,
    profile: false,
  });
  assert.strictEqual(result.newsFeed.generated, true);
  assert.strictEqual(result.newsFeed.itemCount, posts.length);
  const written = JSON.parse(fs.readFileSync(result.newsFeedPath, "utf8"));
  assert.strictEqual(written.scope.itemCount, 7);
  assert.strictEqual(written.items.length, 7);
  const parsed = parseNewsFeedFromOutput(
    formatNewsFeedBuildLine(result.newsFeed)
  );
  assert.strictEqual(parsed.generated, true);
  assert.strictEqual(parsed.itemCount, 7);
  console.log("news-feed case N PASS");
}

// --- media metadata is additive; schemaVersion stays 1 ---
{
  const photo =
    "https://pbs.twimg.com/media/example.jpg?format=jpg&name=orig";
  const posts = [
    dailyPost(1, {
      enrichment: axisEnrichment({
        informationValue: 1,
        personalRelevance: 1,
        impact: 1,
        importance: 1,
        summary: "low",
      }),
    }),
    dailyPost(2, {
      enrichment: axisEnrichment({
        informationValue: 5,
        personalRelevance: 5,
        impact: 5,
        importance: 5,
        summary: "high",
      }),
      media: [
        {
          type: "image",
          url: photo,
          previewUrl: photo,
          altText: null,
          width: null,
          height: null,
        },
      ],
    }),
  ];
  const withoutMedia = posts.map(({ media: _m, ...rest }) => rest);
  const feed = buildNewsFeed(posts, { config });
  const baseline = buildNewsFeed(withoutMedia, { config });
  assert.strictEqual(feed.schemaVersion, 1);
  assert.strictEqual(feed.schemaVersion, SCHEMA_VERSION);
  assert.strictEqual(feed.scope.itemCount, posts.length);
  assert.strictEqual(feed.items.length, posts.length);
  assert.deepStrictEqual(
    feed.items.map((item) => item.sourceUrl),
    baseline.items.map((item) => item.sourceUrl)
  );
  assert.deepStrictEqual(
    feed.items.map((item) => item.scores),
    baseline.items.map((item) => item.scores)
  );
  assert.deepStrictEqual(
    feed.items.map((item) => item.title),
    baseline.items.map((item) => item.title)
  );
  assert.deepStrictEqual(feed.items[1].media, []);
  const withPhoto = feed.items.find(
    (item) => item.sourceUrl === posts[1].url
  );
  const withoutPhoto = feed.items.find(
    (item) => item.sourceUrl === posts[0].url
  );
  assert.ok(withPhoto);
  assert.ok(withoutPhoto);
  assert.deepStrictEqual(withoutPhoto.media, []);
  assert.strictEqual(withPhoto.media.length, 1);
  assert.strictEqual(withPhoto.media[0].type, "image");
  assert.strictEqual(withPhoto.media[0].url, photo);
  console.log("news-feed media additive PASS");
}

console.log("news-feed-test: ALL PASS");
