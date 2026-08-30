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
  checkTrackedPathRules,
  scanLineSecrets,
  isSafeApiKeyValue,
  ALLOWED_PUBLIC_OUTPUT_FILES,
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

function findingsForLine(line) {
  const findings = [];
  scanLineSecrets("fixture.js", line, 1, findings);
  return findings;
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

// --- Case 6: Reader public allowlist (exact files only) ---
{
  assert.ok(
    ALLOWED_PUBLIC_OUTPUT_FILES.has("output/digest-reader/index.html")
  );
  assert.ok(
    ALLOWED_PUBLIC_OUTPUT_FILES.has("output/digest-reader/style.css")
  );
  assert.ok(
    ALLOWED_PUBLIC_OUTPUT_FILES.has("output/digest-reader/news-feed.json")
  );
  const findings = [];
  checkTrackedPathRules(
    [
      "output/digest-reader/index.html",
      "output/digest-reader/style.css",
      "output/digest-reader/news-feed.json",
      "output/digest-reader/secret.json",
      "output/timeline.json",
      "output/other/index.html",
    ],
    findings
  );
  const paths = findings
    .filter((f) => f.rule === "tracked-private-tree")
    .map((f) => f.path)
    .sort();
  assert.deepStrictEqual(paths, [
    "output/digest-reader/secret.json",
    "output/other/index.html",
    "output/timeline.json",
  ]);
  assert.ok(
    !findings.some(
      (f) => f.path === "output/digest-reader/index.html"
    )
  );
  assert.ok(
    !findings.some(
      (f) => f.path === "output/digest-reader/style.css"
    )
  );
  assert.ok(
    !findings.some(
      (f) => f.path === "output/digest-reader/news-feed.json"
    )
  );
  console.log("Case6 PASS");
}

// --- Case 7: OpenAI env refs + redaction PASS; live-looking FAIL ---
{
  const passLines = [
    'const key = process.env.OPENAI_API_KEY;',
    'const key = env.OPENAI_API_KEY;',
    '.replace(/OPENAI_API_KEY[=:\\s]+\\S+/gi, "OPENAI_API_KEY=[REDACTED]")',
    "OPENAI_API_KEY=[REDACTED]",
    "OPENAI_API_KEY=",
    "OPENAI_API_KEY=your_openai_api_key_here",
    'throw new Error("OPENAI_API_KEY is required");',
  ];
  for (const line of passLines) {
    const findings = findingsForLine(line);
    assert.ok(
      !findings.some((f) => f.rule === "openai-key-non-placeholder"),
      `expected PASS for: ${line}`
    );
  }

  const failLines = [
    "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789",
    'OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwxyz0123456789"',
    "OPENAI_API_KEY=live-secret-value-not-placeholder",
  ];
  for (const line of failLines) {
    const findings = findingsForLine(line);
    const hit = findings.some(
      (f) =>
        f.rule === "openai-key-non-placeholder" ||
        f.rule === "openai-live-key" ||
        f.rule === "openai-project-key"
    );
    assert.ok(hit, `expected FAIL for: ${line}`);
    for (const f of findings) {
      assert.ok(!/sk-[a-zA-Z0-9]{10,}/.test(f.detail || ""), f.detail);
      assert.ok(
        !String(f.detail || "").includes("live-secret-value-not-placeholder"),
        f.detail
      );
    }
  }

  assert.strictEqual(isSafeApiKeyValue("process.env.OPENAI_API_KEY"), true);
  assert.strictEqual(isSafeApiKeyValue("env.OPENAI_API_KEY"), true);
  assert.strictEqual(isSafeApiKeyValue("[REDACTED]\")"), true);
  assert.strictEqual(
    isSafeApiKeyValue("sk-abcdefghijklmnopqrstuvwxyz0123456789"),
    false
  );
  console.log("Case7 PASS");
}

// Smoke: audit helper is callable (uses git ls-files in real repo only)
assert.strictEqual(typeof auditTrackedPublicTree, "function");
console.log("public-audit-test: ALL PASS");
