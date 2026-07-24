/**
 * EP-041 — Reader watch mode helpers.
 * Run: node test/reader-watch-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  WATCH_DEBOUNCE_MS,
  resolveWatchTargets,
  shouldIgnoreWatchPath,
  createWatchScheduler,
} = require("../lib/reader-watch");
const { READER_DIR_REL, ENRICHED_REL } = require("../lib/reader-launch");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- constants / ignore ---
{
  assert.ok(WATCH_DEBOUNCE_MS >= 100 && WATCH_DEBOUNCE_MS <= 300);
  const root = tmpDir("reader-watch-ignore-");
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, READER_DIR_REL), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });

  assert.strictEqual(
    shouldIgnoreWatchPath(root, path.join(root, READER_DIR_REL, "index.html")),
    true
  );
  assert.strictEqual(
    shouldIgnoreWatchPath(root, path.join(root, "node_modules", "x", "a.js")),
    true
  );
  assert.strictEqual(
    shouldIgnoreWatchPath(root, path.join(root, "lib", "today-brief.js")),
    false
  );
  assert.strictEqual(
    shouldIgnoreWatchPath(root, path.join(root, ".git", "config")),
    true
  );
  console.log("EP041 ignore PASS");
}

// --- resolve targets from existing layout ---
{
  const root = tmpDir("reader-watch-targets-");
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  fs.writeFileSync(path.join(root, ENRICHED_REL), "[]", "utf8");
  // templates/ missing — skipped
  const targets = resolveWatchTargets(root);
  const rels = targets.map((t) => t.relative.replace(/\\/g, "/"));
  assert.ok(rels.includes("lib"));
  assert.ok(rels.includes("scripts"));
  assert.ok(rels.includes(ENRICHED_REL.replace(/\\/g, "/")));
  assert.ok(!rels.includes("templates"));
  const files = require("../lib/reader-watch").listWatchFiles(root);
  assert.ok(files.some((f) => f.endsWith(ENRICHED_REL.replace(/\\/g, path.sep)) || f.includes("timeline_enriched")));
  console.log("EP041 targets PASS");
}

// --- debounce collapses bursts (one save → one regenerate) ---
(async () => {
  assert.strictEqual(
    createWatchScheduler({
      generate: () => ({ status: 0 }),
    }).delayMs,
    WATCH_DEBOUNCE_MS
  );
  // Short delayMs ignored unless allowTestDelay
  assert.strictEqual(
    createWatchScheduler({
      delayMs: 10,
      generate: () => ({ status: 0 }),
    }).delayMs,
    WATCH_DEBOUNCE_MS
  );

  let calls = 0;
  const events = [];
  const scheduler = createWatchScheduler({
    allowTestDelay: true,
    delayMs: 50,
    generate: () => {
      calls += 1;
      return { status: 0 };
    },
    onChange: (paths) => events.push([...paths]),
  });

  // Simulate fs.watch multi-fire for one save
  for (let i = 0; i < 15; i++) {
    scheduler.schedule("lib/a.js");
  }
  scheduler.schedule(["lib/a.js", "lib/b.js"]);
  await sleep(120);
  assert.strictEqual(calls, 1);
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0].sort(), ["lib/a.js", "lib/b.js"]);

  // Quiet period: no extra regenerate
  await sleep(100);
  assert.strictEqual(calls, 1);

  let fails = 0;
  const failing = createWatchScheduler({
    allowTestDelay: true,
    delayMs: 30,
    generate: () => ({ status: 1 }),
    onFail: () => {
      fails += 1;
    },
  });
  failing.schedule("lib/x.js");
  await sleep(80);
  assert.strictEqual(fails, 1);
  failing.schedule("lib/y.js");
  await sleep(80);
  assert.strictEqual(fails, 2);

  let overlapCalls = 0;
  let afterGenerate = 0;
  const overlap = createWatchScheduler({
    allowTestDelay: true,
    delayMs: 20,
    generate: () => {
      overlapCalls += 1;
      if (overlapCalls === 1) {
        overlap.schedule("lib/during.js");
      }
      return { status: 0 };
    },
    onAfterGenerate: () => {
      afterGenerate += 1;
    },
  });
  overlap.schedule("lib/first.js");
  await sleep(120);
  assert.strictEqual(overlapCalls, 2);
  assert.strictEqual(afterGenerate, 2);

  failing.stop();
  scheduler.stop();
  overlap.stop();

  console.log("EP041 debounce PASS");
  console.log("reader-watch-test: all PASS");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
