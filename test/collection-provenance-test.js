/** No real network, AI, Collect or Morning. Actual stage bodies use temp files and fakes. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { spawnSync } = require("child_process");
const p = require("../lib/collection-provenance");
const { writeJsonAtomicOrThrow } = require("../lib/pipeline-io");
const repo = path.resolve(__dirname, "..");
const T1 = "2026-09-18T03:00:00.000Z";
const T2 = "2026-09-19T03:00:00.000Z";
const collectFixture = process.argv[2] === "--collect-fixture";
const root = collectFixture ? process.argv[3] : fs.mkdtempSync(path.join(os.tmpdir(), "collection-provenance-"));
function bound(file, data, time = T1) {
  const writer = p.createArtifactWriter(file, { collection: true, now: () => time });
  try { writer.writeJson(data); return writer.complete(); } finally { writer.release(); }
}
function receipt(file) { return p.readArtifactSnapshot(file).provenance; }
let count = 0;
async function check(name, run) { await run(); count++; console.log(`provenance ${name} PASS`); }

// Compile real CLI code without invoking its entrypoint; all filesystem outputs
// use a fake __dirname. Dependency injection replaces ONLY external services/I/O faults.
function stageMain(name, home, argv, overrides = {}) {
  const filename = path.join(repo, name);
  const actualRequire = createRequire(filename);
  const mod = { exports: {} };
  const safeRequire = id => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === "dotenv") return { config() {} };
    if (id === "openai") return class { constructor() { this.responses = { create: async () => { throw new Error("fake AI failure"); } }; } };
    if (id === "playwright") return { chromium: { connectOverCDP() { throw new Error("real Chrome forbidden"); } } };
    if (id === "./lib/pipeline-io") return { ...actualRequire(id), fail(message) { throw new Error(message); } };
    return actualRequire(id);
  };
  const context = {
    module: mod, exports: mod.exports, require: safeRequire,
    __dirname: home, __filename: filename, Buffer,
    process: { argv: [process.execPath, filename, ...argv], env: { OPENAI_API_KEY: "fake-test-key" }, cwd: () => home, exit: process.exit.bind(process) },
    console: overrides.console || { log() {}, error() {}, warn() {} },
    setTimeout: fn => { fn(); }, clearTimeout() {},
  };
  const fakeCollect = overrides.collectFixture ? `
    connectToChrome = async () => ({});
    ensureHomePage = async () => ({});
    collectPosts = async () => ({ posts: ${JSON.stringify(overrides.collectPosts || [])}, scrollRecovery: null });
  ` : "";
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + fakeCollect + "\nmodule.exports.__main = main;", context, { filename });
  return mod.exports.__main;
}
function homeDir(label) {
  const home = path.join(root, label);
  fs.mkdirSync(path.join(home, "output"), { recursive: true });
  fs.mkdirSync(path.join(home, "config"), { recursive: true });
  fs.copyFileSync(path.join(repo, "config/categories.json"), path.join(home, "config/categories.json"));
  return home;
}
async function main() {

  await check("actual Collect completion, zero-item and mandatory failure branches", () => {
    for (const mode of ["normal", "zero", "scope-failure", "completion-work-failure", "receipt-failure"]) {
      const home = homeDir(`collect-${mode}`);
      const scope = path.join(home, "output/daily-scope.json");
      fs.mkdirSync(path.join(home, "lib"));
      fs.copyFileSync(path.join(repo, "lib/tweet-media.js"), path.join(home, "lib/tweet-media.js"));
      bound(scope, { posts: [], itemCount: 0 }, T1);
      const child = spawnSync(process.execPath, [__filename, "--collect-fixture", home, mode], { encoding: "utf8" });
      assert.strictEqual(child.status, mode === "normal" || mode === "zero" ? 0 : 1, child.stderr);
      const result = receipt(scope);
      assert.ok(!fs.existsSync(p.lockPath(scope)));
      if (mode === "normal" || mode === "zero") {
        assert.strictEqual(result.collectionCompletedAt, T2);
        const data = JSON.parse(fs.readFileSync(scope));
        assert.strictEqual(data.itemCount, mode === "normal" ? 1 : 0);
        // Existing item collectedAt is still the independent collection clock.
        if (data.posts.length) assert.strictEqual(data.posts[0].collectedAt, data.collectedAt);
      } else {
        assert.strictEqual(result, null, mode);
      }
    }
  });
  await check("exact bytes, two identical empty generations", () => {
    const file = path.join(root, "empty.json");
    const a = bound(file, []); const b = bound(file, [], T2);
    assert.strictEqual(a.artifactSha256, b.artifactSha256);
    assert.notStrictEqual(a.generationId, b.generationId);
    assert.strictEqual(b.collectionCompletedAt, T2);
    assert.strictEqual(b.input, null);
    fs.writeFileSync(file, "[ ]\n");
    assert.strictEqual(p.readArtifactSnapshot(file).reason, "hash-mismatch");
  });
  await check("persistence and receipt failure never certify", () => {
    const file = path.join(root, "failed.json"); bound(file, []);
    let clockCalls = 0;
    let w = p.createArtifactWriter(file, { collection: true, now: () => { clockCalls++; return T1; }, writeJson() { throw new Error("disk"); } });
    try { assert.throws(() => w.writeJson([]), /disk/); assert.strictEqual(w.complete(), null); } finally { w.release(); }
    assert.strictEqual(clockCalls, 0); assert.strictEqual(receipt(file), null);
    w = p.createArtifactWriter(file, { collection: true, now: () => T1, writeReceipt() { throw new Error("receipt disk"); } });
    try { w.writeJson([]); assert.throws(() => w.complete(), /receipt disk/); } finally { w.release(); }
    assert.strictEqual(receipt(file), null);
  });
  await check("completion clock follows persisted bytes", () => {
    const file = path.join(root, "clock.json");
    const w = p.createArtifactWriter(file, { collection: true, now: () => { assert.deepStrictEqual(JSON.parse(fs.readFileSync(file)), []); return T1; } });
    try { w.writeJson([]); assert.strictEqual(w.complete().collectionCompletedAt, T1); } finally { w.release(); }
  });
  await check("missing malformed and invalid timestamp", () => {
    const file = path.join(root, "legacy.json"); fs.writeFileSync(file, "[]");
    assert.strictEqual(p.readArtifactSnapshot(file).reason, "missing");
    fs.writeFileSync(p.provenancePath(file), "bad");
    assert.strictEqual(p.readArtifactSnapshot(file).reason, "malformed");
    const good = bound(file, []);
    for (const timestamp of ["2026-02-30T00:00:00.000Z", "2026-09-18", null]) {
      fs.writeFileSync(p.provenancePath(file), JSON.stringify({ ...good, collectionCompletedAt: timestamp }));
      assert.strictEqual(receipt(file), null);
    }
  });
  await check("stable snapshot rejects mixed receipts", () => {
    const file = path.join(root, "race.json"); const a = bound(file, []);
    let n = 0;
    const result = p.readArtifactSnapshot(file, { readFileSync(name) {
      if (name === p.provenancePath(file)) return JSON.stringify({ ...a, generationId: `race-${n++}` });
      return fs.readFileSync(name);
    } });
    assert.strictEqual(result.provenance, null);
    assert.strictEqual(result.reason, "changed-during-read");
  });
  await check("live and uncertain locks never stolen", () => {
    const file = path.join(root, "lock.json"); const release = p.acquireWriterLock(file);
    assert.throws(() => p.acquireWriterLock(file), { code: "PROVENANCE_LOCKED" });
    release(); release();
    fs.mkdirSync(p.lockPath(file));
    assert.throws(() => p.acquireWriterLock(file), { code: "PROVENANCE_LOCKED" });
    fs.rmdirSync(p.lockPath(file));
    const release2 = p.acquireWriterLock(file); release2();
  });
  await check("process.exit releases owned lock", () => {
    const file = path.join(root, "exit.json");
    const result = spawnSync(process.execPath, ["-e", 'require(process.argv[1]).acquireWriterLock(process.argv[2]); process.exit(1)', path.join(repo, "lib/collection-provenance.js"), file]);
    assert.strictEqual(result.status, 1); assert.ok(!fs.existsSync(p.lockPath(file)));
  });
  await check("new Scope cannot rebind old Enriched", async () => {
    const input = path.join(root, "scope.json"); const output = path.join(root, "enriched.json");
    bound(input, []);
    await p.withArtifactProvenance({ inputPath: input, outputPath: output }, a => a.writeJson(a.data));
    const original = receipt(output);
    bound(input, [], T2);
    assert.throws(() => p.withArtifactProvenance({ inputPath: input, outputPath: output }, () => { throw new Error("downstream"); }), /downstream/);
    assert.deepStrictEqual(receipt(output), original);
    assert.throws(() => p.withArtifactProvenance({ inputPath: input, outputPath: output }, a => { a.writeJson([]); throw new Error("partial"); }), /partial/);
    assert.strictEqual(receipt(output), null);
  });
  await check("unbound input invalidates previously bound output", () => {
    const input = path.join(root, "unbound.json"); const output = path.join(root, "was-bound.json");
    fs.writeFileSync(input, "[]"); bound(output, []);
    p.withArtifactProvenance({ inputPath: input, outputPath: output }, a => a.writeJson(a.data));
    assert.strictEqual(receipt(output), null);
  });
  await check("actual empty writer chain twice including no-work AI branches", async () => {
    const home = homeDir("chain"); const scope = path.join(home, "output/daily-scope.json");
    let previousEnriched;
    for (const time of [T1, T2]) {
      bound(scope, { posts: [], itemCount: 0 }, time);
      let input = scope;
      for (const [script, outputName, flags] of [
        ["analyze.js", "daily-analyzed.json", []],
        ["vision_ai.js", "daily-vision.json", ["--apply"]],
        ["visual_value_ai.js", "daily-visual.json", ["--apply"]],
        ["analyze_ai.js", "daily-ai.json", []],
        ["enrich_ai.js", "daily-enriched.json", []],
      ]) {
        const output = path.join(home, "output", outputName);
        const parent = receipt(input);
        await stageMain(script, home, ["--input", input, "--output", output, ...flags])();
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(output)), []);
        const result = receipt(output);
        assert.strictEqual(result.collectionCompletedAt, time, script);
        assert.deepStrictEqual(result.input, { generationId: parent.generationId, artifactSha256: parent.artifactSha256 });
        assert.ok(!fs.existsSync(p.lockPath(output)));
        input = output;
      }
      if (previousEnriched) {
        assert.strictEqual(receipt(input).artifactSha256, previousEnriched.artifactSha256);
        assert.notStrictEqual(receipt(input).generationId, previousEnriched.generationId);
      }
      previousEnriched = receipt(input);
    }
  });
  await check("Vision and Visual Value dry-run do not mutate receipts", async () => {
    const home = homeDir("dry"); const input = path.join(home, "input.json"); const output = path.join(home, "output/result.json");
    bound(input, []); bound(output, [], T2);
    const before = fs.readFileSync(p.provenancePath(output), "utf8");
    for (const script of ["vision_ai.js", "visual_value_ai.js"]) {
      await stageMain(script, home, ["--dry-run", "--input", input, "--output", output])();
      assert.strictEqual(fs.readFileSync(p.provenancePath(output), "utf8"), before);
      assert.ok(!fs.existsSync(p.lockPath(output)));
    }
  });
  await check("actual fallback inputs and object shapes", async () => {
    const home = homeDir("fallback");
    const analyzed = path.join(home, "output/daily-analyzed.json"); const vision = path.join(home, "output/daily-vision.json");
    const visual = path.join(home, "output/daily-visual.json"); const ai = path.join(home, "output/daily-ai.json");
    bound(analyzed, [], T1); bound(vision, [], T2);
    // Vision degraded: actual Visual Value input is analyzed, not stale vision.
    await stageMain("visual_value_ai.js", home, ["--apply", "--input", analyzed, "--output", visual])();
    assert.strictEqual(receipt(visual).collectionCompletedAt, T1);
    // Visual Value degraded: AI Analyze uses actual Vision or analyzed fallback.
    for (const input of [vision, analyzed]) {
      await stageMain("analyze_ai.js", home, ["--input", input, "--output", ai])();
      assert.strictEqual(receipt(ai).collectionCompletedAt, receipt(input).collectionCompletedAt);
    }
    bound(analyzed, { posts: [], itemCount: 0, marker: "preserved" });
    await stageMain("vision_ai.js", home, ["--apply", "--input", analyzed, "--output", vision])();
    assert.strictEqual(JSON.parse(fs.readFileSync(vision)).marker, "preserved");
    await stageMain("visual_value_ai.js", home, ["--apply", "--input", vision, "--output", visual])();
    assert.strictEqual(JSON.parse(fs.readFileSync(visual)).marker, "preserved");
    assert.strictEqual(receipt(visual).collectionCompletedAt, T1);
  });
  await check("actual AI intermediate writes cannot receive final receipts on failure", async () => {
    for (const script of ["analyze_ai.js", "enrich_ai.js"]) {
      const home = homeDir(`partial-${script}`); const input = path.join(home, "input.json"); const output = path.join(home, "output/result.json");
      bound(input, [{ url: "https://x.com/test/status/1", text: "test", analysis: { category: "その他", confidence: "low" } }]);
      bound(output, [], T2);
      let writes = 0;
      const helper = { ...p, withArtifactProvenance(options, work) {
        return p.withArtifactProvenance({ ...options, writeJson(file, data) {
          writes++; if (writes === 2) throw new Error("final output fault");
          writeJsonAtomicOrThrow(file, data);
        } }, work);
      } };
      await assert.rejects(() => stageMain(script, home, ["--input", input, "--output", output], { "./lib/collection-provenance": helper })(), /final output fault/);
      assert.strictEqual(writes, 2, script); assert.strictEqual(receipt(output), null);
      assert.ok(!fs.existsSync(p.lockPath(output)));
      // Same real branch with individual (fake) AI errors but successful stage.
      await stageMain(script, home, ["--input", input, "--output", output])();
      assert.strictEqual(receipt(output).collectionCompletedAt, T1);
    }
  });

  await check("actual mixed AI success/failure stays collection-bound", async () => {
    for (const script of ["analyze_ai.js", "enrich_ai.js"]) {
      const home = homeDir(`mixed-${script}`); const input = path.join(home, "input.json"); const output = path.join(home, "output/result.json");
      bound(input, [1, 2].map(id => ({ url: `https://x.com/test/status/${id}`, text: `fixture ${id}`, analysis: { category: "その他", confidence: "low" } })));
      let calls = 0;
      class FakeOpenAI {
        constructor() {
          this.responses = { create: async () => {
            if (++calls === 2) throw new Error("fake second item failure");
            return { output_text: JSON.stringify(script === "analyze_ai.js"
              ? { category: "AI", confidence: 0.8, reason: "fixture", tags: [] }
              : { informationValue: 3, personalRelevance: 3, impact: 3, attentionSignal: 3, summary: "テスト用の要約です", reason: "fixture", tags: [] }) };
          } };
        }
      }
      await stageMain(script, home, ["--input", input, "--output", output], { openai: FakeOpenAI })();
      assert.strictEqual(calls, 2);
      const data = JSON.parse(fs.readFileSync(output));
      const key = script === "analyze_ai.js" ? "finalAnalysis" : "enrichment";
      assert.strictEqual(data[0][key].source, "ai");
      assert.strictEqual(data[1][key].source, "pending");
      assert.strictEqual(receipt(output).collectionCompletedAt, T1);
    }
  });
  console.log(`collection-provenance-test: ${count}/${count} PASS`);
}
if (collectFixture) {
  const mode = process.argv[4];
  const helper = { ...p, createArtifactWriter(file, options) {
    return p.createArtifactWriter(file, { ...options, now: () => T2,
      ...(mode === "scope-failure" ? { writeJson() { throw new Error("scope persistence fault"); } } : {}),
      ...(mode === "receipt-failure" ? { writeReceipt() { throw new Error("receipt fault"); } } : {}),
    });
  } };
  stageMain("connect.js", root, ["--once"], {
    collectFixture: true,
    collectPosts: mode === "normal" ? [{ url: "https://x.com/test/status/1", text: "fixture", postedAt: T1 }] : [],
    "./lib/collection-provenance": helper,
    "./lib/collect-home-refresh": { ...require("../lib/collect-home-refresh"),
      refreshHomeThenCheckLogin: async () => ({ homeRefresh: null, session: { authenticated: true } }),
    },
    console: { log(line) {
      if (mode === "completion-work-failure" && String(line).startsWith("Daily editorial scope:")) throw new Error("mandatory completion fault");
    }, error() {}, warn() {} },
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  main().then(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
}
