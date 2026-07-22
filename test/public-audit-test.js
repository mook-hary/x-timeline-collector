/**
 * EP-018 — Public audit + site validation tests.
 * Run: node test/public-audit-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  auditTrackedPublicTree,
  validateSiteDirectory,
  formatFindings,
} = require("../lib/public-audit");
const { writeDemoSite, buildSite } = require("../lib/site-builder");
const { DASHBOARD_CSS } = require("../lib/personal-dashboard-css");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

// --- Case 1: demo site validates ---
{
  const root = tmpDir("pub-demo-");
  const siteRoot = path.join(root, "site");
  writeDemoSite({ siteRoot });
  const result = validateSiteDirectory(siteRoot);
  assert.strictEqual(result.findings.length, 0, formatFindings(result.findings).join("\n"));
  assert.ok(result.ok);
  assert.ok(fs.existsSync(path.join(siteRoot, "index.html")));
  assert.ok(fs.existsSync(path.join(siteRoot, "manifest.webmanifest")));
  console.log("Case1 PASS");
}

// --- Case 2: site validation catches /Users/ and timeline dump files ---
{
  const root = tmpDir("pub-bad-");
  const siteRoot = path.join(root, "site");
  writeDemoSite({ siteRoot });
  write(
    path.join(siteRoot, "leak.html"),
    `<!DOCTYPE html><html><body>/Users/someone/secret</body></html>\n`
  );
  write(path.join(siteRoot, "timeline.json"), "[]\n");
  const result = validateSiteDirectory(siteRoot);
  const rules = new Set(result.findings.map((f) => f.rule));
  assert.ok(rules.has("users-absolute-path"));
  assert.ok(rules.has("site-raw-timeline-file"));
  assert.strictEqual(result.ok, false);
  console.log("Case2 PASS");
}

// --- Case 3: site validation catches private path refs ---
{
  const root = tmpDir("pub-ref-");
  const siteRoot = path.join(root, "site");
  writeDemoSite({ siteRoot });
  write(
    path.join(siteRoot, "bad.html"),
    `<!DOCTYPE html><html><body>see output/timeline.json</body></html>\n`
  );
  const result = validateSiteDirectory(siteRoot);
  const rules = new Set(result.findings.map((f) => f.rule));
  assert.ok(rules.has("site-private-path-ref") || rules.has("raw-timeline-filename-reference"));
  assert.strictEqual(result.ok, false);
  console.log("Case3 PASS");
}

// --- Case 4: buildSite still writes to site/ from output/ ---
{
  const root = tmpDir("pub-build-");
  const outputRoot = path.join(root, "output");
  const siteRoot = path.join(root, "site");
  write(
    path.join(outputRoot, "index.html"),
    `<!DOCTYPE html><html><head><title>Local</title>
<link rel="stylesheet" href="dashboard.css"></head>
<body><a href="edition/index.html">edition</a></body></html>\n`
  );
  write(path.join(outputRoot, "dashboard.css"), `${DASHBOARD_CSS}\n`);
  write(
    path.join(outputRoot, "edition", "index.html"),
    `<!DOCTYPE html><html><body>edition</body></html>\n`
  );
  write(path.join(outputRoot, "edition", "edition.css"), "body{}\n");
  write(path.join(outputRoot, "archive", ".keep"), "");
  const built = buildSite({ outputRoot, siteRoot });
  assert.ok(fs.existsSync(path.join(built.siteRoot, "index.html")));
  assert.ok(fs.existsSync(path.join(built.siteRoot, "manifest.webmanifest")));
  console.log("Case4 PASS");
}

// --- Case 5: formatFindings keeps redaction markers ---
{
  const lines = formatFindings([
    {
      severity: "critical",
      rule: "openai-project-key",
      path: "x.env",
      line: 1,
      detail: "OPENAI_API_KEY=[REDACTED]",
    },
  ]);
  assert.ok(lines[0].includes("openai-project-key"));
  assert.ok(lines[0].includes("[REDACTED]"));
  console.log("Case5 PASS");
}

// Smoke: audit helper is callable (uses git ls-files in real repo only)
assert.strictEqual(typeof auditTrackedPublicTree, "function");
console.log("public-audit-test: ALL PASS");
