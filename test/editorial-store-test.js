/**
 * EP-049 — Editorial Content Store.
 * EP-050 — Editorial Workflow.
 * Run: node test/editorial-store-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  STORE_DIR_REL,
  WORKFLOW_STATUSES,
  createEditorialStore,
  validateId,
  canTransition,
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
function resetClock(iso = "2026-07-24T08:00:00.000Z") {
  clock = Date.parse(iso);
}

// --- validate id ---
{
  assert.strictEqual(validateId("news-1"), "news-1");
  assert.throws(() => validateId("../x"), /path/);
  assert.throws(() => validateId(""), /non-empty/);
  console.log("EP049 validate-id PASS");
}

// --- create / find / update / list (backward compatible) ---
{
  resetClock();
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
    score: 0.9,
    summary: "更新済み",
  });
  assert.strictEqual(updated.status, "draft");
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
  assert.strictEqual(all[0].id, "news-article-001");
  assert.strictEqual(all[1].id, "aikido-post-001");

  assert.deepStrictEqual(
    store.listByStatus("draft").map((i) => i.id).sort(),
    ["aikido-post-001", "news-article-001"]
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
  assert.throws(() => store.update("nope", { title: "x" }), /not found/);
  assert.throws(
    () =>
      store.create({
        source: "news",
        type: "blog",
        title: "bad",
      }),
    /article.*post/
  );

  const auto = store.create({
    source: "animation",
    type: "article",
    title: "Auto",
  });
  assert.ok(/^ed-/.test(auto.id));
  assert.ok(store.find(auto.id));

  console.log("EP049 crud PASS");
}

// --- EP-050 workflow transitions + timestamps ---
{
  resetClock("2026-07-24T09:00:00.000Z");
  const store = createEditorialStore({
    rootDir: tmpDir("editorial-wf-"),
    now,
  });
  store.create({
    id: "wf-1",
    source: "news",
    type: "article",
    title: "Workflow",
    body: "x",
  });

  assert.ok(canTransition("draft", "review"));
  assert.ok(!canTransition("draft", "published"));
  assert.deepStrictEqual(WORKFLOW_STATUSES[0], "draft");

  let item = store.transition("wf-1", "review");
  assert.strictEqual(item.status, "review");
  assert.strictEqual(item.reviewedAt, "2026-07-24T09:00:00.000Z");

  advance(1000);
  item = store.transition("wf-1", "approved");
  assert.strictEqual(item.status, "approved");
  assert.strictEqual(item.approvedAt, "2026-07-24T09:00:01.000Z");
  assert.strictEqual(item.reviewedAt, "2026-07-24T09:00:00.000Z");

  advance(1000);
  item = store.transition("wf-1", "published");
  assert.strictEqual(item.status, "published");
  assert.strictEqual(item.publishedAt, "2026-07-24T09:00:02.000Z");

  advance(1000);
  item = store.transition("wf-1", "archived");
  assert.strictEqual(item.status, "archived");
  assert.strictEqual(item.archivedAt, "2026-07-24T09:00:03.000Z");

  advance(1000);
  item = store.transition("wf-1", "draft");
  assert.strictEqual(item.status, "draft");

  // happy path via scheduled
  store.create({
    id: "wf-2",
    source: "aikido",
    type: "post",
    title: "Sched",
  });
  store.transition("wf-2", "review");
  store.transition("wf-2", "approved");
  advance(1000);
  item = store.transition("wf-2", "scheduled", {
    scheduledAt: "2026-07-25T07:00:00.000Z",
  });
  assert.strictEqual(item.status, "scheduled");
  assert.strictEqual(item.scheduledAt, "2026-07-25T07:00:00.000Z");

  // review → draft
  store.create({ id: "wf-3", source: "news", type: "post", title: "back" });
  store.transition("wf-3", "review");
  item = store.transition("wf-3", "draft");
  assert.strictEqual(item.status, "draft");

  console.log("EP050 transitions PASS");
}

// --- invalid transitions / missing id ---
{
  resetClock();
  const store = createEditorialStore({
    rootDir: tmpDir("editorial-wf-bad-"),
    now,
  });
  store.create({ id: "bad-1", source: "news", type: "article", title: "t" });

  assert.throws(
    () => store.transition("bad-1", "published"),
    /invalid status transition/
  );
  assert.throws(
    () => store.transition("missing-id", "review"),
    /not found/
  );
  store.transition("bad-1", "review");
  assert.throws(
    () => store.transition("bad-1", "scheduled"),
    /invalid status transition/
  );
  console.log("EP050 invalid-transition PASS");
}

// --- scheduledAt required ---
{
  resetClock();
  const store = createEditorialStore({
    rootDir: tmpDir("editorial-sched-"),
    now,
  });
  store.create({ id: "s1", source: "news", type: "article", title: "t" });
  store.transition("s1", "review");
  store.transition("s1", "approved");
  assert.throws(
    () => store.transition("s1", "scheduled"),
    /scheduledAt is required/
  );
  assert.throws(
    () => store.transition("s1", "scheduled", { scheduledAt: "not-a-date" }),
    /invalid scheduledAt/
  );
  console.log("EP050 scheduledAt PASS");
}

// --- listReadyToPublish ---
{
  resetClock("2026-07-24T10:00:00.000Z");
  const store = createEditorialStore({
    rootDir: tmpDir("editorial-ready-"),
    now,
  });

  function toScheduled(id, at) {
    store.create({ id, source: "news", type: "article", title: id });
    store.transition(id, "review");
    store.transition(id, "approved");
    store.transition(id, "scheduled", { scheduledAt: at });
  }

  toScheduled("later", "2026-07-24T12:00:00.000Z");
  toScheduled("soon", "2026-07-24T09:00:00.000Z");
  toScheduled("mid", "2026-07-24T10:00:00.000Z");
  store.create({ id: "drafty", source: "news", type: "post", title: "d" });

  const ready = store.listReadyToPublish("2026-07-24T10:00:00.000Z");
  assert.deepStrictEqual(
    ready.map((i) => i.id),
    ["soon", "mid"]
  );
  assert.ok(ready.every((i) => i.status === "scheduled"));

  const none = store.listReadyToPublish("2026-07-24T08:00:00.000Z");
  assert.deepStrictEqual(none, []);

  const allDue = store.listReadyToPublish("2026-07-24T12:00:00.000Z");
  assert.deepStrictEqual(
    allDue.map((i) => i.id),
    ["soon", "mid", "later"]
  );
  console.log("EP050 listReadyToPublish PASS");
}

// --- update must not change status ---
{
  resetClock();
  const store = createEditorialStore({
    rootDir: tmpDir("editorial-no-status-"),
    now,
  });
  store.create({ id: "u1", source: "news", type: "article", title: "t" });
  assert.throws(
    () => store.update("u1", { status: "review" }),
    /use transition/
  );
  assert.throws(
    () => store.update("u1", { status: "draft" }),
    /use transition/
  );
  const still = store.find("u1");
  assert.strictEqual(still.status, "draft");
  // content update still works
  const ok = store.update("u1", { title: "new" });
  assert.strictEqual(ok.title, "new");
  assert.strictEqual(ok.status, "draft");
  console.log("EP050 update-status-blocked PASS");
}

// --- create non-draft rejected ---
{
  const store = createEditorialStore({
    rootDir: tmpDir("editorial-create-status-"),
    now,
  });
  assert.throws(
    () =>
      store.create({
        id: "c1",
        source: "news",
        type: "article",
        title: "t",
        status: "approved",
      }),
    /must start as "draft"/
  );
  console.log("EP050 create-draft-only PASS");
}

console.log("editorial-store-test: all PASS");
