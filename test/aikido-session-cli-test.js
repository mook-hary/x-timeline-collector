/**
 * KS-001 — Knowledge Session CLI.
 * Run: node test/aikido-session-cli-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  parseArgs,
  runSessionCli,
} = require("../lib/aikido-session-cli");
const { createAikidoSourceIntake } = require("../lib/aikido-source-intake");
const { createAikidoCandidateReview } = require("../lib/aikido-candidate-review");
const { createAikidoKnowledgeStore } = require("../lib/aikido-knowledge");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function capture(kind, rootDir, argv) {
  let out = "";
  let err = "";
  const result = runSessionCli({
    kind,
    rootDir,
    argv,
    stdout: { write(s) { out += s; } },
    stderr: { write(s) { err += s; } },
  });
  return { ...result, out, err };
}

const NOW = "2026-07-24T21:00:00.000Z";
let clock = Date.parse(NOW);
function now() {
  return new Date(clock).toISOString();
}
function advance(ms) {
  clock += ms;
}

// --- parseArgs ---
{
  const a = parseArgs([
    "--status=collected",
    "--type=official-site",
    "--limit=20",
    "--json",
    "--hasWarnings",
    "--category=principle",
    "--difficulty=2",
    "--tag=ukemi",
    "--id=abc",
  ]);
  assert.strictEqual(a.status, "collected");
  assert.strictEqual(a.type, "official-site");
  assert.strictEqual(a.limit, "20");
  assert.strictEqual(a.json, true);
  assert.strictEqual(a.hasWarnings, true);
  assert.strictEqual(a.category, "principle");
  assert.strictEqual(a.difficulty, "2");
  assert.strictEqual(a.tag, "ukemi");
  assert.strictEqual(a.id, "abc");
  console.log("KS001 parseArgs PASS");
}

// --- fixture data ---
const root = tmpDir("aikido-session-");
clock = Date.parse(NOW);
const intake = createAikidoSourceIntake({ rootDir: root, now });
const reviewStore = createAikidoCandidateReview({ rootDir: root, now });
const knowledge = createAikidoKnowledgeStore({ rootDir: root, now });

const src1 = intake.createSource({
  id: "src-session-1",
  sourceType: "official-site",
  title: "合気会公式",
  url: "https://example.com/a",
  notes: "公式サイトメモ",
  tags: ["official"],
});
advance(1000);
const src2 = intake.createSource({
  id: "src-session-2",
  sourceType: "article",
  title: "稽古記事",
  rawText: "本文本文本文",
  tags: ["article"],
});

const rev1 = reviewStore.createReview({
  candidateId: "cand-s1",
  sourceId: src1.id,
  title: "中心",
  category: "principle",
  summary: "中心を保つ",
  content: "内容",
  tags: ["center"],
  difficulty: 2,
  confidence: 0.9,
  warnings: [],
  sourceReferences: [{ sourceId: src1.id, quote: "中心", location: "p1" }],
});
advance(1000);
const rev2 = reviewStore.createReview({
  candidateId: "cand-s2",
  sourceId: src2.id,
  title: "受け身",
  category: "training",
  summary: "受け身",
  content: "内容2",
  tags: ["ukemi"],
  difficulty: 1,
  confidence: 0.4,
  warnings: ["要確認"],
  sourceReferences: [{ sourceId: src2.id, quote: "受け", location: "p2" }],
});

knowledge.createKnowledge({
  id: "know-session-1",
  title: "受け身の基本",
  category: "training",
  summary: "安全な受け",
  content: "後方受け身の要点",
  tags: ["ukemi", "basics"],
  difficulty: 2,
  sources: ["道場"],
});
advance(1000);
knowledge.createKnowledge({
  id: "know-session-2",
  title: "中心の原理",
  category: "principle",
  summary: "中心",
  content: "中心を崩さない",
  tags: ["center"],
  difficulty: 3,
  sources: ["教本"],
});

// --- Source list / filter / limit / json ---
{
  const listed = capture("source", root, []);
  assert.strictEqual(listed.exitCode, 0);
  assert.ok(listed.out.includes("ID"));
  assert.ok(listed.out.includes("src-session-1"));
  assert.ok(listed.out.includes("src-session-2"));
  assert.ok(listed.out.includes("Source Type"));

  const filtered = capture("source", root, [
    "--status=collected",
    "--type=official-site",
  ]);
  assert.strictEqual(filtered.exitCode, 0);
  assert.ok(filtered.out.includes("src-session-1"));
  assert.ok(!filtered.out.includes("src-session-2"));

  const limited = capture("source", root, ["--limit=1"]);
  assert.strictEqual(limited.exitCode, 0);
  assert.ok(limited.out.includes("src-session-1"));
  assert.ok(!limited.out.includes("src-session-2"));

  const json = capture("source", root, ["--json", "--limit=1"]);
  assert.strictEqual(json.exitCode, 0);
  const parsed = JSON.parse(json.out);
  assert.ok(Array.isArray(parsed));
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].id, "src-session-1");
  console.log("KS001 source-list PASS");
}

// --- Review list / hasWarnings / category ---
{
  const listed = capture("review", root, []);
  assert.strictEqual(listed.exitCode, 0);
  assert.ok(listed.out.includes("Confidence"));
  assert.ok(listed.out.includes(rev1.id));
  assert.ok(listed.out.includes(rev2.id));

  const byCat = capture("review", root, ["--category=principle"]);
  assert.ok(byCat.out.includes(rev1.id));
  assert.ok(!byCat.out.includes(rev2.id));

  const warns = capture("review", root, ["--hasWarnings"]);
  assert.ok(warns.out.includes(rev2.id));
  assert.ok(!warns.out.includes(rev1.id));

  const pending = capture("review", root, ["--status=pending", "--json"]);
  const arr = JSON.parse(pending.out);
  assert.strictEqual(arr.length, 2);
  console.log("KS001 review-list PASS");
}

// --- Knowledge list / tag / difficulty ---
{
  const listed = capture("knowledge", root, []);
  assert.strictEqual(listed.exitCode, 0);
  assert.ok(listed.out.includes("Difficulty"));
  assert.ok(listed.out.includes("know-session-1"));

  const byTag = capture("knowledge", root, ["--tag=ukemi"]);
  assert.ok(byTag.out.includes("know-session-1"));
  assert.ok(!byTag.out.includes("know-session-2"));

  const byDiff = capture("knowledge", root, ["--difficulty=2", "--json"]);
  const arr = JSON.parse(byDiff.out);
  assert.strictEqual(arr.length, 1);
  assert.strictEqual(arr[0].id, "know-session-1");

  const byCat = capture("knowledge", root, ["--category=training"]);
  assert.ok(byCat.out.includes("know-session-1"));
  assert.ok(!byCat.out.includes("know-session-2"));
  console.log("KS001 knowledge-list PASS");
}

// --- detail by id (human, not raw-only dump as sole line) ---
{
  const detail = capture("source", root, [`--id=${src1.id}`]);
  assert.strictEqual(detail.exitCode, 0);
  assert.ok(detail.out.includes(`id: ${src1.id}`));
  assert.ok(detail.out.includes("title:"));
  assert.ok(!detail.out.trimStart().startsWith("{"));

  const detailJson = capture("knowledge", root, [
    "--id=know-session-1",
    "--json",
  ]);
  const obj = JSON.parse(detailJson.out);
  assert.strictEqual(obj.id, "know-session-1");
  assert.strictEqual(obj.title, "受け身の基本");
  console.log("KS001 detail PASS");
}

// --- missing id + exit code ---
{
  const missing = capture("source", root, ["--id=does-not-exist"]);
  assert.strictEqual(missing.exitCode, 1);
  assert.ok(/source not found/i.test(missing.err));

  const missingRev = capture("review", root, ["--id=no-rev"]);
  assert.strictEqual(missingRev.exitCode, 1);
  assert.ok(/review not found/i.test(missingRev.err));

  const missingKnow = capture("knowledge", root, ["--id=no-know"]);
  assert.strictEqual(missingKnow.exitCode, 1);
  assert.ok(/knowledge not found/i.test(missingKnow.err));
  console.log("KS001 missing-id PASS");
}

// --- process exit via script ---
{
  const script = path.join(__dirname, "..", "scripts", "aikido-session.js");
  const ok = spawnSync(
    process.execPath,
    [script, "source", `--rootDir=${root}`, "--json", "--limit=1"],
    { encoding: "utf8" }
  );
  assert.strictEqual(ok.status, 0, ok.stderr);
  const rows = JSON.parse(ok.stdout);
  assert.strictEqual(rows.length, 1);

  const bad = spawnSync(
    process.execPath,
    [script, "source", `--rootDir=${root}`, "--id=missing-xyz"],
    { encoding: "utf8" }
  );
  assert.strictEqual(bad.status, 1);
  assert.ok(/not found/i.test(bad.stderr));
  console.log("KS001 spawn-exit PASS");
}

console.log("aikido-session-cli-test: all PASS");
