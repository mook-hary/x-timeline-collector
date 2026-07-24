/**
 * KP-004 — Aikido Knowledge Extractor.
 * Run: node test/aikido-knowledge-extractor-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createAikidoKnowledgeExtractor,
  validateCandidate,
} = require("../lib/aikido-knowledge-extractor");
const { createAikidoSourceIntake } = require("../lib/aikido-source-intake");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-24T19:00:00.000Z";
const SAMPLE_TEXT =
  "合気道では中心を保つことが大切である。相手とぶつからず、力を抜いて動く。";

function makeSource(partial = {}) {
  return {
    id: "src-1",
    sourceType: "article",
    title: "稽古の要点",
    author: "Sensei",
    publisher: "Dojo",
    url: "https://example.com/a",
    publishedAt: "2026-01-01",
    language: "ja",
    rawText: SAMPLE_TEXT,
    summary: "",
    notes: "",
    status: "collected",
    ...partial,
  };
}

function createFakeProvider(behavior = "ok") {
  return {
    name: "fake",
    extractKnowledge(input) {
      if (behavior === "throw") {
        throw new Error("provider boom");
      }
      if (behavior === "empty") {
        return { candidates: [] };
      }
      if (behavior === "invalid-shape") {
        return { nope: true };
      }
      if (behavior === "bad-candidate") {
        return {
          candidates: [
            {
              title: "Bad",
              category: "not-a-category",
              summary: "x",
              content: "y",
              tags: [],
              difficulty: 9,
            },
            {
              title: "中心",
              category: "principle",
              summary: "中心を保つ",
              content: "力が抜けた状態で軸を意識する。",
              tags: ["center"],
              difficulty: 2,
              confidence: 0.9,
              sourceReferences: [
                {
                  quote: "中心を保つことが大切である",
                  location: "段落1",
                },
              ],
            },
          ],
        };
      }
      if (behavior === "multi") {
        return {
          candidates: [
            {
              title: "中心",
              category: "principle",
              summary: "中心を保つ",
              content: input.text.slice(0, 20),
              tags: ["center"],
              difficulty: 2,
              confidence: 0.95,
              sourceReferences: [
                {
                  quote: "中心を保つことが大切である",
                  location: "p1",
                },
              ],
            },
            {
              title: "力を抜く",
              category: "training",
              summary: "力を抜いて動く",
              content: "稽古では余計な力を入れない。",
              tags: ["relax"],
              difficulty: 1,
              confidence: 0.4,
              sourceReferences: [
                {
                  quote: "力を抜いて動く",
                  location: "p1",
                },
              ],
            },
            {
              title: "幽霊引用",
              category: "mindset",
              summary: "引用なし",
              content: "本文",
              tags: [],
              difficulty: 1,
              confidence: 0.7,
              sourceReferences: [
                {
                  quote: "この文章は資料に無い",
                  location: "",
                },
              ],
            },
          ],
        };
      }
      // default ok single
      return {
        candidates: [
          {
            title: "中心の感覚",
            category: "principle",
            summary: "中心を保つ",
            content: "合気道では中心を保つことが大切である。",
            tags: ["center"],
            difficulty: 2,
            confidence: 0.8,
            sourceReferences: [
              {
                quote: "中心を保つことが大切である",
                location: "本文",
              },
            ],
          },
        ],
      };
    },
  };
}

// --- single extract + determinism ---
{
  const extractor = createAikidoKnowledgeExtractor({
    provider: createFakeProvider("ok"),
  });
  const a = extractor.extractFromSource(makeSource(), { now: NOW });
  const b = extractor.extractFromSource(makeSource(), { now: NOW });
  assert.strictEqual(a.sourceId, "src-1");
  assert.strictEqual(a.candidates.length, 1);
  assert.deepStrictEqual(a, b);
  assert.ok(a.candidates[0].candidateId.startsWith("cand-"));
  assert.strictEqual(a.metadata.provider, "fake");
  assert.strictEqual(a.metadata.extractedAt, NOW);
  assert.strictEqual(a.candidates[0].sourceReferences[0].sourceId, "src-1");
  const v = validateCandidate(a.candidates[0]);
  assert.strictEqual(v.valid, true);
  console.log("KP004 single PASS");
}

// --- multi candidates + quote warning + minConfidence ---
{
  const extractor = createAikidoKnowledgeExtractor({
    provider: createFakeProvider("multi"),
  });
  const result = extractor.extractFromSource(makeSource(), { now: NOW });
  assert.strictEqual(result.candidates.length, 3);
  assert.ok(
    result.candidates.some((c) =>
      c.warnings.some((w) => /quote not found/.test(w))
    )
  );

  const filtered = extractor.extractFromSource(makeSource(), {
    now: NOW,
    minConfidence: 0.5,
  });
  assert.ok(filtered.candidates.every((c) => c.confidence >= 0.5));
  assert.strictEqual(filtered.candidates.length, 2);
  console.log("KP004 multi-filter PASS");
}

// --- text fallbacks ---
{
  const extractor = createAikidoKnowledgeExtractor({
    provider: createFakeProvider("ok"),
  });
  assert.throws(
    () =>
      extractor.extractFromSource(
        makeSource({ rawText: "", summary: "", notes: "" })
      ),
    /extraction text is empty/
  );
  const fromSummary = extractor.extractFromSource(
    makeSource({ rawText: "", summary: SAMPLE_TEXT, notes: "notes" }),
    { now: NOW }
  );
  assert.strictEqual(fromSummary.candidates.length, 1);

  const fromNotes = extractor.extractFromSource(
    makeSource({ rawText: "", summary: "", notes: SAMPLE_TEXT }),
    { now: NOW }
  );
  assert.strictEqual(fromNotes.candidates.length, 1);
  console.log("KP004 text-fallback PASS");
}

// --- bad provider output / exception ---
{
  const bad = createAikidoKnowledgeExtractor({
    provider: createFakeProvider("bad-candidate"),
  });
  const result = bad.extractFromSource(makeSource(), { now: NOW });
  assert.strictEqual(result.candidates.length, 1);
  assert.ok(result.errors.length >= 1);
  assert.strictEqual(result.candidates[0].title, "中心");

  const boom = createAikidoKnowledgeExtractor({
    provider: createFakeProvider("throw"),
  });
  assert.throws(
    () => boom.extractFromSource(makeSource(), { now: NOW }),
    /provider boom/
  );

  const empty = createAikidoKnowledgeExtractor({
    provider: createFakeProvider("empty"),
  });
  const zero = empty.extractFromSource(makeSource(), { now: NOW });
  assert.strictEqual(zero.candidates.length, 0);
  assert.strictEqual(zero.errors.length, 0);
  console.log("KP004 provider-edge PASS");
}

// --- batch order + partial failure ---
{
  const extractor = createAikidoKnowledgeExtractor({
    provider: {
      name: "batch-fake",
      extractKnowledge(input) {
        if (input.source.id === "bad") {
          throw new Error("fail this one");
        }
        return {
          candidates: [
            {
              title: input.source.title,
              category: "experience",
              summary: "s",
              content: "c",
              tags: [],
              difficulty: 1,
              confidence: 0.6,
            },
          ],
        };
      },
    },
  });
  const sources = [
    makeSource({ id: "a", rawText: "aaa" }),
    makeSource({ id: "bad", rawText: "bbb" }),
    makeSource({ id: "c", rawText: "ccc" }),
  ];
  const batch = extractor.extractFromSources(sources, { now: NOW });
  assert.strictEqual(batch.results.length, 3);
  assert.deepStrictEqual(
    batch.results.map((r) => r.sourceId),
    ["a", "bad", "c"]
  );
  assert.strictEqual(batch.results[1].candidates.length, 0);
  assert.ok(batch.results[1].errors.length >= 1);
  assert.strictEqual(batch.summary.sourceCount, 3);
  assert.strictEqual(batch.summary.candidateCount, 2);

  const limited = extractor.extractFromSources(sources, {
    now: NOW,
    limit: 2,
  });
  assert.strictEqual(limited.results.length, 2);
  console.log("KP004 batch PASS");
}

// --- intake integration + no status mutation ---
{
  const root = tmpDir("aikido-extract-intake-");
  const intake = createAikidoSourceIntake({
    rootDir: root,
    now: () => NOW,
    provider: createFakeProvider("ok"),
  });
  intake.createSource({
    id: "intake-1",
    sourceType: "article",
    title: "記事",
    rawText: SAMPLE_TEXT,
  });
  const before = intake.findSource("intake-1").status;
  const extracted = intake.extractKnowledge("intake-1", { now: NOW });
  assert.strictEqual(extracted.candidates.length, 1);
  assert.strictEqual(intake.findSource("intake-1").status, before);
  assert.strictEqual(intake.findSource("intake-1").status, "collected");

  const batch = intake.extractKnowledgeBatch({ now: NOW });
  assert.ok(batch.summary.sourceCount >= 1);

  // no knowledge files created
  const knowledgeDir = path.join(root, ".pipeline-work", "knowledge", "aikido");
  assert.ok(!fs.existsSync(knowledgeDir) || fs.readdirSync(knowledgeDir).length === 0);
  console.log("KP004 intake PASS");
}

console.log("aikido-knowledge-extractor-test: all PASS");
