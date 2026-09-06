/**
 * X-VISION-INTEGRATE-001 — Vision context for AI Analyze / Enrich.
 * Mock only. No OpenAI. Run: node test/vision-integrate-test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  computeInputFingerprint: analyzeFingerprint,
  buildAiPayload,
  buildExecutionContract: analyzeContract,
  resolveAnalyzePromptVersion,
  ANALYZE_AI_PROMPT_VERSION,
  ANALYZE_AI_VISION_PROMPT_VERSION,
  SYSTEM_PROMPT: ANALYZE_SYSTEM,
  findMatchingCacheEntry: findAnalyzeCache,
  writeCacheEntry: writeAnalyzeCache,
} = require("../analyze_ai");
const {
  computeInputFingerprint: enrichFingerprint,
  buildEnrichPayload,
  buildExecutionContract: enrichContract,
  resolveEnrichPromptVersion,
  ENRICH_AI_PROMPT_VERSION,
  ENRICH_AI_VISION_PROMPT_VERSION,
  SYSTEM_PROMPT: ENRICH_SYSTEM,
  findMatchingCacheEntry: findEnrichCache,
  writeCacheEntry: writeEnrichCache,
} = require("../enrich_ai");
const {
  getVisionFactualContext,
  computeVisionFingerprint,
  withVisionInstructions,
  VISION_CONTEXT_INSTRUCTIONS,
} = require("../lib/vision-context");
const { IMPORTANCE_WEIGHTS } = require("../lib/enrichment-axes");
const {
  ATTENTION_WITHOUT_VALUE_PENALTY,
  AD_PENALTY,
} = require("../lib/editorial-score");
const {
  parseMorningArgs,
  buildMorningPlan,
  resolveRuntimeStepArgs,
} = require("../scripts/morning");
const {
  morningAnalyzeAiArgs,
  morningAnalyzeAiFallbackArgs,
} = require("../lib/daily-scope");
const { VISION_DEGRADED_WARNING } = require("../lib/morning-health");
const { evaluateVisionCandidate } = require("../lib/vision-candidates");

function visionOk(overrides) {
  return Object.assign(
    {
      schemaVersion: 1,
      status: "ok",
      skipReason: null,
      observations: "A red bench sits under a tree.",
      visibleText: "EXIT",
      uncertainties: "The sign is cropped.",
      mediaCountAnalyzed: 1,
      mediaIdentities: [
        { hostname: "pbs.twimg.com", pathname: "/media/A", format: "jpg" },
      ],
      model: "gpt-5-mini",
      promptVersion: "1",
      analyzedAt: "2026-09-06T00:00:00.000Z",
    },
    overrides || {}
  );
}

function post(overrides) {
  return Object.assign(
    {
      authorName: "Author",
      authorHandle: "@user",
      text: "短い",
      url: "https://x.com/user/status/1",
      analysis: {
        category: "その他",
        confidence: "low",
        categoryScores: {},
        matchedKeywords: [],
      },
      finalAnalysis: {
        source: "keyword",
        category: "その他",
        confidence: 0.5,
        reason: "キーワード分類",
        tags: [],
      },
    },
    overrides || {}
  );
}

{
  const payload = buildAiPayload(post({ vision: visionOk() }));
  assert.ok(payload.visionContext);
  assert.strictEqual(
    payload.visionContext.visualObservations,
    "A red bench sits under a tree."
  );
  assert.strictEqual(payload.text, "短い");
  assert.ok(!String(payload.text).includes("red bench"));
  console.log("1. vision ok Analyze payload observations PASS");
}

{
  const payload = buildAiPayload(post({ vision: visionOk() }));
  assert.strictEqual(payload.visionContext.visibleText, "EXIT");
  console.log("2. vision ok Analyze payload visibleText PASS");
}

{
  const payload = buildAiPayload(post({ vision: visionOk() }));
  assert.strictEqual(payload.visionContext.uncertainties, "The sign is cropped.");
  assert.ok(!("uncertainties" in payload) || payload.uncertainties == null);
  const instructions = withVisionInstructions(
    ANALYZE_SYSTEM,
    post({ vision: visionOk() })
  );
  assert.ok(instructions.includes(VISION_CONTEXT_INSTRUCTIONS));
  assert.ok(/uncertainties are NOT facts/i.test(instructions));
  console.log("3. uncertainties separately labeled PASS");
}

{
  const skipped = buildAiPayload(
    post({ vision: { status: "skipped", skipReason: "no_usable_media" } })
  );
  assert.ok(!skipped.visionContext);
  assert.strictEqual(skipped.text, "短い");
  console.log("4. vision skipped text-only Analyze payload PASS");
}

{
  const failed = buildAiPayload(post({ vision: { status: "failed" } }));
  assert.ok(!failed.visionContext);
  console.log("5. vision failed text-only Analyze payload PASS");
}

{
  const absent = buildAiPayload(post());
  assert.ok(!absent.visionContext);
  assert.deepStrictEqual(Object.keys(absent).sort(), [
    "authorHandle",
    "authorName",
    "categoryScores",
    "keywordCategory",
    "keywordConfidence",
    "matchedKeywords",
    "text",
    "url",
  ]);
  console.log("6. vision absent existing text-only behavior PASS");
}

{
  const payload = buildEnrichPayload(post({ vision: visionOk() }));
  assert.ok(payload.visionContext);
  assert.strictEqual(
    payload.visionContext.visualObservations,
    "A red bench sits under a tree."
  );
  assert.strictEqual(payload.visionContext.visibleText, "EXIT");
  assert.strictEqual(payload.visionContext.uncertainties, "The sign is cropped.");
  console.log("7. vision ok Enrich payload factual context PASS");
}

{
  const payload = buildEnrichPayload(post({ vision: visionOk() }));
  assert.ok(!("visualValue" in payload));
  assert.ok(!payload.visionContext || !("visualValue" in payload.visionContext));
  assert.ok(!/visualValue/.test(ENRICH_SYSTEM));
  console.log("8. Enrich does not receive visualValue PASS");
}

{
  const analyzeSrc = fs.readFileSync(path.join(__dirname, "../analyze.js"), "utf8");
  assert.ok(!analyzeSrc.includes("vision-context"));
  assert.ok(!analyzeSrc.includes("visionFingerprint"));
  assert.ok(!analyzeSrc.includes("visionContext"));
  assert.ok(analyzeSrc.includes("function buildSearchText"));
  console.log("9. deterministic Analyze unchanged PASS");
}

{
  assert.deepStrictEqual(IMPORTANCE_WEIGHTS, {
    informationValue: 0.55,
    personalRelevance: 0.25,
    impact: 0.2,
  });
  const axesSrc = fs.readFileSync(
    path.join(__dirname, "../lib/enrichment-axes.js"),
    "utf8"
  );
  assert.ok(!axesSrc.includes("visualValue"));
  assert.ok(!axesSrc.includes("visionFingerprint"));
  console.log("10. enrichment weights unchanged PASS");
}

{
  assert.strictEqual(ATTENTION_WITHOUT_VALUE_PENALTY, 28);
  assert.strictEqual(AD_PENALTY, 40);
  const scoreSrc = fs.readFileSync(
    path.join(__dirname, "../lib/editorial-score.js"),
    "utf8"
  );
  assert.ok(!scoreSrc.includes("visualValue"));
  assert.ok(!scoreSrc.includes("vision.status"));
  console.log("11. editorialScore formula unchanged PASS");
}

{
  const a = post({ vision: visionOk() });
  const b = post({
    vision: visionOk({
      analyzedAt: "2026-09-07T00:00:00.000Z",
      model: "other-model",
    }),
  });
  assert.strictEqual(computeVisionFingerprint(a), computeVisionFingerprint(b));
  assert.strictEqual(analyzeFingerprint(a), analyzeFingerprint(b));
  assert.strictEqual(enrichFingerprint(a), enrichFingerprint(b));
  console.log("12. same semantic Vision same fingerprint PASS");
}

{
  const base = post({ vision: visionOk() });
  const changed = post({
    vision: visionOk({ observations: "A blue bench sits under a tree." }),
  });
  assert.notStrictEqual(analyzeFingerprint(base), analyzeFingerprint(changed));
  assert.notStrictEqual(enrichFingerprint(base), enrichFingerprint(changed));
  console.log("13. changed observations fingerprint changes PASS");
}

{
  const base = post({ vision: visionOk() });
  const changed = post({ vision: visionOk({ visibleText: "ENTER" }) });
  assert.notStrictEqual(analyzeFingerprint(base), analyzeFingerprint(changed));
  console.log("14. changed visibleText fingerprint changes PASS");
}

{
  const base = post({ vision: visionOk() });
  const changed = post({
    vision: visionOk({ uncertainties: "Maybe two benches." }),
  });
  assert.notStrictEqual(analyzeFingerprint(base), analyzeFingerprint(changed));
  console.log("15. changed uncertainties fingerprint changes PASS");
}

{
  const base = post({ vision: visionOk() });
  const changed = post({
    vision: visionOk({ analyzedAt: "2099-01-01T00:00:00.000Z" }),
  });
  assert.strictEqual(analyzeFingerprint(base), analyzeFingerprint(changed));
  assert.strictEqual(enrichFingerprint(base), enrichFingerprint(changed));
  console.log("16. analyzedAt change fingerprint unchanged PASS");
}

{
  const base = post({ vision: visionOk() });
  const changed = post({
    vision: visionOk({
      mediaIdentities: [
        { hostname: "pbs.twimg.com", pathname: "/media/OTHER", format: "png" },
      ],
      mediaCountAnalyzed: 4,
    }),
  });
  assert.strictEqual(analyzeFingerprint(base), analyzeFingerprint(changed));
  assert.strictEqual(enrichFingerprint(base), enrichFingerprint(changed));
  console.log("17. media identity alone integration fingerprint unchanged PASS");
}

{
  const absent = post();
  const skipped = post({ vision: { status: "skipped", skipReason: "no_usable_media" } });
  const failed = post({ vision: { status: "failed" } });
  assert.strictEqual(analyzeFingerprint(absent), analyzeFingerprint(skipped));
  assert.strictEqual(analyzeFingerprint(absent), analyzeFingerprint(failed));
  assert.strictEqual(enrichFingerprint(absent), enrichFingerprint(skipped));
  assert.strictEqual(enrichFingerprint(absent), enrichFingerprint(failed));
  assert.strictEqual(computeVisionFingerprint(absent), null);
  assert.strictEqual(resolveAnalyzePromptVersion(absent), ANALYZE_AI_PROMPT_VERSION);
  assert.strictEqual(resolveEnrichPromptVersion(absent), ENRICH_AI_PROMPT_VERSION);
  console.log("18. skipped/failed stable text-only fingerprint PASS");
}

{
  const plan = buildMorningPlan(parseMorningArgs([]));
  const ids = plan.steps.map((s) => s.id);
  assert.strictEqual(ids.filter((id) => id === "analyze-ai").length, 1);
  assert.strictEqual(ids.filter((id) => id === "enrich").length, 1);
  assert.strictEqual(ids.filter((id) => id === "vision").length, 1);
  console.log("19/20. no second Analyze or Enrich request PASS");
}

{
  const failedPost = post({
    url: "https://x.com/user/status/99",
    vision: { status: "failed", observations: null, visibleText: null },
  });
  const payload = buildAiPayload(failedPost);
  assert.strictEqual(payload.url, failedPost.url);
  assert.ok(!payload.visionContext);
  console.log("21. Vision failure does not drop post PASS");
}

{
  const ids = buildMorningPlan(parseMorningArgs([])).steps.map((s) => s.id);
  assert.deepStrictEqual(ids, [
    "collect",
    "analyze",
    "vision",
    "visual-value",
    "analyze-ai",
    "enrich",
    "reader",
  ]);
  const skipAi = buildMorningPlan(parseMorningArgs(["--skip-ai"])).steps.map(
    (s) => s.id
  );
  assert.deepStrictEqual(skipAi, ["collect", "analyze", "reader"]);
  console.log("22. pipeline ordering Analyze → Vision → AI Analyze → Enrich PASS");
}

{
  const noMedia = {
    authorHandle: "@x",
    text: "short",
    media: [],
  };
  const decision = evaluateVisionCandidate(noMedia);
  assert.strictEqual(decision.candidate, false);
  console.log("23. no Vision candidate rule still reused PASS");
}

{
  const visionPost = post({ vision: visionOk() });
  const contract = analyzeContract(visionPost, "gpt-5-mini");
  assert.strictEqual(contract.promptVersion, ANALYZE_AI_VISION_PROMPT_VERSION);
  const cache = {};
  writeAnalyzeCache(
    cache,
    require("../lib/ai-contract").buildCacheKey(contract),
    contract,
    { category: "AI", confidence: 0.8, reason: "cached", tags: [] },
    "2026-09-06T00:00:00.000Z"
  );
  const hit = findAnalyzeCache(cache, contract);
  assert.ok(hit.entry);
  const textOnly = analyzeContract(post(), "gpt-5-mini");
  assert.strictEqual(textOnly.promptVersion, ANALYZE_AI_PROMPT_VERSION);
  assert.strictEqual(findAnalyzeCache(cache, textOnly).entry, null);

  const enrichC = enrichContract(visionPost, "gpt-5-mini");
  assert.strictEqual(enrichC.promptVersion, ENRICH_AI_VISION_PROMPT_VERSION);
  const eCache = {};
  writeEnrichCache(
    eCache,
    require("../lib/ai-contract").buildCacheKey(enrichC),
    enrichC,
    {
      informationValue: 3,
      personalRelevance: 3,
      impact: 3,
      attentionSignal: 2,
      importance: 3,
      summary: "s",
      reason: "r",
      tags: [],
    },
    "2026-09-06T00:00:00.000Z"
  );
  assert.ok(findEnrichCache(eCache, enrichC).entry);
  console.log("24. cache hit behavior preserved PASS");
}

{
  const textOnly = post();
  const payload = buildAiPayload(textOnly);
  assert.ok(!payload.visionContext);
  assert.strictEqual(analyzeFingerprint(textOnly), analyzeFingerprint({ ...textOnly }));
  assert.strictEqual(
    withVisionInstructions(ANALYZE_SYSTEM, textOnly),
    ANALYZE_SYSTEM
  );
  assert.strictEqual(
    withVisionInstructions(ENRICH_SYSTEM, textOnly),
    ENRICH_SYSTEM
  );
  assert.strictEqual(ANALYZE_AI_PROMPT_VERSION, "1");
  assert.strictEqual(ENRICH_AI_PROMPT_VERSION, "2");
  console.log("25. existing text-only post behavior compatible PASS");
}

{
  const analyzeAi = buildMorningPlan(parseMorningArgs([])).steps.find(
    (s) => s.id === "analyze-ai"
  );
  assert.deepStrictEqual(analyzeAi.args, morningAnalyzeAiArgs("50"));
  assert.ok(analyzeAi.args.includes("output/daily-visual.json"));
  assert.deepStrictEqual(
    resolveRuntimeStepArgs(analyzeAi, true, true),
    morningAnalyzeAiFallbackArgs("50")
  );
  assert.ok(
    resolveRuntimeStepArgs(analyzeAi, true, true).includes("output/daily-analyzed.json")
  );
  assert.strictEqual(VISION_DEGRADED_WARNING, "VISION_DEGRADED");
  console.log("vision stage fallback args PASS");
}

{
  const ctx = getVisionFactualContext(post({ vision: visionOk() }));
  assert.deepStrictEqual(Object.keys(ctx).sort(), [
    "observations",
    "uncertainties",
    "visibleText",
  ]);
  assert.ok(VISION_CONTEXT_INSTRUCTIONS.includes("poster/frame"));
  assert.ok(VISION_CONTEXT_INSTRUCTIONS.includes("NOT facts"));
  console.log("grounding instruction extras PASS");
}

console.log("vision-integrate-test: ALL PASS");
