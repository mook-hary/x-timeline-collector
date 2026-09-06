/**
 * X-VISION-ANALYZE-001 — isolated Vision stage.
 * Mock API only. No real OpenAI / X. Run: node test/vision-analyze-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  evaluateVisionCandidate,
  VISION_CANDIDATE_REASONS,
  unicodeTextLength,
} = require("../lib/vision-candidates");
const {
  VISION_GROUNDING_PROMPT,
  VIDEO_POSTER_NOTE,
  DEFAULT_VISION_MODEL,
  analyzeVisionPosts,
  buildVisionMediaIdentity,
  collectUsableVisionInputs,
  buildVisionExecutionContract,
  findMatchingVisionCacheEntry,
  evaluateVisionCandidate: reusedEvaluate,
} = require("../lib/vision-analyze");

const PHOTO = "https://pbs.twimg.com/media/CatBench.jpg?format=jpg&name=orig";
const PHOTO_SMALL = "https://pbs.twimg.com/media/CatBench.jpg?format=jpg&name=small";
const PHOTO_OTHER_PATH = "https://pbs.twimg.com/media/OtherCat.jpg?format=jpg&name=orig";
const PHOTO_PNG = "https://pbs.twimg.com/media/CatBench.jpg?format=png&name=orig";
const POSTER = "https://pbs.twimg.com/tweet_video_thumb/Clip.jpg";
const UNSAFE = "https://evil.example/secret.jpg";

function imageMedia(url) {
  return {
    type: "image",
    url: url || PHOTO,
    previewUrl: url || PHOTO,
    altText: null,
    width: null,
    height: null,
  };
}

function videoMedia(url) {
  return {
    type: "video",
    url: null,
    previewUrl: url || POSTER,
    altText: null,
    width: null,
    height: null,
  };
}

function post(overrides) {
  return Object.assign(
    {
      authorName: "Author",
      authorHandle: "@user",
      postedAt: "2026-09-03T00:00:00.000Z",
      text: "短い",
      url: "https://x.com/user/status/1",
      collectedAt: "2026-09-03T03:00:00.000Z",
      media: [imageMedia()],
      enrichment: {
        informationValue: 4,
        personalRelevance: 3,
        impact: 2,
        attentionSignal: 1,
        importance: 3,
      },
      analysis: { category: "AI", confidence: "high", reason: "kw" },
      finalAnalysis: { category: "AI", confidence: 0.9 },
    },
    overrides || {}
  );
}

function okBody(overrides) {
  return Object.assign(
    {
      observations: "A wooden bench sits beside a tree.",
      visibleText: null,
      uncertainties: null,
    },
    overrides || {}
  );
}

function mockRequest(impl) {
  const calls = [];
  const requestFn = async (request) => {
    calls.push(request);
    if (typeof impl === "function") return impl(request, calls.length);
    if (impl instanceof Error) throw impl;
    return impl == null ? okBody() : impl;
  };
  return { calls, requestFn };
}

function scoresOf(item) {
  return {
    analysis: item.analysis,
    finalAnalysis: item.finalAnalysis,
    enrichment: item.enrichment,
    category: item.analysis && item.analysis.category,
    confidence: item.analysis && item.analysis.confidence,
    informationValue: item.enrichment && item.enrichment.informationValue,
    personalRelevance: item.enrichment && item.enrichment.personalRelevance,
    impact: item.enrichment && item.enrichment.impact,
    attentionSignal: item.enrichment && item.enrichment.attentionSignal,
    importance: item.enrichment && item.enrichment.importance,
  };
}

async function run(posts, extras) {
  return analyzeVisionPosts(posts, extras || {});
}

async function main() {
{
  assert.strictEqual(reusedEvaluate, evaluateVisionCandidate);
  const src = fs.readFileSync(
    path.join(__dirname, "../lib/vision-analyze.js"),
    "utf8"
  );
  assert.ok(src.includes('require("./vision-candidates")'));
  assert.ok(!/unicodeTextLength\s*=/.test(src));
  assert.ok(!/textLength\s*>\s*threshold/.test(src));
  console.log("1/23 unicode candidate rule reused PASS");
}

{
  const source = post({ text: "long enough text to skip vision xxxxxxxxxx" });
  const before = JSON.stringify(source);
  const { calls, requestFn } = mockRequest();
  const result = await run([source], { requestFn });
  assert.strictEqual(result.summary.apiRequests, 0);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(result.posts[0].vision.status, "skipped");
  assert.strictEqual(
    result.posts[0].vision.skipReason,
    VISION_CANDIDATE_REASONS.TEXT_OVER_THRESHOLD
  );
  assert.strictEqual(result.posts[0].vision.observations, null);
  assert.strictEqual(JSON.stringify(source), before);
  console.log("1. non-candidate skipped API 0 PASS");
}

{
  const { calls, requestFn } = mockRequest(okBody());
  const result = await run([post({ text: "pic" })], { requestFn });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(result.summary.apiRequests, 1);
  assert.strictEqual(calls[0].mediaUrls.length, 1);
  assert.strictEqual(result.posts[0].vision.status, "ok");
  console.log("2. image candidate one request PASS");
}

{
  const { calls, requestFn } = mockRequest(okBody({ observations: "A still frame." }));
  const result = await run(
    [post({ text: "clip", media: [videoMedia()] })],
    { requestFn }
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].mediaUrls[0], POSTER);
  const userText = calls[0].input[0].content[0].text;
  assert.ok(userText.includes(VIDEO_POSTER_NOTE));
  assert.ok(/poster\/frame/i.test(userText));
  assert.ok(/Do not infer what happens in the full video/.test(userText));
  assert.strictEqual(result.posts[0].vision.status, "ok");
  console.log("3/24. video poster one request + prompt PASS");
}

{
  const photos = [
    imageMedia("https://pbs.twimg.com/media/One.jpg?format=jpg&name=orig"),
    imageMedia("https://pbs.twimg.com/media/Two.jpg?format=jpg&name=orig"),
    imageMedia("https://pbs.twimg.com/media/Three.jpg?format=jpg&name=orig"),
  ];
  const { calls, requestFn } = mockRequest(okBody());
  const result = await run([post({ text: "pics", media: photos })], { requestFn });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(
    calls[0].mediaUrls,
    photos.map((item) => item.url)
  );
  assert.strictEqual(result.posts[0].vision.mediaCountAnalyzed, 3);
  console.log("4. multi-image one request all images PASS");
}

{
  const photos = [
    imageMedia("https://pbs.twimg.com/media/A.jpg?format=jpg&name=orig"),
    imageMedia("https://pbs.twimg.com/media/B.jpg?format=jpg&name=orig"),
  ];
  const { calls, requestFn } = mockRequest(okBody());
  await run([post({ text: "ab", media: photos })], { requestFn });
  assert.deepStrictEqual(calls[0].mediaUrls, [
    "https://pbs.twimg.com/media/A.jpg?format=jpg&name=orig",
    "https://pbs.twimg.com/media/B.jpg?format=jpg&name=orig",
  ]);
  console.log("5. media order preserved PASS");
}

{
  const media = [
    imageMedia(),
    {
      type: "image",
      url: UNSAFE,
      previewUrl: UNSAFE,
      altText: null,
      width: null,
      height: null,
    },
  ];
  const { calls, requestFn } = mockRequest(okBody());
  await run([post({ text: "mix", media })], { requestFn });
  assert.deepStrictEqual(calls[0].mediaUrls, [PHOTO]);
  const onlyUnsafe = await run(
    [
      post({
        text: "bad",
        media: [{ type: "image", url: UNSAFE, previewUrl: UNSAFE }],
      }),
    ],
    { requestFn }
  );
  assert.strictEqual(onlyUnsafe.summary.apiRequests, 0);
  assert.strictEqual(onlyUnsafe.posts[0].vision.status, "skipped");
  console.log("6. unsafe media not sent PASS");
}

{
  const { requestFn } = mockRequest(
    okBody({
      observations: "Two lines of visible facts about the scene.",
      visibleText: "EXIT",
      uncertainties: "Sign is partly cropped.",
    })
  );
  const result = await run([post({ text: "ok" })], {
    requestFn,
    model: "gpt-5-mini",
    now: () => "2026-09-06T00:00:00.000Z",
  });
  const vision = result.posts[0].vision;
  assert.strictEqual(vision.schemaVersion, 1);
  assert.strictEqual(vision.status, "ok");
  assert.strictEqual(vision.skipReason, null);
  assert.strictEqual(vision.observations, "Two lines of visible facts about the scene.");
  assert.strictEqual(vision.visibleText, "EXIT");
  assert.strictEqual(vision.uncertainties, "Sign is partly cropped.");
  assert.strictEqual(vision.mediaCountAnalyzed, 1);
  assert.deepStrictEqual(vision.mediaIdentities, [
    buildVisionMediaIdentity(PHOTO),
  ]);
  assert.strictEqual(vision.model, "gpt-5-mini");
  assert.strictEqual(vision.promptVersion, "1");
  assert.strictEqual(vision.analyzedAt, "2026-09-06T00:00:00.000Z");
  assert.ok(!("contentType" in vision));
  assert.ok(!("confidence" in vision));
  assert.ok(!("visualValue" in vision));
  console.log("7. structured response normalized PASS");
}

{
  const { requestFn } = mockRequest(okBody({ visibleText: null, uncertainties: null }));
  const result = await run([post({ text: "n" })], { requestFn });
  assert.strictEqual(result.posts[0].vision.status, "ok");
  assert.strictEqual(result.posts[0].vision.visibleText, null);
  assert.strictEqual(result.posts[0].vision.uncertainties, null);
  const empty = await run([post({ text: "e", url: "https://x.com/user/status/9" })], {
    requestFn: async () => okBody({ visibleText: "", uncertainties: "   " }),
  });
  assert.strictEqual(empty.posts[0].vision.visibleText, null);
  assert.strictEqual(empty.posts[0].vision.uncertainties, null);
  console.log("8/9. visibleText/uncertainties null accepted PASS");
}

{
  const source = post({ text: "badjson", url: "https://x.com/user/status/10" });
  const { requestFn } = mockRequest({ observations: 1, visibleText: null });
  const result = await run([source], { requestFn });
  assert.strictEqual(result.posts.length, 1);
  assert.strictEqual(result.posts[0].vision.status, "failed");
  assert.strictEqual(result.posts[0].vision.observations, null);
  assert.strictEqual(result.posts[0].vision.visibleText, null);
  assert.strictEqual(result.posts[0].url, source.url);
  assert.ok(!result.posts[0].vision.stack);
  console.log("10. invalid structured response failed retained PASS");
}

{
  const source = post({ text: "boom", url: "https://x.com/user/status/11" });
  const { requestFn } = mockRequest(new Error("model exploded"));
  const result = await run([source], { requestFn });
  assert.strictEqual(result.posts[0].vision.status, "failed");
  assert.strictEqual(result.posts[0].url, source.url);
  assert.strictEqual(Object.keys(result.cache).length, 0);
  console.log("11/12. API error failed retained not cached PASS");
}

{
  const cache = {};
  const { calls, requestFn } = mockRequest(okBody());
  const first = await run([post({ text: "hit" })], { requestFn, cache });
  assert.strictEqual(first.posts[0].vision.status, "ok");
  assert.strictEqual(Object.keys(cache).length, 1);
  const second = await run([post({ text: "hit" })], { requestFn, cache });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(second.summary.apiRequests, 0);
  assert.strictEqual(second.summary.cacheHits, 1);
  assert.strictEqual(second.posts[0].vision.status, "ok");
  console.log("13/14. success cached / cache hit API 0 PASS");
}

{
  const cache = {};
  const { calls, requestFn } = mockRequest(okBody());
  await run([post({ text: "size", media: [imageMedia(PHOTO)] })], {
    requestFn,
    cache,
  });
  const again = await run(
    [post({ text: "size", media: [imageMedia(PHOTO_SMALL)] })],
    { requestFn, cache }
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(again.summary.apiRequests, 0);
  assert.strictEqual(again.summary.cacheHits, 1);
  console.log("15. name size variant does not invalidate cache PASS");
}

{
  const cache = {};
  const { calls, requestFn } = mockRequest(okBody());
  await run([post({ text: "path", media: [imageMedia(PHOTO)] })], {
    requestFn,
    cache,
  });
  await run([post({ text: "path", media: [imageMedia(PHOTO_OTHER_PATH)] })], {
    requestFn,
    cache,
  });
  await run([post({ text: "path", media: [imageMedia(PHOTO_PNG)] })], {
    requestFn,
    cache,
  });
  assert.strictEqual(calls.length, 3);
  console.log("16. pathname/format change invalidates cache PASS");
}

{
  const cache = {};
  const { calls, requestFn } = mockRequest(okBody());
  await run([post({ text: "one" })], { requestFn, cache });
  await run([post({ text: "two" })], { requestFn, cache });
  assert.strictEqual(calls.length, 2);
  console.log("17. text change invalidates cache PASS");
}

{
  const source = post({ text: "keep" });
  const before = JSON.stringify(source);
  const scores = scoresOf(source);
  const { requestFn } = mockRequest(okBody());
  const result = await run([source], { requestFn });
  assert.strictEqual(JSON.stringify(source), before);
  assert.ok(!source.vision);
  assert.deepStrictEqual(scoresOf(result.posts[0]), scores);
  assert.deepStrictEqual(result.posts[0].enrichment, source.enrichment);
  assert.deepStrictEqual(result.posts[0].analysis, source.analysis);
  console.log("18/21. source not mutated / scores unchanged PASS");
}

{
  const posts = [
    post({ url: "https://x.com/a/status/1", text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", media: [imageMedia()] }),
    post({ url: "https://x.com/b/status/2", text: "b", media: [imageMedia()] }),
    post({ url: "https://x.com/c/status/3", text: "c", media: [] }),
  ];
  const { requestFn } = mockRequest(okBody());
  const result = await run(posts, { requestFn });
  assert.strictEqual(result.posts.length, posts.length);
  assert.deepStrictEqual(
    result.posts.map((item) => item.url),
    posts.map((item) => item.url)
  );
  assert.deepStrictEqual(
    result.posts.map((item) => item.vision.status),
    ["skipped", "ok", "skipped"]
  );
  console.log("19/20. item count and order preserved PASS");
}

{
  const posts = [
    post({ url: "https://x.com/a/status/1", text: "x", media: [] }),
    post({ url: "https://x.com/b/status/2", text: "y" }),
  ];
  const { calls, requestFn } = mockRequest(okBody());
  const result = await run(posts, { requestFn, dryRun: true });
  assert.strictEqual(result.summary.apiRequests, 0);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(result.summary.dryRun, true);
  assert.strictEqual(result.summary.expectedVisionRequests, 1);
  console.log("22. dry-run API 0 PASS");
}

{
  const emoji = "😀".repeat(40);
  assert.strictEqual(unicodeTextLength(emoji), 40);
  const { calls, requestFn } = mockRequest(okBody());
  const atLimit = await run(
    [post({ text: emoji, url: "https://x.com/u/status/40" })],
    { requestFn }
  );
  assert.strictEqual(atLimit.posts[0].vision.status, "ok");
  const over = await run(
    [post({ text: `${emoji}x`, url: "https://x.com/u/status/41" })],
    { requestFn }
  );
  assert.strictEqual(over.posts[0].vision.status, "skipped");
  assert.strictEqual(over.summary.apiRequests, 0);
  assert.strictEqual(calls.length, 1);
  console.log("23. unicode threshold reused PASS");
}

{
  assert.ok(/person's identity/i.test(VISION_GROUNDING_PROMPT));
  assert.ok(/location/i.test(VISION_GROUNDING_PROMPT));
  assert.ok(/event name/i.test(VISION_GROUNDING_PROMPT));
  assert.ok(/Do NOT infer/i.test(VISION_GROUNDING_PROMPT));
  assert.ok(/post author/i.test(VISION_GROUNDING_PROMPT));
  const { calls, requestFn } = mockRequest(okBody());
  await run([post({ text: "g" })], { requestFn });
  assert.strictEqual(calls[0].instructions, VISION_GROUNDING_PROMPT);
  assert.ok(!/authorName|authorHandle/.test(JSON.stringify(calls[0].input)));
  console.log("25. grounding prompt no-identity/location/event PASS");
}

{
  const a = buildVisionMediaIdentity(PHOTO);
  const b = buildVisionMediaIdentity(PHOTO_SMALL);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.hostname, "pbs.twimg.com");
  assert.ok(a.pathname.includes("/media/CatBench.jpg"));
  assert.strictEqual(a.format, "jpg");
  const png = buildVisionMediaIdentity(PHOTO_PNG);
  assert.strictEqual(png.format, "png");
  const inputs = collectUsableVisionInputs(
    post({ media: [imageMedia(PHOTO), imageMedia(PHOTO_SMALL)] })
  );
  assert.strictEqual(inputs.length, 2);
  const contractA = buildVisionExecutionContract(
    post({ text: "same" }),
    collectUsableVisionInputs(post({ text: "same", media: [imageMedia(PHOTO)] })),
    DEFAULT_VISION_MODEL
  );
  const contractB = buildVisionExecutionContract(
    post({ text: "same" }),
    collectUsableVisionInputs(
      post({ text: "same", media: [imageMedia(PHOTO_SMALL)] })
    ),
    DEFAULT_VISION_MODEL
  );
  assert.strictEqual(contractA.inputFingerprint, contractB.inputFingerprint);
  const cache = {};
  cache["unused"] = { result: { status: "ok" } };
  assert.strictEqual(findMatchingVisionCacheEntry({}, contractA).entry, null);
  console.log("cache identity hostname+pathname+format PASS");
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vision-dry-"));
  const inputPath = path.join(tmp, "daily-scope.json");
  const outputPath = path.join(tmp, "daily-vision.json");
  const cachePath = path.join(tmp, "vision_cache.json");
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      itemCount: 2,
      posts: [
        post({ url: "https://x.com/a/status/100", text: "short", media: [imageMedia()] }),
        post({ url: "https://x.com/b/status/101", text: "nope", media: [] }),
      ],
    }),
    "utf8"
  );
  const spawned = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "../vision_ai.js"),
      "--dry-run",
      "--input",
      inputPath,
      "--output",
      outputPath,
      "--cache",
      cachePath,
    ],
    { encoding: "utf8", cwd: path.join(__dirname, "..") }
  );
  assert.strictEqual(spawned.status, 0, spawned.stderr || spawned.stdout);
  assert.ok(/API requests actually made: 0/.test(spawned.stdout));
  assert.ok(/candidates: 1/.test(spawned.stdout));
  assert.ok(/skipped: 1/.test(spawned.stdout));
  assert.ok(!fs.existsSync(outputPath));
  assert.ok(!fs.existsSync(cachePath));
  console.log("CLI dry-run writes nothing PASS");
}

console.log("vision-analyze-test: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
