/**
 * XP-001 — X Post Formatter.
 * Run: node test/x-post-formatter-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  createXPostFormatter,
  FORMATTER_VERSION,
  DEFAULT_MAX_LENGTH,
} = require("../lib/x-post-formatter");
const { createEditorialStore } = require("../lib/editorial-store");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = "2026-07-24T23:00:00.000Z";

function item(partial = {}) {
  return {
    id: "ed-1",
    source: "aikido",
    type: "post",
    title: "中心",
    summary: "要約",
    body: "合気道では中心を保つ。\n力を抜いて動く。",
    tags: ["center", "aikido"],
    score: 0,
    status: "draft",
    metadata: {
      source: "aikido",
      knowledgeId: "know-1",
      templateId: "principle-short",
      generatedAt: NOW,
      bridgeVersion: "1",
    },
    ...partial,
  };
}

// --- single format + metadata (no rewrite) ---
{
  const formatter = createXPostFormatter({ now: NOW });
  const source = item();
  const bodyBefore = source.body;
  const formatted = formatter.formatPost(source);

  assert.strictEqual(
    formatted.text,
    "合気道では中心を保つ。\n力を抜いて動く。"
  );
  assert.strictEqual(source.body, bodyBefore);
  assert.deepStrictEqual(formatted.warnings, []);
  assert.strictEqual(formatted.metadata.editorialId, "ed-1");
  assert.strictEqual(formatted.metadata.knowledgeId, "know-1");
  assert.strictEqual(formatted.metadata.templateId, "principle-short");
  assert.strictEqual(formatted.metadata.estimatedLength, formatted.text.length);
  assert.strictEqual(formatted.metadata.formattedAt, NOW);
  assert.strictEqual(formatted.metadata.formatterVersion, FORMATTER_VERSION);
  assert.strictEqual(DEFAULT_MAX_LENGTH, 280);
  console.log("XP001 single PASS");
}

// --- 280 / warning (no truncation) ---
{
  const longBody = "あ".repeat(300);
  const formatter = createXPostFormatter({ now: NOW });
  const formatted = formatter.formatPost(item({ body: longBody }));
  assert.strictEqual(formatted.text, longBody);
  assert.strictEqual(formatted.metadata.estimatedLength, 300);
  assert.strictEqual(formatted.warnings.length, 1);
  assert.ok(/exceeds maxLength \(280\)/.test(formatted.warnings[0]));

  const custom = formatter.formatPost(item({ body: "x".repeat(10) }), {
    maxLength: 5,
  });
  assert.strictEqual(custom.text, "x".repeat(10));
  assert.strictEqual(custom.warnings.length, 1);
  console.log("XP001 warning PASS");
}

// --- hashtags ---
{
  const formatter = createXPostFormatter({ now: NOW });
  const off = formatter.formatPost(item());
  assert.ok(!off.text.includes("#"));

  const on = formatter.formatPost(item(), { includeHashtags: true });
  assert.ok(on.text.endsWith("#center #aikido"));
  assert.ok(on.text.startsWith("合気道では中心を保つ。"));
  assert.ok(on.text.includes("\n\n#center"));

  const fromMeta = formatter.formatPost(
    item({
      body: "",
      tags: [],
      metadata: {
        knowledgeId: "k",
        templateId: "t",
        hashtags: ["稽古", "#ukemi"],
      },
    }),
    { includeHashtags: true }
  );
  assert.strictEqual(fromMeta.text, "#稽古 #ukemi");
  console.log("XP001 hashtag PASS");
}

// --- formatPosts order + limit ---
{
  const formatter = createXPostFormatter({ now: NOW });
  const items = [
    item({ id: "a", body: "A文" }),
    item({ id: "b", body: "B文" }),
    item({ id: "c", body: "C文" }),
  ];
  const all = formatter.formatPosts(items);
  assert.deepStrictEqual(
    all.map((p) => p.metadata.editorialId),
    ["a", "b", "c"]
  );
  assert.deepStrictEqual(
    all.map((p) => p.text),
    ["A文", "B文", "C文"]
  );
  const limited = formatter.formatPosts(items, { limit: 2 });
  assert.strictEqual(limited.length, 2);
  assert.strictEqual(limited[0].metadata.editorialId, "a");
  assert.strictEqual(limited[1].metadata.editorialId, "b");
  console.log("XP001 batch-order PASS");
}

// --- line ending normalize only ---
{
  const formatter = createXPostFormatter({ now: NOW });
  const formatted = formatter.formatPost(
    item({ body: "一行\r\n二行\r三行\n" })
  );
  assert.strictEqual(formatted.text, "一行\n二行\n三行");
  console.log("XP001 newline PASS");
}

// --- CLI + JSON ---
{
  const root = tmpDir("x-post-fmt-");
  const store = createEditorialStore({
    rootDir: root,
    now: () => NOW,
  });
  const created = store.create({
    id: "ed-preview-1",
    source: "aikido",
    type: "post",
    title: "preview",
    body: "プレビュー本文です。",
    tags: ["keiko"],
    metadata: {
      knowledgeId: "know-p",
      templateId: "training-tip",
    },
  });

  const script = path.join(__dirname, "..", "scripts", "aikido-x-preview.js");
  const human = spawnSync(
    process.execPath,
    [script, `--rootDir=${root}`, `--id=${created.id}`],
    { encoding: "utf8" }
  );
  assert.strictEqual(human.status, 0, human.stderr);
  assert.ok(human.stdout.includes("X Post Preview"));
  assert.ok(human.stdout.includes("プレビュー本文です。"));
  assert.ok(!human.stdout.includes("#keiko"));

  const json = spawnSync(
    process.execPath,
    [
      script,
      `--rootDir=${root}`,
      `--id=${created.id}`,
      "--json",
      "--includeHashtags",
    ],
    { encoding: "utf8" }
  );
  assert.strictEqual(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.ok(parsed.text.includes("プレビュー本文です。"));
  assert.ok(parsed.text.includes("#keiko"));
  assert.strictEqual(parsed.metadata.editorialId, created.id);
  assert.strictEqual(parsed.metadata.knowledgeId, "know-p");
  assert.strictEqual(parsed.metadata.formatterVersion, FORMATTER_VERSION);

  const missing = spawnSync(
    process.execPath,
    [script, `--rootDir=${root}`, "--id=missing-ed"],
    { encoding: "utf8" }
  );
  assert.strictEqual(missing.status, 1);
  assert.ok(/not found/i.test(missing.stderr));
  console.log("XP001 cli PASS");
}

console.log("x-post-formatter-test: all PASS");
