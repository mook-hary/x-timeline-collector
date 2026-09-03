/**
 * X-MEDIA-METADATA-001 — media metadata extract, sanitize, pipeline hold.
 * Fake DOM only. No live X, no OpenAI. Run: node test/tweet-media-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  extractMediaFromArticle,
  canonicalizeMediaList,
  sanitizeMediaUrl,
  meaningfulAlt,
} = require("../lib/tweet-media");
const {
  toCanonicalNewPost,
  mergeWithExisting,
  mergeFetchedPosts,
} = require("../connect");
const { buildDailyScope } = require("../lib/daily-scope");
const { buildNewsFeed, SCHEMA_VERSION } = require("../lib/news-feed");
const { buildDigestReader } = require("../lib/digest-reader");
const { mergeDigestConfig, DEFAULT_DIGEST_CONFIG } = require("../lib/digest-core");
const { computeInputFingerprint: analyzeFingerprint } = require("../analyze_ai");
const { computeInputFingerprint: enrichFingerprint } = require("../enrich_ai");

const PHOTO =
  "https://pbs.twimg.com/media/CatBench.jpg?format=jpg&name=orig";
const PHOTO2 =
  "https://pbs.twimg.com/media/Second.jpg?format=jpg&name=small";
const AVATAR =
  "https://pbs.twimg.com/profile_images/1/avatar.jpg";
const EMOJI =
  "https://abs.twimg.com/emoji/v2/svg/1f600.svg";
const QUOTE_PHOTO =
  "https://pbs.twimg.com/media/Quoted.jpg?format=jpg&name=orig";
const POSTER =
  "https://pbs.twimg.com/tweet_video_thumb/Clip.jpg";
const ICON =
  "https://abs.twimg.com/hashflags/icon.png";

function el(tag, attrs, children) {
  if (Array.isArray(attrs)) {
    children = attrs;
    attrs = {};
  }
  const nodeAttrs = Object.assign({}, attrs || {});
  if (nodeAttrs.testid) {
    nodeAttrs["data-testid"] = nodeAttrs.testid;
    delete nodeAttrs.testid;
  }
  const node = {
    tagName: String(tag).toUpperCase(),
    parentNode: null,
    childNodes: [],
    attrs: nodeAttrs,
    getAttribute(name) {
      const value = this.attrs[name];
      return value == null ? null : String(value);
    },
  };
  for (const child of children || []) {
    child.parentNode = node;
    node.childNodes.push(child);
  }
  return node;
}

function articleFixture(extraChildren) {
  return el("article", [
    el("div", { testid: "Tweet-User-Avatar" }, [
      el("img", { src: AVATAR, alt: "Author" }),
    ]),
    el("div", { testid: "User-Name" }, [el("span", {}, [])]),
    el("div", { testid: "tweetText" }, [
      el("img", { src: EMOJI, alt: "😀" }),
    ]),
    ...(extraChildren || []),
  ]);
}

function sampleMedia(overrides) {
  return Object.assign(
    {
      type: "image",
      url: PHOTO,
      previewUrl: PHOTO,
      altText: "A cat on a bench",
      width: null,
      height: null,
    },
    overrides || {}
  );
}

function rawPost(overrides) {
  return Object.assign(
    {
      authorName: "Author",
      authorHandle: "@cat",
      postedAt: "2026-08-31T00:00:00.000Z",
      text: "",
      url: "https://x.com/cat/status/2095202354211729859",
      media: [sampleMedia()],
    },
    overrides || {}
  );
}

function dailyEnriched(overrides) {
  return Object.assign(
    {
      authorName: "Author",
      authorHandle: "@cat",
      postedAt: "2026-08-31T00:00:00.000Z",
      collectedAt: "2026-08-31T03:00:00.000Z",
      text: "",
      url: "https://x.com/cat/status/2095202354211729859",
      finalAnalysis: { category: "その他" },
      enrichment: {
        informationValue: 1,
        personalRelevance: 1,
        impact: 1,
        attentionSignal: 1,
        importance: 1,
        summary: "本文が空の投稿",
        reason: "test",
        tags: [],
      },
      media: [sampleMedia()],
    },
    overrides || {}
  );
}

function simulateAnalyze(post) {
  return Object.assign({}, post, {
    analysis: { category: "その他", score: 1, confidence: "low" },
  });
}

function simulateAiMerge(post) {
  return Object.assign({}, post, {
    finalAnalysis: {
      source: "ai",
      category: "その他",
      confidence: 0.2,
      reason: "本文が空",
      tags: [],
    },
  });
}

function simulateEnrich(post) {
  const rest = Object.assign({}, post);
  delete rest.enrichment;
  return Object.assign({}, rest, {
    enrichment: {
      source: "ai",
      importance: 1,
      summary: "本文が空の投稿",
      tags: [],
      reason: "empty",
    },
  });
}

function payloadSourceSlice(fileName, startFn, endFn) {
  const src = fs.readFileSync(path.join(__dirname, "..", fileName), "utf8");
  const start = src.indexOf(startFn);
  const end = src.indexOf(endFn);
  assert.ok(start >= 0 && end > start, `${fileName} ${startFn}`);
  return src.slice(start, end);
}

{
  const media = extractMediaFromArticle(
    articleFixture([
      el("div", { testid: "tweetPhoto" }, [
        el("img", { src: PHOTO, alt: "A cat on a bench" }),
      ]),
    ])
  );
  assert.strictEqual(media.length, 1);
  assert.deepStrictEqual(media[0], {
    type: "image",
    url: PHOTO,
    previewUrl: PHOTO,
    altText: "A cat on a bench",
    width: null,
    height: null,
  });
  console.log("tweet-media one image PASS");
}

{
  const media = extractMediaFromArticle(
    articleFixture([
      el("div", { testid: "tweetPhoto" }, [
        el("img", { src: PHOTO, alt: "First photo" }),
      ]),
      el("div", { testid: "tweetPhoto" }, [
        el("img", { src: PHOTO2, alt: "Second photo", width: "1200", height: "800" }),
      ]),
    ])
  );
  assert.strictEqual(media.length, 2);
  assert.strictEqual(media[0].url, PHOTO);
  assert.strictEqual(media[1].url, PHOTO2);
  assert.strictEqual(media[1].width, 1200);
  assert.strictEqual(media[1].height, 800);
  console.log("tweet-media multiple images PASS");
}

{
  const media = extractMediaFromArticle(articleFixture([]));
  assert.deepStrictEqual(media, []);
  console.log("tweet-media no media PASS");
}

{
  const media = extractMediaFromArticle(
    articleFixture([
      el("div", { testid: "like" }, [
        el("img", { src: ICON, alt: "Like" }),
      ]),
    ])
  );
  assert.deepStrictEqual(media, []);
  console.log("tweet-media avatar/emoji/icon excluded PASS");
}

{
  const media = extractMediaFromArticle(
    articleFixture([
      el("div", { testid: "tweetPhoto" }, [
        el("img", { src: PHOTO, alt: "Parent photo" }),
      ]),
      el("div", { testid: "QuoteTweet" }, [
        el("div", { testid: "tweetPhoto" }, [
          el("img", { src: QUOTE_PHOTO, alt: "Quoted photo" }),
        ]),
      ]),
      el("article", [
        el("div", { testid: "tweetPhoto" }, [
          el("img", { src: QUOTE_PHOTO, alt: "Nested article photo" }),
        ]),
      ]),
    ])
  );
  assert.strictEqual(media.length, 1);
  assert.strictEqual(media[0].url, PHOTO);
  assert.ok(media.every((item) => item.url !== QUOTE_PHOTO));
  console.log("tweet-media quoted post excluded PASS");
}

{
  const media = extractMediaFromArticle(
    articleFixture([
      el("div", { testid: "videoPlayer" }, [
        el("video", { poster: POSTER }),
      ]),
    ])
  );
  assert.strictEqual(media.length, 1);
  assert.deepStrictEqual(media[0], {
    type: "video",
    url: null,
    previewUrl: POSTER,
    altText: null,
    width: null,
    height: null,
  });
  console.log("tweet-media video poster PASS");
}

{
  const gifMedia = extractMediaFromArticle(
    articleFixture([
      el("div", { testid: "tweetPhoto" }, [
        el("div", { testid: "gif" }, [
          el("video", { poster: POSTER, "aria-label": "Embedded GIF" }),
        ]),
      ]),
    ])
  );
  assert.strictEqual(gifMedia.length, 1);
  assert.strictEqual(gifMedia[0].type, "gif");
  assert.strictEqual(gifMedia[0].url, null);
  assert.strictEqual(gifMedia[0].previewUrl, POSTER);
  console.log("tweet-media gif poster PASS");
}

{
  const media = extractMediaFromArticle(
    articleFixture([
      el("div", { testid: "tweetPhoto" }, [el("img", { src: PHOTO })]),
    ])
  );
  assert.strictEqual(media[0].altText, null);
  console.log("tweet-media missing alt PASS");
}

{
  assert.strictEqual(meaningfulAlt(null), null);
  assert.strictEqual(meaningfulAlt(""), null);
  assert.strictEqual(meaningfulAlt("Image"), null);
  assert.strictEqual(meaningfulAlt("image"), null);
  assert.strictEqual(meaningfulAlt("画像"), null);
  assert.strictEqual(meaningfulAlt("写真"), null);
  assert.strictEqual(meaningfulAlt("A cat on a bench"), "A cat on a bench");
  const generic = extractMediaFromArticle(
    articleFixture([
      el("div", { testid: "tweetPhoto" }, [
        el("img", { src: PHOTO, alt: "Image" }),
      ]),
    ])
  );
  assert.strictEqual(generic[0].altText, null);
  console.log("tweet-media generic alt null PASS");
}

{
  const canonical = toCanonicalNewPost(rawPost(), "2026-08-31T03:00:00.000Z");
  assert.strictEqual(canonical.authorName, "Author");
  assert.strictEqual(canonical.authorHandle, "@cat");
  assert.strictEqual(canonical.postedAt, "2026-08-31T00:00:00.000Z");
  assert.strictEqual(canonical.text, "");
  assert.strictEqual(canonical.url, "https://x.com/cat/status/2095202354211729859");
  assert.strictEqual(canonical.collectedAt, "2026-08-31T03:00:00.000Z");
  assert.strictEqual(canonical.media.length, 1);
  assert.strictEqual(canonical.media[0].type, "image");
  assert.strictEqual(canonical.media[0].url, PHOTO);

  const empty = toCanonicalNewPost(
    {
      authorName: "A",
      authorHandle: "@a",
      postedAt: "2026-08-31T00:00:00.000Z",
      text: "hello",
      url: "https://x.com/a/status/1",
    },
    "2026-08-31T03:00:00.000Z"
  );
  assert.deepStrictEqual(empty.media, []);
  console.log("tweet-media canonical post PASS");
}

{
  const canonical = toCanonicalNewPost(rawPost(), "2026-08-31T03:00:00.000Z");
  const scope = buildDailyScope({
    collectedAt: canonical.collectedAt,
    fetchedFromScreen: 1,
    newPosts: 1,
    duplicateUrlsSkipped: 0,
    totalStored: 1,
    posts: [canonical],
  });
  assert.strictEqual(scope.itemCount, 1);
  assert.deepStrictEqual(scope.posts[0].media, canonical.media);
  console.log("tweet-media daily scope hold PASS");
}

{
  const canonical = toCanonicalNewPost(rawPost(), "2026-08-31T03:00:00.000Z");
  const analyzed = simulateAnalyze(canonical);
  const aiMerged = simulateAiMerge(analyzed);
  const enriched = simulateEnrich(aiMerged);
  assert.deepStrictEqual(analyzed.media, canonical.media);
  assert.deepStrictEqual(aiMerged.media, canonical.media);
  assert.deepStrictEqual(enriched.media, canonical.media);
  assert.strictEqual(analyzed.analysis.category, "その他");
  assert.strictEqual(aiMerged.finalAnalysis.source, "ai");
  assert.strictEqual(enriched.enrichment.importance, 1);
  console.log("tweet-media pipeline spread hold PASS");
}

{
  const posts = [];
  const seen = new Set();
  mergeFetchedPosts(posts, seen, [
    rawPost({ url: "https://x.com/cat/status/1" }),
    rawPost({ url: "https://x.com/cat/status/1", media: [] }),
    rawPost({ url: "https://x.com/cat/status/2", media: [] }),
  ]);
  assert.strictEqual(posts.length, 2);
  assert.strictEqual(posts[0].media.length, 1);
  assert.deepStrictEqual(posts[1].media, []);
  console.log("tweet-media mergeFetchedPosts PASS");
}

{
  const existing = [
    {
      authorName: "Old",
      authorHandle: "@old",
      postedAt: "2026-01-01T00:00:00.000Z",
      text: "legacy",
      url: "https://x.com/old/status/1",
      collectedAt: "2026-01-01T03:00:00.000Z",
    },
  ];
  const result = mergeWithExisting(
    existing,
    [rawPost({ url: "https://x.com/cat/status/2" })],
    "2026-08-31T03:00:00.000Z"
  );
  assert.strictEqual(result.merged.length, 2);
  assert.ok(Array.isArray(result.merged[0].media));
  assert.strictEqual(result.merged[0].media.length, 1);
  assert.strictEqual(result.merged[1].url, existing[0].url);
  assert.ok(!Object.prototype.hasOwnProperty.call(result.merged[1], "media"));
  console.log("tweet-media legacy archive not backfilled PASS");
}

{
  assert.deepStrictEqual(canonicalizeMediaList(undefined), []);
  assert.deepStrictEqual(canonicalizeMediaList(null), []);
  assert.deepStrictEqual(canonicalizeMediaList({ type: "image" }), []);
  const feed = buildNewsFeed([
    {
      authorName: "Old",
      authorHandle: "@old",
      postedAt: "2026-01-01T00:00:00.000Z",
      collectedAt: "2026-01-01T03:00:00.000Z",
      url: "https://x.com/old/status/1",
      finalAnalysis: { category: "AI" },
      enrichment: { importance: 3, summary: "legacy summary" },
    },
  ]);
  assert.deepStrictEqual(feed.items[0].media, []);
  console.log("tweet-media old post missing media PASS");
}

{
  assert.strictEqual(
    sanitizeMediaUrl(
      "https://pbs.twimg.com/media/x.jpg?format=jpg&name=orig"
    ),
    "https://pbs.twimg.com/media/x.jpg?format=jpg&name=orig"
  );
  assert.strictEqual(
    sanitizeMediaUrl(
      "https://pbs.twimg.com/media/x.jpg?format=jpg&name=orig&token=SECRET"
    ),
    null
  );
  assert.strictEqual(
    sanitizeMediaUrl(
      "https://pbs.twimg.com/media/x.jpg?access_token=abc&format=jpg"
    ),
    null
  );
  assert.strictEqual(sanitizeMediaUrl("https://evil.example/media.jpg"), null);
  assert.strictEqual(sanitizeMediaUrl("blob:https://x.com/1"), null);
  assert.strictEqual(sanitizeMediaUrl(AVATAR), null);
  assert.strictEqual(sanitizeMediaUrl(EMOJI), null);
  assert.strictEqual(
    sanitizeMediaUrl("https://user:pass@pbs.twimg.com/media/x.jpg"),
    null
  );
  const dropped = canonicalizeMediaList([
    {
      type: "image",
      url: "https://pbs.twimg.com/media/x.jpg?format=jpg&name=large&sig=abc",
      previewUrl: "https://pbs.twimg.com/media/x.jpg?token=1",
    },
  ]);
  assert.deepStrictEqual(dropped, []);
  console.log("tweet-media unsafe URL reject PASS");
}

{
  const posts = [dailyEnriched(), dailyEnriched({
    url: "https://x.com/cat/status/2",
    media: [],
    enrichment: {
      informationValue: 5,
      personalRelevance: 5,
      impact: 5,
      attentionSignal: 2,
      importance: 5,
      summary: "high",
      reason: "test",
      tags: [],
    },
  })];
  const feed = buildNewsFeed(posts, {
    generatedAt: "2026-08-31T03:50:00.000Z",
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
  });
  assert.strictEqual(feed.schemaVersion, SCHEMA_VERSION);
  assert.strictEqual(feed.schemaVersion, 1);
  assert.strictEqual(feed.scope.itemCount, posts.length);
  assert.strictEqual(feed.items.length, posts.length);
  const withMedia = feed.items.find((item) => item.sourceUrl === posts[0].url);
  const noMedia = feed.items.find((item) => item.sourceUrl === posts[1].url);
  assert.strictEqual(withMedia.media.length, 1);
  assert.strictEqual(withMedia.media[0].type, "image");
  assert.strictEqual(withMedia.media[0].url, PHOTO);
  assert.deepStrictEqual(noMedia.media, []);
  assert.deepStrictEqual(withMedia.scores, {
    informationValue: 1,
    personalRelevance: 1,
    impact: 1,
    attentionSignal: 1,
    importance: 1,
  });
  console.log("tweet-media news-feed export PASS");
}

{
  const config = mergeDigestConfig(DEFAULT_DIGEST_CONFIG);
  const posts = [
    dailyEnriched({
      url: "https://x.com/a/status/1",
      enrichment: {
        informationValue: 1,
        personalRelevance: 1,
        impact: 1,
        attentionSignal: 1,
        importance: 1,
        summary: "low title",
        reason: "test",
        tags: [],
      },
    }),
    dailyEnriched({
      url: "https://x.com/b/status/2",
      media: [],
      enrichment: {
        informationValue: 5,
        personalRelevance: 5,
        impact: 5,
        attentionSignal: 2,
        importance: 5,
        summary: "high title",
        reason: "test",
        tags: [],
      },
    }),
  ];
  const stripped = posts.map((post) => {
    const copy = Object.assign({}, post);
    delete copy.media;
    return copy;
  });
  const feed = buildNewsFeed(posts, { config });
  const baseline = buildNewsFeed(stripped, { config });
  assert.strictEqual(feed.scope.itemCount, baseline.scope.itemCount);
  assert.strictEqual(feed.items.length, baseline.items.length);
  assert.deepStrictEqual(
    feed.items.map((item) => item.sourceUrl),
    baseline.items.map((item) => item.sourceUrl)
  );
  assert.deepStrictEqual(
    feed.items.map((item) => item.title),
    baseline.items.map((item) => item.title)
  );
  assert.deepStrictEqual(
    feed.items.map((item) => item.summary),
    baseline.items.map((item) => item.summary)
  );
  assert.deepStrictEqual(
    feed.items.map((item) => item.scores),
    baseline.items.map((item) => item.scores)
  );
  console.log("tweet-media feed item count invariant PASS");
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tweet-media-reader-"));
  const result = buildDigestReader({
    rootDir: root,
    outputDir: path.join(root, "output", "digest-reader"),
    posts: [dailyEnriched()],
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    profile: false,
  });
  const page = fs.readFileSync(result.htmlPath, "utf8");
  assert.ok(page.includes("card"));
  assert.ok(!page.includes("pbs.twimg.com"));
  assert.ok(!/<img\b/i.test(page), "reader must not render tweet images yet");
  const feed = JSON.parse(fs.readFileSync(result.newsFeedPath, "utf8"));
  assert.strictEqual(feed.items[0].media.length, 1);
  console.log("tweet-media reader ignores media field PASS");
}

{
  const post = {
    authorHandle: "@cat",
    text: "",
    analysis: { category: "その他", confidence: "low" },
    finalAnalysis: { source: "keyword", category: "その他", confidence: 0.5 },
    media: [sampleMedia()],
  };
  const without = Object.assign({}, post);
  delete without.media;
  assert.strictEqual(analyzeFingerprint(post), analyzeFingerprint(without));
  assert.strictEqual(enrichFingerprint(post), enrichFingerprint(without));

  const aiPayload = payloadSourceSlice(
    "analyze_ai.js",
    "function buildAiPayload",
    "function truncateReason"
  );
  const enrichPayload = payloadSourceSlice(
    "enrich_ai.js",
    "function buildEnrichPayload",
    "function validateEnrichResult"
  );
  assert.ok(!/\bmedia\b/.test(aiPayload));
  assert.ok(!/\bmedia\b/.test(enrichPayload));
  console.log("tweet-media no AI image payload PASS");
}

{
  const connectSrc = fs.readFileSync(
    path.join(__dirname, "../connect.js"),
    "utf8"
  );
  assert.ok(connectSrc.includes("extractMediaFromArticle"));
  assert.ok(connectSrc.includes("tweet-media.js"));
  console.log("tweet-media collect wiring PASS");
}

console.log("tweet-media-test: ALL PASS");
