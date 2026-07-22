/**
 * EP-014 — Assemble GitHub Pages site/ from finalized output/.
 * Copies Dashboard / Edition / Archive. Adds PWA manifest + icons.
 * Does not regenerate articles. Deterministic. No external CDN.
 */

const fs = require("fs");
const path = require("path");
const {
  generateSiteIcons,
  THEME_COLOR,
  BACKGROUND_COLOR,
} = require("./site-icons");
const { writeJsonAtomic } = require("./pipeline-io");

const MANIFEST_NAME = "manifest.webmanifest";

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return false;
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (entry.isFile()) {
      copyFile(from, to);
    }
  }
  return true;
}

function buildWebManifest() {
  return {
    name: "Personal Timeline",
    short_name: "Timeline",
    description: "Your X timeline, edited for today.",
    lang: "ja",
    start_url: "./index.html",
    scope: "./",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      {
        src: "icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

const PWA_HEAD_SNIPPET = `  <meta name="theme-color" content="${THEME_COLOR}">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Timeline">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="apple-touch-icon.png">`;

/**
 * Ensure Dashboard HTML has PWA / icon / theme-color tags.
 * Relative paths only. Idempotent.
 */
function ensurePwaHeadTags(html) {
  let out = String(html || "");
  if (!/name="viewport"/i.test(out)) {
    out = out.replace(
      /<head([^>]*)>/i,
      `<head$1>\n  <meta name="viewport" content="width=device-width, initial-scale=1">`
    );
  }
  if (!/rel=["']manifest["']/i.test(out)) {
    if (/<\/head>/i.test(out)) {
      out = out.replace(/<\/head>/i, `${PWA_HEAD_SNIPPET}\n</head>`);
    } else {
      out = `${PWA_HEAD_SNIPPET}\n${out}`;
    }
  } else {
    // Still ensure theme-color / apple icon if missing
    if (!/name=["']theme-color["']/i.test(out)) {
      out = out.replace(
        /<head([^>]*)>/i,
        `<head$1>\n  <meta name="theme-color" content="${THEME_COLOR}">`
      );
    }
    if (!/rel=["']apple-touch-icon["']/i.test(out)) {
      out = out.replace(
        /<\/head>/i,
        `  <link rel="apple-touch-icon" href="apple-touch-icon.png">\n</head>`
      );
    }
    if (!/rel=["']icon["']/i.test(out)) {
      out = out.replace(
        /<\/head>/i,
        `  <link rel="icon" href="favicon.ico" sizes="any">\n</head>`
      );
    }
  }
  return out;
}

/**
 * For nested pages (edition/, archive/id/), point icons/manifest up one or two levels.
 */
function ensureNestedHeadTags(html, depth) {
  const prefix = "../".repeat(depth);
  let out = String(html || "");
  if (!/name=["']theme-color["']/i.test(out)) {
    out = out.replace(
      /<head([^>]*)>/i,
      `<head$1>\n  <meta name="theme-color" content="${THEME_COLOR}">`
    );
  }
  if (!/rel=["']icon["']/i.test(out)) {
    out = out.replace(
      /<\/head>/i,
      `  <link rel="icon" href="${prefix}favicon.ico" sizes="any">\n</head>`
    );
  }
  return out;
}

function patchHtmlFiles(siteRoot) {
  const indexPath = path.join(siteRoot, "index.html");
  if (fs.existsSync(indexPath)) {
    const html = ensurePwaHeadTags(fs.readFileSync(indexPath, "utf8"));
    fs.writeFileSync(indexPath, html, "utf8");
  }

  const editionIndex = path.join(siteRoot, "edition", "index.html");
  if (fs.existsSync(editionIndex)) {
    const html = ensureNestedHeadTags(
      fs.readFileSync(editionIndex, "utf8"),
      1
    );
    fs.writeFileSync(editionIndex, html, "utf8");
  }

  const archiveRoot = path.join(siteRoot, "archive");
  if (fs.existsSync(archiveRoot)) {
    for (const name of fs.readdirSync(archiveRoot)) {
      if (name.startsWith(".")) continue;
      const htmlPath = path.join(archiveRoot, name, "index.html");
      if (!fs.existsSync(htmlPath)) continue;
      const html = ensureNestedHeadTags(
        fs.readFileSync(htmlPath, "utf8"),
        2
      );
      fs.writeFileSync(htmlPath, html, "utf8");
    }
  }
}

function assertRelativeLinks(siteRoot, warnings) {
  const indexPath = path.join(siteRoot, "index.html");
  if (!fs.existsSync(indexPath)) return;
  const html = fs.readFileSync(indexPath, "utf8");
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    if (/^(https?:|mailto:|data:|#)/i.test(href)) continue;
    if (/^javascript:/i.test(href)) {
      warnings.push({ code: "javascript-href", href });
      continue;
    }
    if (path.isAbsolute(href) || href.startsWith("/")) {
      warnings.push({ code: "absolute-href", href });
      continue;
    }
    if (href.split("/").includes("..") && !href.startsWith("../")) {
      // allow only intentional nested prefixes we don't use on dashboard
    }
    const target = path.resolve(siteRoot, href.split("#")[0]);
    const rel = path.relative(siteRoot, target);
    if (rel.startsWith("..")) {
      warnings.push({ code: "href-outside-site", href });
    }
  }
}

/**
 * Build site/ for GitHub Pages.
 *
 * @param {object} options
 * @param {string} options.outputRoot - source (default: <cwd>/output)
 * @param {string} options.siteRoot - destination (default: <cwd>/site)
 */
function buildSite({
  outputRoot = null,
  siteRoot = null,
  rootDir = null,
} = {}) {
  const base = rootDir ? path.resolve(rootDir) : process.cwd();
  const outRoot = outputRoot
    ? path.resolve(outputRoot)
    : path.join(base, "output");
  const finalSite = siteRoot
    ? path.resolve(siteRoot)
    : path.join(base, "site");

  const warnings = [];

  if (!fs.existsSync(path.join(outRoot, "index.html"))) {
    const err = new Error(
      `Dashboard が見つかりません: ${path.join(outRoot, "index.html")}`
    );
    err.code = "dashboard-missing";
    throw err;
  }

  const parent = path.dirname(finalSite);
  ensureDir(parent);
  const tmpSite = path.join(
    parent,
    `.site-tmp-${process.pid}-${Date.now()}`
  );
  rmrf(tmpSite);
  ensureDir(tmpSite);

  try {
    // Dashboard
    copyFile(
      path.join(outRoot, "index.html"),
      path.join(tmpSite, "index.html")
    );
    const cssSrc = path.join(outRoot, "dashboard.css");
    if (fs.existsSync(cssSrc)) {
      copyFile(cssSrc, path.join(tmpSite, "dashboard.css"));
    } else {
      warnings.push({ code: "dashboard-css-missing" });
    }

    // Edition + Archive
    const editionSrc = path.join(outRoot, "edition");
    if (!copyDirRecursive(editionSrc, path.join(tmpSite, "edition"))) {
      warnings.push({ code: "edition-missing" });
    }
    const archiveSrc = path.join(outRoot, "archive");
    if (!copyDirRecursive(archiveSrc, path.join(tmpSite, "archive"))) {
      warnings.push({ code: "archive-missing" });
      ensureDir(path.join(tmpSite, "archive"));
    }

    // Icons
    const icons = generateSiteIcons();
    for (const [name, buf] of Object.entries(icons)) {
      fs.writeFileSync(path.join(tmpSite, name), buf);
    }

    // Manifest
    const manifest = buildWebManifest();
    writeJsonAtomic(path.join(tmpSite, MANIFEST_NAME), manifest);

    // PWA head tags
    patchHtmlFiles(tmpSite);
    assertRelativeLinks(tmpSite, warnings);

    // Required files check
    for (const req of [
      "index.html",
      "dashboard.css",
      MANIFEST_NAME,
      "favicon.ico",
      "icon-192.png",
      "icon-512.png",
      "apple-touch-icon.png",
    ]) {
      if (!fs.existsSync(path.join(tmpSite, req))) {
        const err = new Error(`site 必須ファイルが欠けています: ${req}`);
        err.code = "site-incomplete";
        throw err;
      }
    }

    rmrf(finalSite);
    fs.renameSync(tmpSite, finalSite);

    const summary = {
      hasEdition: fs.existsSync(path.join(finalSite, "edition", "index.html")),
      hasArchive: fs.existsSync(path.join(finalSite, "archive")),
      archiveCount: fs.existsSync(path.join(finalSite, "archive"))
        ? fs
            .readdirSync(path.join(finalSite, "archive"))
            .filter((n) => !n.startsWith(".")).length
        : 0,
      warningsCount: warnings.length,
    };

    return {
      siteRoot: finalSite,
      manifestPath: path.join(finalSite, MANIFEST_NAME),
      manifest,
      warnings,
      summary,
    };
  } catch (error) {
    try {
      rmrf(tmpSite);
    } catch (_e) {
      // best-effort
    }
    throw error;
  }
}

module.exports = {
  buildSite,
  buildWebManifest,
  ensurePwaHeadTags,
  ensureNestedHeadTags,
  MANIFEST_NAME,
  THEME_COLOR,
  BACKGROUND_COLOR,
};
