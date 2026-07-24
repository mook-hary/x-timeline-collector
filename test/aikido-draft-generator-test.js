/**
 * KP-002 — Aikido Draft Generator.
 * Run: node test/aikido-draft-generator-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  getDefaultAikidoTemplates,
  generateDraft,
  generateDrafts,
  selectTemplate,
  truncateJapanese,
} = require("../lib/aikido-draft-generator");
const { createAikidoKnowledgeStore } = require("../lib/aikido-knowledge");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-24T16:00:00.000Z";

function knowledge(partial) {
  return {
    id: "k1",
    title: "中心の感覚",
    category: "principle",
    summary: "力が抜けた状態で軸を保つ。",
    content: "相手とぶつからず、自分の中心から動くことを意識する。",
    tags: ["center"],
    difficulty: 2,
    sources: ["稽古メモ"],
    related: [],
    status: "draft",
    ...partial,
  };
}

// --- templates exist ---
{
  const ids = getDefaultAikidoTemplates().map((t) => t.id).sort();
  assert.deepStrictEqual(ids, [
    "experience-note",
    "injury-prevention",
    "principle-short",
    "technique-point",
    "training-tip",
  ]);
  console.log("KP002 templates PASS");
}

// --- each template generates editorial-compatible draft ---
{
  const cases = [
    { category: "principle", expectTemplate: "principle-short" },
    { category: "training", expectTemplate: "training-tip", title: "稽古の組み立て" },
    { category: "experience", expectTemplate: "experience-note", title: "今日の気づき" },
    { category: "technique", expectTemplate: "technique-point", title: "一教" },
    {
      category: "injury-prevention",
      expectTemplate: "injury-prevention",
      title: "受け身の安全",
    },
  ];
  for (const c of cases) {
    const draft = generateDraft(
      knowledge({
        category: c.category,
        title: c.title || "タイトル",
        summary: "要約です。",
        content: "本文の詳細です。稽古で確認した点を残す。",
      }),
      { now: NOW }
    );
    assert.strictEqual(draft.source, "aikido");
    assert.strictEqual(draft.type, "post");
    assert.strictEqual(draft.status, "draft");
    assert.strictEqual(draft.score, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(draft, "id"));
    assert.ok(!Object.prototype.hasOwnProperty.call(draft, "createdAt"));
    assert.strictEqual(draft.metadata.templateId, c.expectTemplate);
    assert.strictEqual(draft.metadata.knowledgeId, "k1");
    assert.strictEqual(draft.metadata.generatedAt, NOW);
    assert.ok(/[\u3040-\u30ff\u4e00-\u9fff]/.test(draft.body));
  }
  console.log("KP002 generate-each PASS");
}

// --- template selection / errors ---
{
  const templates = getDefaultAikidoTemplates();
  assert.strictEqual(
    selectTemplate(knowledge({ category: "technique" }), templates).id,
    "technique-point"
  );
  assert.throws(
    () =>
      generateDraft(knowledge({ category: "technique" }), {
        templateId: "nope",
        now: NOW,
      }),
    /unknown templateId/
  );
  assert.throws(
    () =>
      generateDraft(knowledge({ category: "technique" }), {
        templateId: "principle-short",
        now: NOW,
      }),
    /does not support category/
  );
  // deterministic default
  const a = generateDraft(knowledge({ category: "mindset" }), { now: NOW });
  const b = generateDraft(knowledge({ category: "mindset" }), { now: NOW });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.metadata.templateId, "principle-short");
  console.log("KP002 selection PASS");
}

// --- maxLength ---
{
  const long = generateDraft(
    knowledge({
      content: "あいうえお。".repeat(80),
    }),
    { now: NOW, maxLength: 40 }
  );
  assert.ok(long.body.length <= 40);
  assert.strictEqual(truncateJapanese("短い", 10), "短い");
  assert.ok(truncateJapanese("あいうえお。かきくけこ。", 8).length <= 8);
  console.log("KP002 maxLength PASS");
}

// --- generateDrafts filter / order / limit ---
{
  const items = [
    knowledge({ id: "1", category: "technique", title: "一教", tags: ["ikkyo"] }),
    knowledge({ id: "2", category: "training", title: "準備運動", tags: ["warm"] }),
    knowledge({ id: "3", category: "technique", title: "二教", tags: ["nikyo"] }),
  ];
  const drafts = generateDrafts(items, {
    category: "technique",
    now: NOW,
  });
  assert.deepStrictEqual(
    drafts.map((d) => d.metadata.knowledgeId),
    ["1", "3"]
  );
  const limited = generateDrafts(items, {
    category: "technique",
    limit: 1,
    now: NOW,
  });
  assert.strictEqual(limited.length, 1);
  assert.strictEqual(limited[0].metadata.knowledgeId, "1");
  console.log("KP002 drafts-filter PASS");
}

// --- store API ---
{
  const store = createAikidoKnowledgeStore({
    rootDir: tmpDir("aikido-draft-store-"),
    now: () => NOW,
  });
  store.createKnowledge({
    id: "store-1",
    title: "呼吸",
    category: "principle",
    summary: "息を落とす。",
    content: "力を抜いて呼吸を整える。",
    tags: ["breath"],
    difficulty: 1,
  });
  store.createKnowledge({
    id: "store-2",
    title: "受け身",
    category: "injury-prevention",
    summary: "首を守る。",
    content: "受け身では頭を打たない。",
    tags: ["ukemi"],
    difficulty: 2,
  });

  const one = store.generateDraft("store-1", { now: NOW });
  assert.strictEqual(one.metadata.knowledgeId, "store-1");
  assert.strictEqual(one.metadata.templateId, "principle-short");

  assert.throws(() => store.generateDraft("missing"), /not found/);

  const many = store.generateDrafts({
    category: "injury-prevention",
    now: NOW,
  });
  assert.strictEqual(many.length, 1);
  assert.strictEqual(many[0].metadata.templateId, "injury-prevention");

  // CRUD still works
  assert.strictEqual(store.findKnowledge("store-1").title, "呼吸");
  console.log("KP002 store-api PASS");
}

console.log("aikido-draft-generator-test: all PASS");
