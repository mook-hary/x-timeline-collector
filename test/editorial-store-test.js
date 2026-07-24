/**
 * EP-049 — Editorial Content Store.
 * Run: node test/editorial-store-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  STORE_DIR_REL,
  createEditorialStore,
  validateId,
} = require("../lib/editorial-store");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let clock = Date.parse("2026-07-24T08:00:00.000Z");
function advance(ms) {
  clock += ms;
}
function now() {
  return new Date(clock).toISOString();
}

// --- validate id ---
{
  assert.strictEqual(validateId("news-1"), "news-1");
  assert.throws(() => validateId("../x"), /path/);
  assert.throws(() => validateId(""), /non-empty/);
  console.log("EP049 validate-id PASS");
}

// --- create / find / update / list ---
{
  const root = tmpDir("editorial-store-");
  const store = createEditorialStore({ rootDir: root, now });

  const created = store.create({
    id: "aikido-post-001",
    source: "aikido",
    type: "post",
    title: "朝稽古メモ",
    summary: "体の使い方",
    body: "本日の要点...",
    tags: ["keiko", "notes"],
    score: 0.8,
  });
  assert.strictEqual(created.id, "aikido-post-001");
  assert.strictEqual(created.status, "draft");
  assert.strictEqual(created.source, "aikido");
  assert.strictEqual(created.type, "post");
  assert.strictEqual(created.createdAt, "2026-07-24T08:00:00.000Z");
  assert.strictEqual(created.updatedAt, "2026-07-24T08:00:00.000Z");

  const filePath = path.join(root, STORE_DIR_REL, "aikido-post-001.json");
  assert.ok(fs.existsSync(filePath));
  const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.strictEqual(onDisk.title, "朝稽古メモ");
  assert.deepStrictEqual(onDisk.tags, ["keiko", "notes"]);

  assert.strictEqual(store.find("missing"), null);
  const found = store.find("aikido-post-001");
  assert.strictEqual(found.title, "朝稽古メモ");

  advance(60000);
  const updated = store.update("aikido-post-001", {
    status: "ready",
    score: 0.9,
    summary: "更新済み",
  });
  assert.strictEqual(updated.status, "ready");
  assert.strictEqual(updated.score, 0.9);
  assert.strictEqual(updated.summary, "更新済み");
  assert.strictEqual(updated.createdAt, "2026-07-24T08:00:00.000Z");
  assert.strictEqual(updated.updatedAt, "2026-07-24T08:01:00.000Z");
  assert.strictEqual(updated.title, "朝稽古メモ");

  advance(1000);
  store.create({
    id: "news-article-001",
    source: "news",
    type: "article",
    title: "ヘッドライン",
    body: "本文",
  });

  const all = store.list();
  assert.strictEqual(all.length, 2);
  // newest updatedAt first
  assert.strictEqual(all[0].id, "news-article-001");
  assert.strictEqual(all[1].id, "aikido-post-001");

  assert.deepStrictEqual(
    store.listByStatus("ready").map((i) => i.id),
    ["aikido-post-001"]
  );
  assert.deepStrictEqual(
    store.listBySource("news").map((i) => i.id),
    ["news-article-001"]
  );
  assert.deepStrictEqual(store.listBySource("animation"), []);

  assert.throws(
    () =>
      store.create({
        id: "aikido-post-001",
        source: "aikido",
        type: "post",
        title: "dup",
      }),
    /already exists/
  );
  assert.throws(
    () => store.update("nope", { title: "x" }),
    /not found/
  );
  assert.throws(
    () =>
      store.create({
        source: "news",
        type: "blog",
        title: "bad",
      }),
    /article.*post/
  );

  // auto id
  const auto = store.create({
    source: "animation",
    type: "article",
    title: "Auto",
  });
  assert.ok(/^ed-/.test(auto.id));
  assert.ok(store.find(auto.id));

  console.log("EP049 crud PASS");
}

console.log("editorial-store-test: all PASS");
