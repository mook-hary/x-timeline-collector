/**
 * KP-006 — Knowledge Seed CLI.
 * Run: node test/aikido-knowledge-add-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  parseTags,
  resolveDifficulty,
  buildKnowledgeInput,
  runKnowledgeAdd,
  ERROR_CODES,
} = require("../lib/aikido-knowledge-add");
const {
  createAikidoKnowledgeStore,
  STORE_DIR_REL,
} = require("../lib/aikido-knowledge");
const { runSessionCli } = require("../lib/aikido-session-cli");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-25T03:00:00.000Z";

function capture(argv, rootDir) {
  let out = "";
  let err = "";
  const result = runKnowledgeAdd({
    argv,
    rootDir,
    now: () => NOW,
    stdout: { write(s) { out += s; } },
    stderr: { write(s) { err += s; } },
  });
  return { ...result, out, err };
}

// --- tags + difficulty mapping ---
{
  assert.deepStrictEqual(parseTags("呼吸力, 脱力, 基本原理"), [
    "呼吸力",
    "脱力",
    "基本原理",
  ]);
  assert.deepStrictEqual(parseTags(""), []);
  assert.strictEqual(resolveDifficulty("beginner"), 1);
  assert.strictEqual(resolveDifficulty("3"), 3);
  assert.strictEqual(resolveDifficulty(undefined), 1);
  console.log("KP006 parse PASS");
}

// --- build object ---
{
  const input = buildKnowledgeInput({
    title: "呼吸力とは力を抜くことではない",
    category: "principle",
    body: "力を抜くだけでは技にはならない。",
    summary: "要約",
    difficulty: "beginner",
    tags: "呼吸力,脱力,基本原理",
  });
  assert.strictEqual(input.content, "力を抜くだけでは技にはならない。");
  assert.strictEqual(input.difficulty, 1);
  assert.deepStrictEqual(input.tags, ["呼吸力", "脱力", "基本原理"]);
  assert.deepStrictEqual(input.sources, []);
  assert.deepStrictEqual(input.related, []);
  console.log("KP006 build PASS");
}

// --- required args ---
{
  assert.throws(
    () => buildKnowledgeInput({ category: "principle", body: "x" }),
    (e) => e.code === ERROR_CODES.KNOWLEDGE_TITLE_REQUIRED
  );
  assert.throws(
    () => buildKnowledgeInput({ title: "t", body: "x" }),
    (e) => e.code === ERROR_CODES.KNOWLEDGE_CATEGORY_REQUIRED
  );
  assert.throws(
    () => buildKnowledgeInput({ title: "t", category: "principle" }),
    (e) => e.code === ERROR_CODES.KNOWLEDGE_BODY_REQUIRED
  );

  const missingTitle = capture(
    ["--category=principle", "--body=本文"],
    tmpDir("kadd-miss-")
  );
  assert.strictEqual(missingTitle.exitCode, 1);
  assert.ok(missingTitle.err.includes("KNOWLEDGE_TITLE_REQUIRED"));

  const missingCat = capture(
    ["--title=t", "--body=本文"],
    tmpDir("kadd-missc-")
  );
  assert.strictEqual(missingCat.exitCode, 1);
  assert.ok(missingCat.err.includes("KNOWLEDGE_CATEGORY_REQUIRED"));

  const missingBody = capture(
    ["--title=t", "--category=principle"],
    tmpDir("kadd-missb-")
  );
  assert.strictEqual(missingBody.exitCode, 1);
  assert.ok(missingBody.err.includes("KNOWLEDGE_BODY_REQUIRED"));
  console.log("KP006 required PASS");
}

// --- dry-run does not write ---
{
  const root = tmpDir("kadd-dry-");
  const storeDir = path.join(root, STORE_DIR_REL);
  const result = capture(
    [
      "--title=テスト",
      "--category=principle",
      "--body=テスト本文",
      "--dry-run",
    ],
    root
  );
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.written, false);
  assert.ok(result.out.includes("DRY RUN"));
  assert.ok(result.out.includes("No files were written."));
  assert.ok(result.knowledge);
  assert.strictEqual(result.knowledge.content, "テスト本文");
  assert.ok(!fs.existsSync(storeDir) || fs.readdirSync(storeDir).length === 0);
  console.log("KP006 dry-run PASS");
}

// --- write + preserve existing + list ---
{
  const root = tmpDir("kadd-write-");
  const store = createAikidoKnowledgeStore({
    rootDir: root,
    now: () => NOW,
  });
  store.createKnowledge({
    id: "existing-1",
    title: "既存",
    category: "training",
    content: "既存本文",
    difficulty: 2,
    tags: ["old"],
    sources: ["道場"],
  });
  assert.strictEqual(store.listKnowledge().length, 1);

  const result = capture(
    [
      "--title=呼吸力とは力を抜くことではない",
      "--category=principle",
      "--summary=要約です",
      "--body=力を抜くだけでは技にはならない。",
      "--difficulty=beginner",
      "--tags=呼吸力, 脱力, 基本原理",
      "--json",
    ],
    root
  );
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.written, true);
  const payload = JSON.parse(result.out);
  assert.strictEqual(payload.ok, true);
  assert.ok(payload.knowledge.id);
  assert.strictEqual(payload.knowledge.difficulty, 1);
  assert.deepStrictEqual(payload.knowledge.tags, [
    "呼吸力",
    "脱力",
    "基本原理",
  ]);
  assert.strictEqual(payload.knowledge.content.includes("力を抜く"), true);

  const listed = store.listKnowledge();
  assert.strictEqual(listed.length, 2);
  assert.ok(listed.some((k) => k.id === "existing-1"));
  assert.ok(listed.some((k) => k.id === payload.knowledge.id));

  const filePath = path.join(
    root,
    STORE_DIR_REL,
    `${payload.knowledge.id}.json`
  );
  assert.ok(fs.existsSync(filePath));

  let listOut = "";
  const listResult = runSessionCli({
    kind: "knowledge",
    rootDir: root,
    argv: ["--json"],
    stdout: { write(s) { listOut += s; } },
    stderr: { write() {} },
  });
  assert.strictEqual(listResult.exitCode, 0);
  const listJson = JSON.parse(listOut);
  assert.ok(listJson.some((k) => k.id === payload.knowledge.id));
  console.log("KP006 write-list PASS");
}

// --- script spawn dry-run ---
{
  const root = tmpDir("kadd-cli-");
  const script = path.join(
    __dirname,
    "..",
    "scripts",
    "aikido-knowledge-add.js"
  );
  const dry = spawnSync(
    process.execPath,
    [
      script,
      `--rootDir=${root}`,
      "--title=テストKnowledge",
      "--category=principle",
      "--body=これはdry-runです。",
      "--tags=テスト,基本",
      "--dry-run",
    ],
    { encoding: "utf8" }
  );
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes("DRY RUN"));
  assert.ok(dry.stdout.includes("No files were written."));
  const storeDir = path.join(root, STORE_DIR_REL);
  assert.ok(!fs.existsSync(storeDir) || fs.readdirSync(storeDir).length === 0);
  console.log("KP006 spawn PASS");
}

console.log("aikido-knowledge-add-test: all PASS");
