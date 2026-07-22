/**
 * EP-014 — Site Builder / PWA / Pages tests.
 * Run: node test/site-builder-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildSite, buildWebManifest, THEME_COLOR } = require("../lib/site-builder");
const { generateSiteIcons, createPngIcon } = require("../lib/site-icons");
const { DASHBOARD_CSS } = require("../lib/personal-dashboard-css");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function seedOutput(root) {
  const outputRoot = path.join(root, "output");
  const siteRoot = path.join(root, "site");
  write(
    path.join(outputRoot, "index.html"),
    `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Personal Timeline</title>
<link rel="stylesheet" href="dashboard.css">
</head><body>
<a href="edition/index.html">今日の号を読む</a>
<a href="archive/2026-07-22/index.html">号を読む</a>
</body></html>\n`
  );
  write(path.join(outputRoot, "dashboard.css"), `${DASHBOARD_CSS}\n`);
  write(
    path.join(outputRoot, "edition", "index.html"),
    `<!DOCTYPE html><html><head><title>Edition</title></head>
<body><a href="../index.html">back</a>
<article id="story-a">hello</article>
</body></html>\n`
  );
  write(path.join(outputRoot, "edition", "edition.css"), "body{}\n");
  write(
    path.join(outputRoot, "archive", "2026-07-22", "index.html"),
    `<!DOCTYPE html><html><head><title>Archive</title></head>
<body><a href="articles/01-a.md">article</a></body></html>\n`
  );
  write(
    path.join(outputRoot, "archive", "2026-07-22", "articles", "01-a.md"),
    "# A\n\nbody\n"
  );
  write(
    path.join(
      outputRoot,
      "archive",
      "2026-07-22",
      "archive-manifest.json"
    ),
    `${JSON.stringify(
      {
        version: "1.0",
        editionId: "2026-07-22",
        editionDate: "2026-07-22",
        summary: { articleCount: 1, warningsCount: 0 },
        files: { html: "index.html" },
      },
      null,
      2
    )}\n`
  );
  return { outputRoot, siteRoot };
}

// --- Case 1: site generated ---
{
  const root = tmpDir("site-c1-");
  const { outputRoot, siteRoot } = seedOutput(root);
  const result = buildSite({ outputRoot, siteRoot });
  assert.ok(fs.existsSync(path.join(result.siteRoot, "index.html")));
  assert.ok(fs.existsSync(path.join(result.siteRoot, "dashboard.css")));
  assert.ok(fs.existsSync(path.join(result.siteRoot, "edition", "index.html")));
  assert.ok(
    fs.existsSync(path.join(result.siteRoot, "archive", "2026-07-22", "index.html"))
  );
  console.log("Case1 PASS");
}

// --- Case 2: Dashboard content ---
{
  const root = tmpDir("site-c2-");
  const { outputRoot, siteRoot } = seedOutput(root);
  buildSite({ outputRoot, siteRoot });
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  assert.ok(html.includes("Personal Timeline") || html.includes("今日の号を読む"));
  assert.ok(html.includes('href="dashboard.css"'));
  console.log("Case2 PASS");
}

// --- Case 3: Edition link ---
{
  const root = tmpDir("site-c3-");
  const { outputRoot, siteRoot } = seedOutput(root);
  buildSite({ outputRoot, siteRoot });
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  assert.ok(html.includes('href="edition/index.html"'));
  assert.ok(fs.existsSync(path.join(siteRoot, "edition", "index.html")));
  console.log("Case3 PASS");
}

// --- Case 4: Archive link ---
{
  const root = tmpDir("site-c4-");
  const { outputRoot, siteRoot } = seedOutput(root);
  buildSite({ outputRoot, siteRoot });
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  assert.ok(html.includes('href="archive/2026-07-22/index.html"'));
  assert.ok(
    fs.existsSync(
      path.join(siteRoot, "archive", "2026-07-22", "articles", "01-a.md")
    )
  );
  console.log("Case4 PASS");
}

// --- Case 5: Manifest exists ---
{
  const root = tmpDir("site-c5-");
  const { outputRoot, siteRoot } = seedOutput(root);
  buildSite({ outputRoot, siteRoot });
  assert.ok(fs.existsSync(path.join(siteRoot, "manifest.webmanifest")));
  console.log("Case5 PASS");
}

// --- Case 6: Icons exist ---
{
  const root = tmpDir("site-c6-");
  const { outputRoot, siteRoot } = seedOutput(root);
  buildSite({ outputRoot, siteRoot });
  for (const name of [
    "favicon.ico",
    "icon-192.png",
    "icon-512.png",
    "apple-touch-icon.png",
  ]) {
    assert.ok(fs.existsSync(path.join(siteRoot, name)), name);
    assert.ok(fs.statSync(path.join(siteRoot, name)).size > 20);
  }
  const png = createPngIcon(32);
  assert.strictEqual(png[0], 137);
  assert.strictEqual(png[1], 80);
  console.log("Case6 PASS");
}

// --- Case 7: Relative links (no absolute site paths) ---
{
  const root = tmpDir("site-c7-");
  const { outputRoot, siteRoot } = seedOutput(root);
  const result = buildSite({ outputRoot, siteRoot });
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    if (/^(https?:|mailto:|#)/i.test(href)) continue;
    assert.ok(!href.startsWith("/"), href);
    assert.ok(!path.isAbsolute(href), href);
  }
  assert.ok(!result.warnings.some((w) => w.code === "absolute-href"));
  console.log("Case7 PASS");
}

// --- Case 8: Mobile CSS present ---
{
  assert.ok(DASHBOARD_CSS.includes("@media (max-width"));
  assert.ok(DASHBOARD_CSS.includes("overflow-x: hidden"));
  const root = tmpDir("site-c8-");
  const { outputRoot, siteRoot } = seedOutput(root);
  buildSite({ outputRoot, siteRoot });
  const css = fs.readFileSync(path.join(siteRoot, "dashboard.css"), "utf8");
  assert.ok(css.includes("@media (max-width"));
  console.log("Case8 PASS");
}

// --- Case 9: PWA manifest fields ---
{
  const manifest = buildWebManifest();
  assert.strictEqual(manifest.name, "Personal Timeline");
  assert.strictEqual(manifest.short_name, "Timeline");
  assert.strictEqual(manifest.display, "standalone");
  assert.ok(manifest.start_url);
  assert.strictEqual(manifest.theme_color, THEME_COLOR);
  assert.ok(manifest.icons.length >= 2);

  const root = tmpDir("site-c9-");
  const { outputRoot, siteRoot } = seedOutput(root);
  buildSite({ outputRoot, siteRoot });
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  assert.ok(html.includes('rel="manifest"'));
  assert.ok(html.includes('name="theme-color"'));
  assert.ok(html.includes('rel="apple-touch-icon"'));
  assert.ok(html.includes("apple-mobile-web-app-capable"));
  assert.ok(!html.includes("fonts.googleapis.com"));
  assert.ok(!html.includes("<script"));
  console.log("Case9 PASS");
}

// --- icons deterministic ---
{
  const a = generateSiteIcons();
  const b = generateSiteIcons();
  assert.deepStrictEqual(a["icon-192.png"], b["icon-192.png"]);
  console.log("IconsDeterminism PASS");
}

// --- missing dashboard errors ---
{
  const root = tmpDir("site-miss-");
  let threw = false;
  try {
    buildSite({
      outputRoot: path.join(root, "output"),
      siteRoot: path.join(root, "site"),
    });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.code, "dashboard-missing");
  }
  assert.ok(threw);
  console.log("MissingDashboard PASS");
}

// --- EP-018 demo placeholder site ---
{
  const { writeDemoSite } = require("../lib/site-builder");
  const root = tmpDir("site-demo-");
  const siteRoot = path.join(root, "site");
  const result = writeDemoSite({ siteRoot });
  assert.ok(result.demo);
  assert.ok(fs.existsSync(path.join(siteRoot, "index.html")));
  assert.ok(fs.existsSync(path.join(siteRoot, "edition", "index.html")));
  assert.ok(fs.existsSync(path.join(siteRoot, "manifest.webmanifest")));
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  assert.ok(html.includes("Timeline Demo"));
  assert.ok(!html.includes("/Users/"));
  assert.ok(!html.includes("output/"));
  assert.ok(!html.includes("runs/"));
  assert.ok(!fs.existsSync(path.join(siteRoot, "archive", "2026-07-22")));
  console.log("DemoSite PASS");
}

console.log("All site-builder tests PASS");
