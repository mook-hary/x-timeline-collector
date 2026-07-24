/**
 * KP-001 — Aikido Knowledge Model.
 * Run: node test/aikido-knowledge-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  STORE_DIR_REL,
  CATEGORIES,
  createAikidoKnowledgeStore,
  normalizeCategory,
  normalizeDifficulty,
} = require("../lib/aikido-knowledge");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let clock = Date.parse("2026-07-24T15:00:00.000Z");
function now() {
  return new Date(clock).toISOString();
}
function advance(ms) {
  clock += ms;
}

// --- category / difficulty validation ---
{
  assert.ok(CATEGORIES.includes("technique"));
  assert.ok(CATEGORIES.includes("injury-prevention"));
  assert.strictEqual(normalizeCategory("principle"), "principle");
  assert.throws(() => normalizeCategory("kata"), /category/);
  assert.strictEqual(normalizeDifficulty(3), 3);
  assert.throws(() => normalizeDifficulty(0), /1–5/);
  assert.throws(() => normalizeDifficulty(6), /1–5/);
  assert.throws(() => normalizeDifficulty(2.5), /integer/);
  console.log("KP001 validate PASS");
}

// --- CRUD + file format ---
{
  const root = tmpDir("aikido-knowledge-");
  const store = createAikidoKnowledgeStore({ rootDir: root, now });

  const created = store.createKnowledge({
    id: "ikkyo-basics",
    title: "一教の基本",
    category: "technique",
    summary: "正面打ち一教",
    content: "相手の腕を制御し重心を崩す。",
    tags: ["ikkyo", "omote"],
    difficulty: 2,
    sources: ["合気会教本", "本部道場", "自分の稽古"],
    related: [],
  });
  assert.strictEqual(created.status, "draft");
  assert.strictEqual(created.difficulty, 2);
  assert.deepStrictEqual(created.sources, [
    "合気会教本",
    "本部道場",
    "自分の稽古",
  ]);

  const filePath = path.join(root, STORE_DIR_REL, "ikkyo-basics.json");
  assert.ok(fs.existsSync(filePath));
  const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.strictEqual(onDisk.title, "一教の基本");
  assert.strictEqual(onDisk.category, "technique");

  assert.strictEqual(store.findKnowledge("missing"), null);
  assert.strictEqual(store.findKnowledge("ikkyo-basics").title, "一教の基本");

  advance(1000);
  const updated = store.updateKnowledge("ikkyo-basics", {
    status: "review",
    difficulty: 3,
    summary: "更新済み",
  });
  assert.strictEqual(updated.status, "review");
  assert.strictEqual(updated.difficulty, 3);
  assert.strictEqual(updated.createdAt, "2026-07-24T15:00:00.000Z");
  assert.strictEqual(updated.updatedAt, "2026-07-24T15:00:01.000Z");

  assert.throws(
    () =>
      store.createKnowledge({
        id: "ikkyo-basics",
        title: "dup",
        category: "technique",
        difficulty: 1,
      }),
    /already exists/
  );
  assert.throws(
    () => store.updateKnowledge("nope", { title: "x" }),
    /not found/
  );
  console.log("KP001 crud PASS");
}

// --- related (circular) + filters ---
{
  const root = tmpDir("aikido-knowledge-rel-");
  const store = createAikidoKnowledgeStore({ rootDir: root, now });

  store.createKnowledge({
    id: "a",
    title: "A",
    category: "principle",
    difficulty: 1,
    tags: ["center"],
    related: ["b"],
    sources: ["道場"],
  });
  store.createKnowledge({
    id: "b",
    title: "B",
    category: "principle",
    difficulty: 1,
    tags: ["center", "breath"],
    related: ["a"],
    status: "published",
  });
  store.createKnowledge({
    id: "c",
    title: "C",
    category: "training",
    difficulty: 4,
    tags: ["ukemi"],
    status: "draft",
  });

  assert.deepStrictEqual(store.findKnowledge("a").related, ["b"]);
  assert.deepStrictEqual(store.findKnowledge("b").related, ["a"]);

  assert.deepStrictEqual(
    store.listKnowledge({ category: "principle" }).map((k) => k.id).sort(),
    ["a", "b"]
  );
  assert.deepStrictEqual(
    store.listKnowledge({ difficulty: 4 }).map((k) => k.id),
    ["c"]
  );
  assert.deepStrictEqual(
    store.listKnowledge({ tag: "breath" }).map((k) => k.id),
    ["b"]
  );
  assert.deepStrictEqual(
    store.listKnowledge({ status: "published" }).map((k) => k.id),
    ["b"]
  );
  assert.strictEqual(store.listKnowledge().length, 3);
  console.log("KP001 filter-related PASS");
}

// --- custom directory + auto id ---
{
  const dir = path.join(tmpDir("aikido-knowledge-dir-"), "custom");
  const store = createAikidoKnowledgeStore({ directory: dir, now });
  const auto = store.createKnowledge({
    title: "受け身",
    category: "injury-prevention",
    difficulty: 1,
    content: "安全な受け方",
  });
  assert.ok(/^aikido-/.test(auto.id));
  assert.ok(fs.existsSync(path.join(dir, `${auto.id}.json`)));
  console.log("KP001 directory PASS");
}

// --- does not require editorial ---
{
  const src = fs.readFileSync(
    path.join(__dirname, "..", "lib", "aikido-knowledge.js"),
    "utf8"
  );
  assert.ok(!/editorial-store|editorial-engine|editorial-rules/.test(src));
  console.log("KP001 independence PASS");
}

console.log("aikido-knowledge-test: all PASS");
