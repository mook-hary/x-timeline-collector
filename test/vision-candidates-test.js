/**
 * X-VISION-CANDIDATES-001 — deterministic Vision routing.
 * No Vision / OpenAI / X. Run: node test/vision-candidates-test.js
 */
const assert = require("assert");
const {
  DEFAULT_VISION_TEXT_THRESHOLD,
  VISION_TEXT_THRESHOLD_ENV,
  VISION_CANDIDATE_REASONS,
  unicodeTextLength,
  resolveVisionTextThreshold,
  isUsableVisionMedia,
  evaluateVisionCandidate,
  buildVisionCandidates,
} = require("../lib/vision-candidates");

const PHOTO = "https://pbs.twimg.com/media/CatBench.jpg?format=jpg&name=orig";
const POSTER = "https://pbs.twimg.com/tweet_video_thumb/Clip.jpg";

function imageMedia(overrides) {
  return Object.assign(
    {
      type: "image",
      url: PHOTO,
      previewUrl: PHOTO,
      altText: null,
      width: null,
      height: null,
    },
    overrides || {}
  );
}

function videoMedia(overrides) {
  return Object.assign(
    {
      type: "video",
      url: null,
      previewUrl: POSTER,
      altText: null,
      width: null,
      height: null,
    },
    overrides || {}
  );
}

function post(overrides) {
  return Object.assign(
    {
      authorName: "Author",
      authorHandle: "@user",
      postedAt: "2026-09-03T00:00:00.000Z",
      text: "",
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
      analysis: { category: "AI", confidence: "high" },
    },
    overrides || {}
  );
}

{
  assert.strictEqual(DEFAULT_VISION_TEXT_THRESHOLD, 40);
  assert.strictEqual(resolveVisionTextThreshold({}, {}), 40);
  assert.strictEqual(
    resolveVisionTextThreshold({}, { [VISION_TEXT_THRESHOLD_ENV]: "12" }),
    12
  );
  assert.strictEqual(
    resolveVisionTextThreshold({}, { [VISION_TEXT_THRESHOLD_ENV]: "nope" }),
    40
  );
  assert.strictEqual(resolveVisionTextThreshold({ threshold: 0 }, {}), 0);
  assert.throws(
    () => resolveVisionTextThreshold({ threshold: -1 }, {}),
    /integer >= 0/
  );
  assert.throws(
    () => resolveVisionTextThreshold({ threshold: 1.5 }, {}),
    /integer >= 0/
  );
  console.log("vision-candidates config PASS");
}

{
  const result = evaluateVisionCandidate(post({ text: "", media: [imageMedia()] }));
  assert.deepStrictEqual(result, {
    candidate: true,
    reason: VISION_CANDIDATE_REASONS.SHORT_TEXT_WITH_MEDIA,
    textLength: 0,
    mediaCount: 1,
    threshold: 40,
  });
  console.log("vision-candidates empty text + image PASS");
}

{
  const text = "あ".repeat(40);
  const result = evaluateVisionCandidate(post({ text, media: [imageMedia()] }));
  assert.strictEqual(result.textLength, 40);
  assert.strictEqual(result.candidate, true);
  assert.strictEqual(result.reason, "short_text_with_media");
  console.log("vision-candidates length 40 + media PASS");
}

{
  const text = "あ".repeat(41);
  const result = evaluateVisionCandidate(post({ text, media: [imageMedia()] }));
  assert.strictEqual(result.textLength, 41);
  assert.strictEqual(result.candidate, false);
  assert.strictEqual(result.reason, "text_over_threshold");
  console.log("vision-candidates length 41 + media PASS");
}

{
  const result = evaluateVisionCandidate(post({ text: "短い", media: [] }));
  assert.strictEqual(result.candidate, false);
  assert.strictEqual(result.reason, "no_usable_media");
  assert.strictEqual(result.mediaCount, 0);
  console.log("vision-candidates short text + no media PASS");
}

{
  const result = evaluateVisionCandidate(post({ text: "短い", media: [] }));
  assert.strictEqual(result.reason, VISION_CANDIDATE_REASONS.NO_USABLE_MEDIA);
  const missing = evaluateVisionCandidate({ text: "短い" });
  assert.strictEqual(missing.reason, "no_usable_media");
  console.log("vision-candidates media=[] / missing PASS");
}

{
  const result = evaluateVisionCandidate(
    post({ text: "clip", media: [videoMedia()] })
  );
  assert.strictEqual(result.candidate, true);
  assert.strictEqual(result.reason, "short_text_with_media");
  assert.strictEqual(result.mediaCount, 1);
  console.log("vision-candidates video poster PASS");
}

{
  const result = evaluateVisionCandidate(
    post({
      text: "x",
      media: [
        {
          type: "image",
          url: "https://evil.example/x.jpg",
          previewUrl: null,
        },
      ],
    })
  );
  assert.strictEqual(result.candidate, false);
  assert.strictEqual(result.reason, "no_usable_media");
  assert.strictEqual(
    isUsableVisionMedia({ type: "unknown", url: PHOTO, previewUrl: PHOTO }),
    false
  );
  assert.strictEqual(
    isUsableVisionMedia({ type: "video", url: PHOTO, previewUrl: null }),
    false
  );
  console.log("vision-candidates unusable media PASS");
}

{
  const result = evaluateVisionCandidate(post({ text: null, media: [imageMedia()] }));
  assert.strictEqual(result.candidate, true);
  assert.strictEqual(result.textLength, 0);
  const undef = evaluateVisionCandidate(post({ media: [imageMedia()] }));
  delete undef._unused;
  const missingText = { media: [imageMedia()] };
  const fromMissing = evaluateVisionCandidate(missingText);
  assert.strictEqual(fromMissing.candidate, true);
  assert.strictEqual(fromMissing.textLength, 0);
  console.log("vision-candidates null/undefined text PASS");
}

{
  const emoji = "😀".repeat(40);
  assert.strictEqual(emoji.length, 80);
  assert.strictEqual(unicodeTextLength(emoji), 40);
  const atLimit = evaluateVisionCandidate(
    post({ text: emoji, media: [imageMedia()] })
  );
  assert.strictEqual(atLimit.candidate, true);
  const over = evaluateVisionCandidate(
    post({ text: `${emoji}x`, media: [imageMedia()] })
  );
  assert.strictEqual(over.textLength, 41);
  assert.strictEqual(over.candidate, false);
  console.log("vision-candidates unicode length PASS");
}

{
  const result = evaluateVisionCandidate(
    post({
      text: "pics",
      media: [imageMedia(), imageMedia({ url: PHOTO, previewUrl: PHOTO }), videoMedia()],
    })
  );
  assert.strictEqual(result.candidate, true);
  assert.strictEqual(result.mediaCount, 3);
  console.log("vision-candidates multiple media count PASS");
}

{
  const source = post({
    text: "keep",
    media: [imageMedia()],
    enrichment: { importance: 5, summary: "do not touch" },
  });
  const before = JSON.stringify(source);
  evaluateVisionCandidate(source);
  buildVisionCandidates([source]);
  assert.strictEqual(JSON.stringify(source), before);
  assert.strictEqual(source.enrichment.importance, 5);
  assert.strictEqual(source.analysis.category, "AI");
  console.log("vision-candidates no mutation / scores untouched PASS");
}

{
  const posts = [
    post({ url: "https://x.com/a/status/1", text: "long enough text to skip vision xxxxxxxxxx", media: [imageMedia()] }),
    post({ url: "https://x.com/b/status/2", text: "", media: [imageMedia()] }),
    post({ url: "https://x.com/c/status/3", text: "short", media: [] }),
  ];
  const rows = buildVisionCandidates(posts);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].post, posts[0]);
  assert.strictEqual(rows[1].post, posts[1]);
  assert.strictEqual(rows[2].post, posts[2]);
  assert.deepStrictEqual(
    rows.map((row) => row.candidate),
    [false, true, false]
  );
  console.log("vision-candidates list order PASS");
}

{
  const longish = "あ".repeat(10);
  const overDefault = evaluateVisionCandidate(
    post({ text: longish, media: [imageMedia()] }),
    { threshold: 9 }
  );
  assert.strictEqual(overDefault.candidate, false);
  assert.strictEqual(overDefault.threshold, 9);
  const under = evaluateVisionCandidate(
    post({ text: longish, media: [imageMedia()] }),
    { threshold: 10 }
  );
  assert.strictEqual(under.candidate, true);
  console.log("vision-candidates threshold override PASS");
}

{
  const empty = evaluateVisionCandidate(
    post({ text: "", media: [imageMedia()] }),
    { threshold: 0 }
  );
  assert.strictEqual(empty.candidate, true);
  const one = evaluateVisionCandidate(
    post({ text: "x", media: [imageMedia()] }),
    { threshold: 0 }
  );
  assert.strictEqual(one.candidate, false);
  assert.strictEqual(one.reason, "text_over_threshold");
  console.log("vision-candidates threshold 0 PASS");
}

{
  assert.strictEqual(evaluateVisionCandidate(null).reason, "no_usable_media");
  assert.strictEqual(evaluateVisionCandidate(undefined).reason, "no_usable_media");
  assert.strictEqual(evaluateVisionCandidate("post").reason, "no_usable_media");
  assert.strictEqual(evaluateVisionCandidate([]).reason, "no_usable_media");
  assert.deepStrictEqual(buildVisionCandidates(null), []);
  assert.deepStrictEqual(buildVisionCandidates(undefined), []);
  console.log("vision-candidates invalid shape PASS");
}

console.log("vision-candidates-test: ALL PASS");
