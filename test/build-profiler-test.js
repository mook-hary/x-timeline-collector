/**
 * EP-042 — Reader build profiler.
 * Run: node test/build-profiler-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createBuildProfiler,
  isReaderProfileEnabled,
  READER_PHASE_ORDER,
  roundMs,
} = require("../lib/build-profiler");
const { buildDigestReader } = require("../lib/digest-reader");
const { mergeDigestConfig, DEFAULT_DIGEST_CONFIG } = require("../lib/digest-core");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait for measurable span
  }
}

// --- toggle ---
{
  assert.strictEqual(isReaderProfileEnabled({}), true);
  assert.strictEqual(isReaderProfileEnabled({ READER_PROFILE: "" }), true);
  assert.strictEqual(isReaderProfileEnabled({ READER_PROFILE: "false" }), false);
  assert.strictEqual(isReaderProfileEnabled({ READER_PROFILE: "FALSE" }), false);
  assert.strictEqual(isReaderProfileEnabled({ READER_PROFILE: "true" }), true);
  console.log("EP042 toggle PASS");
}

// --- measure + format ---
{
  const profiler = createBuildProfiler({ enabled: true });
  profiler.startWall();
  profiler.measure("Load Data", () => sleepSync(2));
  profiler.measure("Editorial", () => sleepSync(2));
  profiler.measure("Morning Brief", () => {});
  profiler.measure("Today's Picks", () => {});
  profiler.measure("Category Digest", () => {});
  profiler.measure("HTML Render", () => sleepSync(1));
  profiler.measure("Write File", () => {});
  profiler.endWall();

  const text = profiler.formatReport();
  assert.ok(text.includes("Reader Build"));
  assert.ok(text.includes("Load Data"));
  assert.ok(text.includes("Editorial"));
  assert.ok(text.includes("Morning Brief"));
  assert.ok(text.includes("Today's Picks"));
  assert.ok(text.includes("Category Digest"));
  assert.ok(text.includes("HTML Render"));
  assert.ok(text.includes("Write File"));
  assert.ok(text.includes("Total"));
  assert.ok(text.includes(" ms"));
  assert.ok(text.includes("----------------------------"));

  for (const phase of READER_PHASE_ORDER) {
    assert.ok(text.includes(phase), phase);
  }

  const json = profiler.toJSON();
  assert.ok(json.Total >= 0);
  assert.ok(json["Load Data"] >= 0);

  const logs = [];
  profiler.report({ write: (s) => logs.push(s) });
  assert.ok(logs.join("").includes("Reader Build"));
  console.log("EP042 format PASS");
}

// --- disabled ---
{
  const profiler = createBuildProfiler({ enabled: false });
  profiler.startWall();
  let ran = false;
  profiler.measure("Load Data", () => {
    ran = true;
    return 1;
  });
  profiler.endWall();
  assert.strictEqual(ran, true);
  assert.strictEqual(profiler.formatReport(), "");
  assert.strictEqual(profiler.report({ write: () => {} }), false);
  console.log("EP042 disabled PASS");
}

// --- buildDigestReader integration ---
{
  const root = tmpDir("reader-profile-");
  const out = path.join(root, "out");
  const posts = [
    {
      postedAt: "2026-07-14T10:00:00.000Z",
      url: "https://x.com/a/status/1",
      text: "本文Aは十分な長さのテキストです",
      finalAnalysis: { category: "AI" },
      enrichment: {
        importance: 4,
        summary: "要約Aは十分な長さがあります。",
        reason: "理由",
        tags: ["t"],
      },
    },
  ];
  const chunks = [];
  const result = buildDigestReader({
    rootDir: root,
    outputDir: out,
    posts,
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: { top: 5 },
    profile: true,
    profileStream: { write: (s) => chunks.push(String(s)) },
  });
  assert.ok(fs.existsSync(result.htmlPath));
  assert.ok(result.profile);
  assert.ok(typeof result.profile.Total === "number");
  for (const phase of READER_PHASE_ORDER) {
    assert.ok(phase in result.profile, phase);
  }
  const printed = chunks.join("");
  assert.ok(printed.includes("Reader Build"));
  assert.ok(printed.includes("Total"));

  const silent = [];
  buildDigestReader({
    rootDir: root,
    outputDir: path.join(root, "out2"),
    posts,
    config: mergeDigestConfig(DEFAULT_DIGEST_CONFIG),
    digestOptions: { top: 5 },
    profile: false,
    profileStream: { write: (s) => silent.push(String(s)) },
  });
  assert.strictEqual(silent.join(""), "");
  console.log("EP042 reader-integration PASS");
}

{
  assert.strictEqual(roundMs(1.24), 1.2);
  assert.strictEqual(roundMs(12.4), 12);
  console.log("EP042 round PASS");
}

console.log("build-profiler-test: all PASS");
