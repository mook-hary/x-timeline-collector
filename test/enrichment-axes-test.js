/**
 * Multi-axis enrichment + editorial / picks selection.
 * Fake axes only — no OpenAI / no X.
 * Run: node test/enrichment-axes-test.js
 */
const assert = require("assert");
const {
  deriveLegacyImportance,
  normalizeEnrichAxesResult,
  getInformationValue,
  getAttentionSignal,
  isAttentionWithoutValue,
  hasMultiAxisEnrichment,
  FIXTURE_CASES,
  fixturePost,
} = require("../lib/enrichment-axes");
const {
  scoreEditorialPost,
  ATTENTION_WITHOUT_VALUE_PENALTY,
} = require("../lib/editorial-score");
const { selectTodayPicks } = require("../lib/today-picks");
const { sortPostsByImportance, getDigestRankValue } = require("../lib/digest-core");
const {
  ENRICH_AI_PROMPT_VERSION,
  ENRICH_AI_SCHEMA_VERSION,
  SYSTEM_PROMPT,
  validateEnrichResult,
} = require("../enrich_ai");

function assertInRange(value, lo, hi, label) {
  assert.ok(
    value >= lo && value <= hi,
    `${label}=${value} not in [${lo},${hi}]`
  );
}

// --- schema / prompt versions ---
{
  assert.strictEqual(ENRICH_AI_PROMPT_VERSION, "2");
  assert.strictEqual(ENRICH_AI_SCHEMA_VERSION, "2");
  assert.ok(SYSTEM_PROMPT.includes("informationValue"));
  assert.ok(SYSTEM_PROMPT.includes("attentionSignal"));
  assert.ok(SYSTEM_PROMPT.includes("ショッキングさと重要性を区別"));
  assert.ok(SYSTEM_PROMPT.includes("attentionSignal 単独では"));
  assert.ok(SYSTEM_PROMPT.includes("意見であることが分かる"));
  console.log("IA001 prompt PASS");
}

// --- derive importance ignores attention ---
{
  const withAtt = deriveLegacyImportance({
    informationValue: 2,
    personalRelevance: 2,
    impact: 2,
  });
  const loud = deriveLegacyImportance({
    informationValue: 2,
    personalRelevance: 2,
    impact: 2,
  });
  assert.strictEqual(withAtt, loud);
  const highAttIgnored = normalizeEnrichAxesResult({
    informationValue: 2,
    personalRelevance: 2,
    impact: 2,
    attentionSignal: 5,
    summary: "投稿者は極端な主張をしている",
    tags: ["t"],
    reason: "情報量が少ない",
  });
  assert.strictEqual(highAttIgnored.importance, withAtt);
  assert.strictEqual(highAttIgnored.attentionSignal, 5);
  console.log("IA001 derive-importance PASS");
}

// --- fixtures A–F axis expectations ---
{
  const a = FIXTURE_CASES.A.axes;
  assertInRange(a.informationValue, 1, 2, "A.iv");
  assertInRange(a.attentionSignal, 4, 5, "A.att");
  assertInRange(a.impact, 1, 2, "A.im");

  const b = FIXTURE_CASES.B.axes;
  assertInRange(b.informationValue, 4, 5, "B.iv");
  assertInRange(b.impact, 4, 5, "B.im");
  assertInRange(b.attentionSignal, 1, 3, "B.att");

  const c = FIXTURE_CASES.C.axes;
  assertInRange(c.informationValue, 4, 5, "C.iv");
  assertInRange(c.attentionSignal, 1, 3, "C.att");

  const d = FIXTURE_CASES.D.axes;
  assert.strictEqual(d.informationValue, 5);
  assert.strictEqual(d.impact, 5);
  assert.strictEqual(d.attentionSignal, 5);

  const e = FIXTURE_CASES.E.axes;
  assertInRange(e.informationValue, 1, 2, "E.iv");
  assert.strictEqual(e.impact, 1);

  const f = FIXTURE_CASES.F.axes;
  assertInRange(f.informationValue, 3, 5, "F.iv");
  console.log("IA001 fixtures-axes PASS");
}

// --- editorial: attention alone does not raise score ---
{
  const base = fixturePost("B");
  const quiet = scoreEditorialPost(base);
  const louder = scoreEditorialPost({
    ...base,
    enrichment: {
      ...base.enrichment,
      attentionSignal: 5,
    },
  });
  assert.strictEqual(quiet, louder);

  const thinLoud = fixturePost("A");
  const thinQuiet = {
    ...thinLoud,
    enrichment: { ...thinLoud.enrichment, attentionSignal: 1 },
  };
  assert.ok(
    scoreEditorialPost(thinLoud) <
      scoreEditorialPost(thinQuiet) + ATTENTION_WITHOUT_VALUE_PENALTY
  );
  assert.ok(isAttentionWithoutValue(thinLoud));
  assert.ok(!isAttentionWithoutValue(fixturePost("D")));
  console.log("IA001 editorial-attention PASS");
}

// --- editorial ranking: A below B/C/D/F; E low; D not suppressed ---
{
  const posts = ["A", "B", "C", "D", "E", "F"].map((id) => fixturePost(id));
  const scores = Object.fromEntries(
    posts.map((p) => [p.enrichment.tags[1], scoreEditorialPost(p)])
  );
  assert.ok(scores.A < scores.B, "A < B");
  assert.ok(scores.A < scores.C, "A < C");
  assert.ok(scores.A < scores.D, "A < D");
  assert.ok(scores.A < scores.F, "A < F");
  assert.ok(scores.E < scores.B, "E < B");
  assert.ok(scores.D >= scores.B, "D stays high despite attention");
  console.log("IA001 editorial-rank PASS");
}

// --- Today's Picks: A not in top when better peers exist ---
{
  const posts = ["A", "B", "C", "D", "E", "F"].map((id) => fixturePost(id));
  const picks = selectTodayPicks(posts, 3);
  const urls = picks.map((p) => p.url);
  assert.ok(!urls.includes(fixturePost("A").url), "A should not top picks");
  assert.ok(
    urls.includes(fixturePost("B").url) ||
      urls.includes(fixturePost("C").url) ||
      urls.includes(fixturePost("D").url),
    "valuable posts remain"
  );
  console.log("IA001 today-picks PASS");
}

// --- legacy importance-only fallback ---
{
  const legacy = {
    url: "https://x.com/u/status/legacy",
    text: "legacy only",
    finalAnalysis: { category: "AI" },
    enrichment: {
      importance: 4,
      summary: "十分長い要約テキストでフォールバックを確認する。",
      reason: "legacy reason text",
      tags: ["x"],
    },
  };
  assert.ok(!hasMultiAxisEnrichment(legacy));
  assert.strictEqual(getInformationValue(legacy), 4);
  assert.strictEqual(getAttentionSignal(legacy), 2);
  assert.ok(scoreEditorialPost(legacy) > 0);
  assert.strictEqual(getDigestRankValue(legacy), 4);
  console.log("IA001 legacy-fallback PASS");
}

// --- Category Digest sort uses informationValue ---
{
  const posts = [fixturePost("A"), fixturePost("B"), fixturePost("E")];
  const sorted = sortPostsByImportance(posts);
  assert.strictEqual(sorted[0].url, fixturePost("B").url);
  assert.ok(sorted[sorted.length - 1].url !== fixturePost("B").url);
  console.log("IA001 category-sort PASS");
}

// --- validateEnrichResult derives importance ---
{
  const result = validateEnrichResult({
    informationValue: 5,
    personalRelevance: 3,
    impact: 4,
    attentionSignal: 5,
    summary: "制度変更の具体内容を伝える速報要約",
    tags: ["制度"],
    reason: "一次に近い具体情報がある",
  });
  assert.strictEqual(result.informationValue, 5);
  assert.strictEqual(result.attentionSignal, 5);
  assert.ok(result.importance >= 4);
  console.log("IA001 validate-enrich PASS");
}

// --- diversity / freshness import smoke (no throw) ---
{
  const { diversifyReaderSlots } = require("../lib/reader-diversity");
  const posts = ["A", "B", "C"].map((id) => fixturePost(id));
  const { primary, overflow } = diversifyReaderSlots(posts, 2);
  assert.strictEqual(primary.length + overflow.length, 3);
  console.log("IA001 diversity-compat PASS");
}

console.log("enrichment-axes-test: ALL PASS");
