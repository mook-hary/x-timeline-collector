/**
 * KS-002 — Aikido Editorial Bridge.
 * Run: node test/aikido-editorial-bridge-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  createAikidoEditorialBridge,
  BRIDGE_VERSION,
} = require("../lib/aikido-editorial-bridge");
const { createEditorialStore } = require("../lib/editorial-store");
const { createEditorialEngine } = require("../lib/editorial-engine");
const { createAikidoKnowledgeStore } = require("../lib/aikido-knowledge");
const { generateDraft } = require("../lib/aikido-draft-generator");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-24T22:00:00.000Z";
let clock = Date.parse(NOW);
function now() {
  return new Date(clock).toISOString();
}
function advance(ms) {
  clock += ms;
}

function knowledgeEntry(partial = {}) {
  return {
    id: "center-basics",
    title: "中心の基本",
    category: "principle",
    summary: "中心を保つ",
    content: "力が抜けた状態で軸を意識する。稽古の基本である。",
    tags: ["center"],
    difficulty: 2,
    sources: ["道場"],
    related: [],
    status: "draft",
    ...partial,
  };
}

// --- single draft publish + metadata ---
{
  clock = Date.parse(NOW);
  const root = tmpDir("aikido-bridge-");
  const editorialStore = createEditorialStore({ rootDir: root, now });
  const bridge = createAikidoEditorialBridge({ editorialStore });
  const draft = generateDraft(knowledgeEntry(), { now: NOW });
  const bodyBefore = draft.body;

  const published = bridge.publishDraft(draft);
  assert.strictEqual(published.created, true);
  assert.ok(published.editorialId);
  assert.strictEqual(published.knowledgeId, "center-basics");
  assert.strictEqual(published.item.status, "draft");
  assert.strictEqual(published.item.body, bodyBefore);
  assert.strictEqual(draft.body, bodyBefore);
  assert.deepStrictEqual(published.item.metadata, {
    source: "aikido",
    knowledgeId: "center-basics",
    templateId: draft.metadata.templateId,
    generatedAt: NOW,
    bridgeVersion: BRIDGE_VERSION,
  });
  assert.strictEqual(editorialStore.list().length, 1);
  console.log("KS002 single PASS");
}

// --- duplicate reject + allowDuplicateDraft ---
{
  clock = Date.parse(NOW);
  const root = tmpDir("aikido-bridge-dup-");
  const editorialStore = createEditorialStore({ rootDir: root, now });
  const bridge = createAikidoEditorialBridge({ editorialStore });
  const draft = generateDraft(knowledgeEntry(), { now: NOW });

  bridge.publishDraft(draft);
  assert.throws(
    () => bridge.publishDraft(draft),
    (err) => err && err.code === "aikido-bridge-duplicate"
  );
  assert.strictEqual(editorialStore.list().length, 1);

  const again = bridge.publishDraft(draft, { allowDuplicateDraft: true });
  assert.strictEqual(again.created, true);
  assert.strictEqual(editorialStore.list().length, 2);
  console.log("KS002 duplicate PASS");
}

// --- multiple drafts, order preserved ---
{
  clock = Date.parse(NOW);
  const root = tmpDir("aikido-bridge-batch-");
  const editorialStore = createEditorialStore({ rootDir: root, now });
  const bridge = createAikidoEditorialBridge({ editorialStore });

  const d1 = generateDraft(
    knowledgeEntry({ id: "k-a", title: "A", category: "principle" }),
    { now: NOW }
  );
  advance(1000);
  const d2 = generateDraft(
    knowledgeEntry({
      id: "k-b",
      title: "B",
      category: "training",
      tags: ["ukemi"],
    }),
    { now: now() }
  );
  advance(1000);
  const d3 = generateDraft(
    knowledgeEntry({ id: "k-c", title: "C", category: "principle" }),
    { now: now() }
  );

  const batch = bridge.publishDrafts([d1, d2, d3]);
  assert.strictEqual(batch.summary.createdCount, 3);
  assert.strictEqual(batch.summary.skippedCount, 0);
  assert.strictEqual(batch.summary.errorCount, 0);
  assert.deepStrictEqual(
    batch.results.map((r) => r.knowledgeId),
    ["k-a", "k-b", "k-c"]
  );

  // duplicate in batch → skip
  const again = bridge.publishDrafts([d1, d2], { continueOnError: true });
  assert.strictEqual(again.summary.createdCount, 0);
  assert.strictEqual(again.summary.skippedCount, 2);
  console.log("KS002 batch-order PASS");
}

// --- no store injected ---
{
  const bridge = createAikidoEditorialBridge({});
  assert.throws(
    () => bridge.publishDraft(generateDraft(knowledgeEntry(), { now: NOW })),
    /editorialStore/
  );
  console.log("KS002 no-store PASS");
}

// --- Knowledge Store publishDraft / publishDrafts + dry-run ---
{
  clock = Date.parse(NOW);
  const root = tmpDir("aikido-bridge-know-");
  const editorialStore = createEditorialStore({ rootDir: root, now });
  const bridge = createAikidoEditorialBridge({ editorialStore });
  const knowledge = createAikidoKnowledgeStore({
    rootDir: root,
    now,
    editorialBridge: bridge,
  });

  knowledge.createKnowledge(
    knowledgeEntry({
      id: "pub-1",
      title: "原理1",
      category: "principle",
    })
  );
  advance(1000);
  knowledge.createKnowledge(
    knowledgeEntry({
      id: "pub-2",
      title: "稽古2",
      category: "training",
      tags: ["keiko"],
    })
  );

  const dry = knowledge.publishDraft("pub-1", { dryRun: true });
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.created, false);
  assert.ok(dry.draft && dry.draft.body);
  assert.strictEqual(editorialStore.list().length, 0);

  const one = knowledge.publishDraft("pub-1");
  assert.strictEqual(one.created, true);
  assert.strictEqual(editorialStore.list().length, 1);

  const dryBatch = knowledge.publishDrafts({
    category: "training",
    dryRun: true,
  });
  assert.strictEqual(dryBatch.dryRun, true);
  assert.strictEqual(dryBatch.summary.draftCount, 1);
  assert.strictEqual(editorialStore.list().length, 1);

  const batch = knowledge.publishDrafts({ category: "training" });
  assert.strictEqual(batch.summary.createdCount, 1);
  assert.strictEqual(editorialStore.list().length, 2);
  console.log("KS002 knowledge-api PASS");
}

// --- Editorial Engine compatibility (no engine changes) ---
{
  clock = Date.parse(NOW);
  const root = tmpDir("aikido-bridge-engine-");
  const editorialStore = createEditorialStore({ rootDir: root, now });
  const bridge = createAikidoEditorialBridge({ editorialStore });
  const draft = generateDraft(knowledgeEntry({ id: "eng-1" }), { now: NOW });
  const published = bridge.publishDraft(draft);

  const engine = createEditorialEngine({ rootDir: root, now });
  const found = engine.find(published.editorialId);
  assert.ok(found);
  assert.strictEqual(found.source, "aikido");
  assert.strictEqual(found.type, "post");
  assert.strictEqual(found.status, "draft");
  assert.ok(engine.find(published.editorialId));
  assert.strictEqual(found.metadata.knowledgeId, "eng-1");
  assert.ok(
    engine.store.listBySource("aikido").some((i) => i.id === found.id)
  );
  console.log("KS002 engine-compat PASS");
}

// --- CLI dry-run + publish ---
{
  clock = Date.parse(NOW);
  const root = tmpDir("aikido-bridge-cli-");
  const knowledge = createAikidoKnowledgeStore({ rootDir: root, now });
  knowledge.createKnowledge(
    knowledgeEntry({ id: "cli-1", category: "principle" })
  );

  const script = path.join(__dirname, "..", "scripts", "aikido-editorial.js");
  const dry = spawnSync(
    process.execPath,
    [
      script,
      `--rootDir=${root}`,
      "--id=cli-1",
      "--dry-run",
      "--json",
    ],
    { encoding: "utf8" }
  );
  assert.strictEqual(dry.status, 0, dry.stderr);
  const dryJson = JSON.parse(dry.stdout);
  assert.strictEqual(dryJson.dryRun, true);

  const editorialBefore = createEditorialStore({ rootDir: root }).list().length;
  assert.strictEqual(editorialBefore, 0);

  const pub = spawnSync(
    process.execPath,
    [script, `--rootDir=${root}`, "--id=cli-1", "--json"],
    { encoding: "utf8" }
  );
  assert.strictEqual(pub.status, 0, pub.stderr);
  const pubJson = JSON.parse(pub.stdout);
  assert.strictEqual(pubJson.created, true);
  assert.ok(pubJson.editorialId);

  const cat = spawnSync(
    process.execPath,
    [
      script,
      `--rootDir=${root}`,
      "--category=principle",
      "--limit=1",
      "--json",
    ],
    { encoding: "utf8" }
  );
  assert.strictEqual(cat.status, 0, cat.stderr);
  const catJson = JSON.parse(cat.stdout);
  // duplicate of same knowledge+template → skipped
  assert.strictEqual(catJson.summary.skippedCount, 1);
  console.log("KS002 cli PASS");
}

console.log("aikido-editorial-bridge-test: all PASS");
