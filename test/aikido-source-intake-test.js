/**
 * KP-003 — Aikido Source Intake.
 * Run: node test/aikido-source-intake-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  STORE_DIR_REL,
  SOURCE_TYPES,
  createAikidoSourceIntake,
  normalizeUrl,
  assertTransition,
} = require("../lib/aikido-source-intake");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let clock = Date.parse("2026-07-24T17:00:00.000Z");
function now() {
  return new Date(clock).toISOString();
}
function advance(ms) {
  clock += ms;
}

// --- URL normalize ---
{
  assert.strictEqual(
    normalizeUrl(" https://Example.com/path/?utm_source=x&fbclid=1#frag "),
    "https://example.com/path"
  );
  assert.strictEqual(
    normalizeUrl("https://example.com/path/"),
    "https://example.com/path"
  );
  assert.ok(
    normalizeUrl("https://a.com/?b=1&utm_campaign=c&a=2").includes("a=2")
  );
  assert.ok(
    !normalizeUrl("https://a.com/?utm_medium=x&gclid=1").includes("utm_")
  );
  console.log("KP003 url-normalize PASS");
}

// --- transitions ---
{
  assertTransition("collected", "reviewing");
  assertTransition("reviewing", "processed");
  assertTransition("collected", "rejected");
  assertTransition("processed", "archived");
  assert.throws(() => assertTransition("collected", "processed"), /transition/);
  assert.throws(() => assertTransition("archived", "collected"), /transition/);
  console.log("KP003 transitions PASS");
}

// --- CRUD + validation ---
{
  const root = tmpDir("aikido-src-");
  const intake = createAikidoSourceIntake({ rootDir: root, now });

  assert.ok(SOURCE_TYPES.includes("book"));
  assert.throws(
    () =>
      intake.createSource({
        sourceType: "tweet",
        title: "x",
        notes: "n",
      }),
    /sourceType/
  );

  assert.throws(
    () =>
      intake.createSource({
        sourceType: "article",
        title: "No evidence",
      }),
    /url, rawText, or notes/
  );

  const book = intake.createSource({
    id: "book-1",
    sourceType: "book",
    title: "合気道教本",
    author: "植芝盛平",
    publisher: "合気会",
    notes: "第一章のメモ",
    tags: ["book"],
  });
  assert.strictEqual(book.status, "collected");
  assert.strictEqual(book.url, "");
  assert.ok(fs.existsSync(path.join(root, STORE_DIR_REL, "book-1.json")));

  const article = intake.createSource({
    id: "art-1",
    sourceType: "article",
    title: "稽古の心得",
    url: "https://example.com/aikido/tips?utm_source=news#top",
    author: "道場",
    language: "ja",
    rawText: "本文抜粋",
    metadata: { collector: "manual" },
  });
  assert.ok(article.url.includes("utm_source")); // stored as given (trimmed)
  assert.deepStrictEqual(article.metadata, { collector: "manual" });

  assert.throws(
    () =>
      intake.createSource({
        id: "art-2",
        sourceType: "article",
        title: "dup",
        url: "https://example.com/aikido/tips/",
      }),
    /duplicate source URL/
  );

  const allowedDup = intake.createSource({
    id: "art-dup",
    sourceType: "article",
    title: "dup allowed",
    url: "https://example.com/aikido/tips?fbclid=zz",
    allowDuplicateUrl: true,
  });
  assert.strictEqual(allowedDup.id, "art-dup");

  advance(1000);
  const updated = intake.updateSource("book-1", {
    status: "reviewing",
    summary: "要点",
  });
  assert.strictEqual(updated.status, "reviewing");
  assert.strictEqual(updated.updatedAt, "2026-07-24T17:00:01.000Z");
  assert.strictEqual(updated.createdAt, "2026-07-24T17:00:00.000Z");

  assert.throws(
    () => intake.updateSource("book-1", { status: "archived" }),
    /transition/
  );

  const processed = intake.markProcessed("book-1", {
    knowledgeIds: ["ikkyo-basics", "center"],
  });
  assert.strictEqual(processed.status, "processed");
  assert.deepStrictEqual(processed.relatedKnowledgeIds, [
    "ikkyo-basics",
    "center",
  ]);

  // markProcessed from collected in one step
  intake.createSource({
    id: "note-1",
    sourceType: "training-note",
    title: "今日の稽古",
    rawText: "受け身を重点的に",
  });
  const p2 = intake.markProcessed("note-1", { knowledgeIds: ["ukemi"] });
  assert.strictEqual(p2.status, "processed");

  console.log("KP003 crud PASS");
}

// --- filters + order ---
{
  clock = Date.parse("2026-07-24T18:00:00.000Z");
  const intake = createAikidoSourceIntake({
    rootDir: tmpDir("aikido-src-list-"),
    now,
  });
  intake.createSource({
    id: "s1",
    sourceType: "video",
    title: "動画A",
    url: "https://example.com/v1",
    author: "Sensei",
    publisher: "Dojo",
    tags: ["video"],
  });
  advance(1000);
  intake.createSource({
    id: "s2",
    sourceType: "personal-experience",
    title: "体験",
    notes: "自分の体感",
    author: "me",
    tags: ["exp"],
  });
  advance(1000);
  intake.createSource({
    id: "s3",
    sourceType: "video",
    title: "動画B",
    url: "https://example.com/v2",
    rawText: "字幕",
    tags: ["video"],
  });

  const all = intake.listSources();
  assert.deepStrictEqual(
    all.map((s) => s.id),
    ["s1", "s2", "s3"]
  );

  assert.deepStrictEqual(
    intake.listSources({ sourceType: "video" }).map((s) => s.id),
    ["s1", "s3"]
  );
  assert.deepStrictEqual(
    intake.listSources({ hasUrl: false }).map((s) => s.id),
    ["s2"]
  );
  assert.deepStrictEqual(
    intake.listSources({ hasRawText: true }).map((s) => s.id),
    ["s3"]
  );
  assert.deepStrictEqual(
    intake.listSources({ author: "Sensei" }).map((s) => s.id),
    ["s1"]
  );
  assert.deepStrictEqual(
    intake.listSources({ tag: "exp" }).map((s) => s.id),
    ["s2"]
  );
  console.log("KP003 list PASS");
}

// --- independence ---
{
  const src = fs.readFileSync(
    path.join(__dirname, "..", "lib", "aikido-source-intake.js"),
    "utf8"
  );
  assert.ok(
    !/aikido-knowledge|aikido-draft|editorial-store|editorial-engine/.test(src)
  );
  console.log("KP003 independence PASS");
}

console.log("aikido-source-intake-test: all PASS");
