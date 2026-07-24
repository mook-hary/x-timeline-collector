/**
 * EP-052 — Editorial Rules Engine.
 * Run: node test/editorial-rules-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createRule,
  evaluateRule,
  evaluateRules,
  getDefaultRules,
} = require("../lib/editorial-rules");
const { createEditorialStore } = require("../lib/editorial-store");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function longBody(n = 120) {
  return "あ".repeat(n);
}

// --- createRule validation ---
{
  const rule = createRule({
    id: "x",
    description: "desc",
    severity: "info",
    check: () => ({ passed: true }),
  });
  assert.strictEqual(rule.id, "x");
  assert.throws(
    () =>
      createRule({
        id: "x",
        description: "d",
        severity: "critical",
        check: () => ({ passed: true }),
      }),
    /severity/
  );
  assert.throws(
    () => createRule({ description: "d", severity: "error", check: () => ({}) }),
    /id/
  );
  console.log("EP052 createRule PASS");
}

// --- skip enabled / source / type ---
{
  const item = {
    id: "1",
    source: "news",
    type: "article",
    title: "t",
    body: "b",
  };
  const disabled = createRule({
    id: "off",
    description: "off",
    severity: "error",
    enabled: false,
    check: () => ({ passed: false, message: "should not run" }),
  });
  assert.strictEqual(evaluateRule(disabled, item).status, "skipped");

  const sourceOnly = createRule({
    id: "src",
    description: "aikido only",
    severity: "error",
    sources: ["aikido"],
    check: () => ({ passed: false, message: "fail" }),
  });
  assert.strictEqual(evaluateRule(sourceOnly, item).status, "skipped");

  const typeOnly = createRule({
    id: "typ",
    description: "post only",
    severity: "error",
    types: ["post"],
    check: () => ({ passed: false, message: "fail" }),
  });
  assert.strictEqual(evaluateRule(typeOnly, item).status, "skipped");
  console.log("EP052 skip PASS");
}

// --- passed aggregation ---
{
  const warnFail = createRule({
    id: "w",
    description: "warn",
    severity: "warning",
    check: () => ({ passed: false, message: "warn fail" }),
  });
  const errFail = createRule({
    id: "e",
    description: "err",
    severity: "error",
    check: () => ({ passed: false, message: "err fail" }),
  });
  const ok = createRule({
    id: "ok",
    description: "ok",
    severity: "error",
    check: () => ({ passed: true }),
  });

  const warnOnly = evaluateRules({ title: "t" }, [warnFail, ok]);
  assert.strictEqual(warnOnly.passed, true);
  assert.strictEqual(warnOnly.counts.warning, 1);
  assert.strictEqual(warnOnly.counts.error, 0);

  const withError = evaluateRules({ title: "t" }, [warnFail, errFail]);
  assert.strictEqual(withError.passed, false);
  assert.strictEqual(withError.counts.error, 1);
  console.log("EP052 passed-aggregation PASS");
}

// --- default rules ---
{
  const rules = getDefaultRules();
  const ids = rules.map((r) => r.id);
  assert.ok(ids.includes("title-required"));
  assert.ok(ids.includes("publishable-status"));

  const empty = evaluateRules(
    { source: "news", type: "article", title: "", summary: "", body: "", tags: [] },
    rules
  );
  assert.strictEqual(empty.passed, false);
  const byId = Object.fromEntries(empty.results.map((r) => [r.ruleId, r]));
  assert.strictEqual(byId["title-required"].status, "failed");
  assert.strictEqual(byId["body-or-summary-required"].status, "failed");
  assert.strictEqual(byId["short-content"].status, "failed");
  assert.strictEqual(byId["tags-recommended"].status, "failed");
  assert.strictEqual(byId["high-similarity"].status, "skipped");
  assert.strictEqual(byId["publishable-status"].status, "skipped");

  const good = evaluateRules(
    {
      source: "news",
      type: "article",
      title: "タイトル",
      body: longBody(120),
      tags: ["news"],
      status: "draft",
    },
    rules,
    { maxSimilarity: 0.2 }
  );
  assert.strictEqual(good.passed, true);
  assert.strictEqual(
    good.results.find((r) => r.ruleId === "high-similarity").status,
    "passed"
  );

  const highSim = evaluateRules(
    {
      source: "news",
      type: "article",
      title: "タイトル",
      body: longBody(120),
      tags: ["news"],
    },
    rules,
    { maxSimilarity: 0.91 }
  );
  assert.strictEqual(highSim.passed, true); // warning only
  assert.strictEqual(
    highSim.results.find((r) => r.ruleId === "high-similarity").status,
    "failed"
  );

  const publishDraft = evaluateRules(
    {
      source: "news",
      type: "article",
      title: "t",
      body: longBody(120),
      tags: ["a"],
      status: "draft",
    },
    rules,
    { operation: "publish" }
  );
  assert.strictEqual(publishDraft.passed, false);
  assert.strictEqual(
    publishDraft.results.find((r) => r.ruleId === "publishable-status").status,
    "failed"
  );

  const publishOk = evaluateRules(
    {
      source: "news",
      type: "article",
      title: "t",
      body: longBody(120),
      tags: ["a"],
      status: "approved",
    },
    rules,
    { operation: "publish" }
  );
  assert.strictEqual(
    publishOk.results.find((r) => r.ruleId === "publishable-status").status,
    "passed"
  );
  console.log("EP052 default-rules PASS");
}

// --- rule exception ---
{
  const boom = createRule({
    id: "boom",
    description: "throws",
    severity: "error",
    check() {
      throw new Error("kaboom");
    },
  });
  const other = createRule({
    id: "other",
    description: "ok",
    severity: "info",
    check: () => ({ passed: true }),
  });
  const report = evaluateRules({ title: "t" }, [boom, other]);
  assert.strictEqual(report.passed, false);
  assert.strictEqual(report.results[0].status, "failed");
  assert.ok(/kaboom/.test(report.results[0].message));
  assert.strictEqual(report.results[0].severity, "error");
  assert.strictEqual(report.results[1].status, "passed");
  console.log("EP052 exception PASS");
}

// --- store evaluate / evaluateItem ---
{
  const store = createEditorialStore({ rootDir: tmpDir("editorial-rules-") });
  store.create({
    id: "a1",
    source: "news",
    type: "article",
    title: "GitHub Pages 公開",
    body: longBody(120),
    tags: ["pages"],
  });
  store.create({
    id: "a2",
    source: "news",
    type: "article",
    title: "GitHub Pages公開",
    body: longBody(120),
    tags: ["pages"],
  });

  assert.throws(() => store.evaluate("missing"), /not found/);

  const report = store.evaluate("a1");
  assert.ok(typeof report.passed === "boolean");
  assert.ok(report.results.some((r) => r.ruleId === "title-required"));

  const withSim = store.evaluate("a1", {
    includeSimilarity: true,
    similarityOptions: { threshold: 0 },
  });
  assert.ok(Array.isArray(withSim.similarItems));
  assert.ok(!withSim.similarItems.some((s) => s.item.id === "a1"));
  assert.ok(typeof withSim.context.maxSimilarity === "number");
  assert.ok(
    withSim.results.find((r) => r.ruleId === "high-similarity").status !==
      "skipped"
  );

  // workflow still works
  store.transition("a1", "review");
  assert.strictEqual(store.find("a1").status, "review");
  console.log("EP052 store-evaluate PASS");
}

console.log("editorial-rules-test: all PASS");
