/**
 * EP-012 — Archive a completed Daily Edition into output/archive/<editionId>/.
 * Copies finalized artifacts only. Does not re-run Writer / Report / HTML / AI.
 * Atomic replace. Deterministic editionId (date). Path-traversal safe.
 */

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./pipeline-io");

const ARCHIVE_MANIFEST_VERSION = "1.0";
const SECTIONS = ["top", "secondary", "brief"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isDateYmd(value) {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Sanitize editionId for use as a single directory name.
 * Only YYYY-MM-DD is accepted (no time suffixes, no path segments).
 */
function sanitizeEditionId(raw) {
  const id = asString(raw);
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) {
    return null;
  }
  if (!isDateYmd(id)) return null;
  return id;
}

/**
 * Resolve editionId / editionDate.
 * Priority: daily-edition.json editionDate/date → options.editionDate → now.
 * Explicit non-empty invalid values are errors (no silent fallback).
 */
function resolveEditionIdentity(editionDoc, options = {}) {
  const explicit = [
    editionDoc?.editionDate,
    editionDoc?.date,
    editionDoc?.edition?.date,
    options.editionDate,
    options.date,
  ];
  for (const c of explicit) {
    const raw = asString(c);
    if (!raw) continue;
    const id = sanitizeEditionId(raw);
    if (!id) {
      const err = new Error(
        `不正な editionId です（YYYY-MM-DD のみ可）: ${raw}`
      );
      err.code = "invalid-edition-id";
      throw err;
    }
    return { editionId: id, editionDate: id };
  }

  const fallback =
    options.now instanceof Date
      ? options.now.toISOString().slice(0, 10)
      : asString(options.now) || new Date().toISOString().slice(0, 10);
  const id = sanitizeEditionId(fallback);
  if (!id) {
    const err = new Error("有効な editionId（YYYY-MM-DD）を決定できません。");
    err.code = "invalid-edition-id";
    throw err;
  }
  return { editionId: id, editionDate: id };
}

function flattenPublishedEntries(editionDoc) {
  const edition = editionDoc?.edition || {};
  const items = [];
  for (const section of SECTIONS) {
    const list = Array.isArray(edition[section]) ? edition[section] : [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      items.push({
        ...entry,
        section: asString(entry.section) || section,
      });
    }
  }
  return items;
}

/**
 * Resolve a relative path under root. Rejects absolute / .. / escapes.
 * Returns absolute path or null.
 */
function resolveSafeUnderRoot(rootDir, relPath) {
  const rel = asString(relPath);
  if (!rel) return null;
  if (path.isAbsolute(rel)) return null;
  if (rel.split(/[/\\]/).includes("..")) return null;
  if (rel.includes("\0")) return null;

  const rootAbs = path.resolve(rootDir);
  const abs = path.resolve(rootAbs, rel);
  const relToRoot = path.relative(rootAbs, abs);
  if (
    !relToRoot ||
    relToRoot.startsWith("..") ||
    path.isAbsolute(relToRoot)
  ) {
    return null;
  }

  // Reject symlink escape when present
  try {
    if (fs.existsSync(abs)) {
      const real = fs.realpathSync(abs);
      const realRoot = fs.realpathSync(rootAbs);
      const relReal = path.relative(realRoot, real);
      if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
        return null;
      }
    }
  } catch (_e) {
    return null;
  }

  return abs;
}

function archiveRelFromEntryPath(relPath, kind) {
  const base = path.basename(asString(relPath));
  if (!base || base === "." || base === "..") return null;
  if (base.includes("..") || base.includes("/") || base.includes("\\")) {
    return null;
  }
  if (kind === "article") return path.posix.join("articles", base);
  if (kind === "report") return path.posix.join("article-reports", base);
  return null;
}

function copyFileSafe(srcAbs, destAbs) {
  ensureDir(path.dirname(destAbs));
  fs.copyFileSync(srcAbs, destAbs);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function rewriteDailyEditionForArchive(editionDoc, pathMap) {
  const cloned = JSON.parse(JSON.stringify(editionDoc));
  for (const section of SECTIONS) {
    const list = Array.isArray(cloned.edition?.[section])
      ? cloned.edition[section]
      : [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const aKey = asString(entry.articlePath);
      const rKey = asString(entry.reportPath);
      if (aKey && pathMap.articles[aKey]) {
        entry.articlePath = pathMap.articles[aKey];
      } else if (aKey) {
        const rewritten = archiveRelFromEntryPath(aKey, "article");
        if (rewritten) entry.articlePath = rewritten;
      }
      if (rKey && pathMap.reports[rKey]) {
        entry.reportPath = pathMap.reports[rKey];
      } else if (rKey) {
        const rewritten = archiveRelFromEntryPath(rKey, "report");
        if (rewritten) entry.reportPath = rewritten;
      }
    }
  }
  if (cloned.legacyPrimaryArticlePath) {
    const key = asString(cloned.legacyPrimaryArticlePath);
    cloned.legacyPrimaryArticlePath =
      pathMap.articles[key] ||
      archiveRelFromEntryPath(key, "article") ||
      null;
  }
  if (cloned.legacyPrimaryReportPath) {
    const key = asString(cloned.legacyPrimaryReportPath);
    cloned.legacyPrimaryReportPath =
      pathMap.reports[key] ||
      archiveRelFromEntryPath(key, "report") ||
      null;
  }
  return cloned;
}

/**
 * Make articlePath / reportPath in HTML clickable archive-relative links.
 * Also normalize css href to edition.css. Strip absolute pipeline-work paths.
 */
function rewriteArchiveHtml(html, pathMap) {
  let out = String(html || "");

  // Ensure CSS is relative
  out = out.replace(
    /href="[^"]*edition\.css"/g,
    'href="edition.css"'
  );

  // Convert plain-text path dd cells into links when we know archive paths
  const allPaths = {
    ...pathMap.articles,
    ...pathMap.reports,
  };
  for (const [original, archived] of Object.entries(allPaths)) {
    if (!original || !archived) continue;
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(
        `(<dt>articlePath</dt>\\s*<dd>)${escaped}(</dd>)`,
        "g"
      ),
      `$1<a href="${archived}">${archived}</a>$2`
    );
    out = out.replace(
      new RegExp(
        `(<dt>reportPath</dt>\\s*<dd>)${escaped}(</dd>)`,
        "g"
      ),
      `$1<a href="${archived}">${archived}</a>$2`
    );
    // Also rewrite already-escaped HTML entities form if any
    const htmlEscaped = original
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (htmlEscaped !== original) {
      out = out.replace(
        new RegExp(
          `(<dt>articlePath</dt>\\s*<dd>)${htmlEscaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(</dd>)`,
          "g"
        ),
        `$1<a href="${archived}">${archived}</a>$2`
      );
    }
  }

  // If paths already equal archive rel, still link them
  out = out.replace(
    /<dt>articlePath<\/dt>\s*<dd>(articles\/[^<]+)<\/dd>/g,
    '<dt>articlePath</dt><dd><a href="$1">$1</a></dd>'
  );
  out = out.replace(
    /<dt>reportPath<\/dt>\s*<dd>(article-reports\/[^<]+)<\/dd>/g,
    '<dt>reportPath</dt><dd><a href="$1">$1</a></dd>'
  );

  // Drop any leftover absolute .pipeline-work references
  out = out.replace(/[A-Za-z]:\\[^\s<]*\.pipeline-work[^\s<]*/g, "");
  out = out.replace(/\/[^\s<]*\.pipeline-work[^\s<]*/g, "");

  return out;
}

function sanitizeWarningPath(relPath) {
  const rel = asString(relPath);
  if (!rel) return null;
  if (path.isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) {
    return "(rejected)";
  }
  return rel;
}

function assertNoAbsolutePaths(obj, label) {
  const walk = (value, keyPath) => {
    if (typeof value === "string") {
      if (path.isAbsolute(value) || /^[A-Za-z]:\\/.test(value)) {
        const err = new Error(
          `Archive Manifest に絶対パスを含められません: ${keyPath}`
        );
        err.code = "absolute-path-forbidden";
        throw err;
      }
      if (value.split(/[/\\]/).includes("..")) {
        const err = new Error(
          `Archive Manifest に '..' を含められません: ${keyPath}`
        );
        err.code = "path-traversal";
        throw err;
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${keyPath}[${i}]`));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        walk(v, keyPath ? `${keyPath}.${k}` : k);
      }
    }
  };
  walk(obj, label || "manifest");
}

/**
 * Build / replace an edition archive.
 *
 * @param {object} options
 * @param {string|object} options.edition - daily-edition.json path or object
 * @param {string} [options.workRoot] - root for source articles/reports
 * @param {string} [options.htmlPath] - latest preview index.html
 * @param {string} [options.cssPath] - latest preview edition.css
 * @param {string} [options.archiveRoot] - default <outputRoot>/archive
 * @param {string} [options.outputRoot] - default cwd/output
 * @param {string} [options.editionDate]
 * @param {Date|string} [options.now] - for createdAt / fallback date
 * @param {string} [options.createdAt] - deterministic createdAt override
 */
function buildEditionArchive({
  edition,
  workRoot = null,
  htmlPath = null,
  cssPath = null,
  archiveRoot = null,
  outputRoot = null,
  editionDate = null,
  now = null,
  createdAt = null,
} = {}) {
  let editionDoc = edition;
  let editionPath = null;

  if (typeof edition === "string") {
    editionPath = path.resolve(edition);
    if (!fs.existsSync(editionPath)) {
      const err = new Error(`daily-edition.json が見つかりません: ${editionPath}`);
      err.code = "edition-not-found";
      throw err;
    }
    try {
      editionDoc = JSON.parse(fs.readFileSync(editionPath, "utf8"));
    } catch (error) {
      const err = new Error(`daily-edition.json が不正です: ${error.message}`);
      err.code = "edition-invalid";
      throw err;
    }
  }

  if (!editionDoc || typeof editionDoc !== "object" || Array.isArray(editionDoc)) {
    const err = new Error("daily-edition.json はオブジェクトである必要があります。");
    err.code = "edition-invalid";
    throw err;
  }

  const identity = resolveEditionIdentity(editionDoc, {
    editionDate,
    now,
  });
  const editionId = identity.editionId;

  const resolvedHtml = htmlPath
    ? path.resolve(htmlPath)
    : path.resolve(
        outputRoot || path.join(process.cwd(), "output"),
        "edition",
        "index.html"
      );
  const resolvedCss = cssPath
    ? path.resolve(cssPath)
    : path.resolve(
        outputRoot || path.join(process.cwd(), "output"),
        "edition",
        "edition.css"
      );

  if (!fs.existsSync(resolvedHtml)) {
    const err = new Error(`Archive 用 HTML が見つかりません: ${resolvedHtml}`);
    err.code = "html-missing";
    throw err;
  }
  if (!fs.existsSync(resolvedCss)) {
    const err = new Error(`Archive 用 CSS が見つかりません: ${resolvedCss}`);
    err.code = "css-missing";
    throw err;
  }

  const work =
    workRoot
      ? path.resolve(workRoot)
      : editionPath
        ? path.dirname(editionPath)
        : process.cwd();

  const outRoot = outputRoot
    ? path.resolve(outputRoot)
    : path.resolve(process.cwd(), "output");
  const archivesDir = archiveRoot
    ? path.resolve(archiveRoot)
    : path.join(outRoot, "archive");

  // Ensure archive root stays under output (when using default layout)
  ensureDir(archivesDir);

  const finalDir = path.join(archivesDir, editionId);
  // Guard: finalDir must be direct child of archivesDir
  if (path.dirname(finalDir) !== path.resolve(archivesDir)) {
    const err = new Error("Archive パスが不正です。");
    err.code = "path-traversal";
    throw err;
  }

  const tmpDir = path.join(
    archivesDir,
    `.tmp-${editionId}-${process.pid}`
  );
  if (tmpDir.includes("..") || path.dirname(tmpDir) !== path.resolve(archivesDir)) {
    const err = new Error("一時 Archive パスが不正です。");
    err.code = "path-traversal";
    throw err;
  }

  // Clean any previous tmp for this pid/edition
  rmrf(tmpDir);
  ensureDir(tmpDir);
  ensureDir(path.join(tmpDir, "articles"));
  ensureDir(path.join(tmpDir, "article-reports"));

  const warnings = [];
  const pathMap = { articles: {}, reports: {} };
  const articleFiles = [];
  const reportFiles = [];
  let missingArticleCount = 0;
  let missingReportCount = 0;

  const entries = flattenPublishedEntries(editionDoc);

  try {
    for (const entry of entries) {
      const storyId = asString(entry.storyId) || null;
      const srcArticleRel = asString(entry.articlePath);
      const srcReportRel = asString(entry.reportPath);

      const archiveArticleRel = archiveRelFromEntryPath(srcArticleRel, "article");
      const archiveReportRel = archiveRelFromEntryPath(srcReportRel, "report");

      if (!archiveArticleRel) {
        missingArticleCount += 1;
        warnings.push({
          code: "unsafe-or-missing-article-path",
          storyId,
          articlePath: sanitizeWarningPath(srcArticleRel),
        });
      } else {
        const srcAbs = resolveSafeUnderRoot(work, srcArticleRel);
        if (!srcAbs || !fs.existsSync(srcAbs)) {
          missingArticleCount += 1;
          warnings.push({
            code: "article-file-not-found",
            storyId,
            articlePath: sanitizeWarningPath(srcArticleRel),
          });
        } else {
          const destAbs = path.join(tmpDir, archiveArticleRel);
          // ensure dest under tmpDir
          if (!resolveSafeUnderRoot(tmpDir, archiveArticleRel)) {
            const err = new Error("Article の Archive 書込先が不正です。");
            err.code = "path-traversal";
            throw err;
          }
          copyFileSafe(srcAbs, destAbs);
          pathMap.articles[srcArticleRel] = archiveArticleRel;
          articleFiles.push(archiveArticleRel);
        }
      }

      if (!archiveReportRel) {
        missingReportCount += 1;
        warnings.push({
          code: "unsafe-or-missing-report-path",
          storyId,
          reportPath: sanitizeWarningPath(srcReportRel),
        });
      } else {
        const srcAbs = resolveSafeUnderRoot(work, srcReportRel);
        if (!srcAbs || !fs.existsSync(srcAbs)) {
          missingReportCount += 1;
          warnings.push({
            code: "report-file-not-found",
            storyId,
            reportPath: sanitizeWarningPath(srcReportRel),
          });
        } else {
          if (!resolveSafeUnderRoot(tmpDir, archiveReportRel)) {
            const err = new Error("Report の Archive 書込先が不正です。");
            err.code = "path-traversal";
            throw err;
          }
          copyFileSafe(srcAbs, path.join(tmpDir, archiveReportRel));
          pathMap.reports[srcReportRel] = archiveReportRel;
          reportFiles.push(archiveReportRel);
        }
      }
    }

    const archivedEdition = rewriteDailyEditionForArchive(editionDoc, pathMap);
    archivedEdition.editionDate = identity.editionDate;
    archivedEdition.editionId = editionId;

    const htmlRaw = fs.readFileSync(resolvedHtml, "utf8");
    const cssRaw = fs.readFileSync(resolvedCss, "utf8");
    const htmlOut = rewriteArchiveHtml(htmlRaw, pathMap);

    fs.writeFileSync(path.join(tmpDir, "index.html"), htmlOut, "utf8");
    fs.writeFileSync(path.join(tmpDir, "edition.css"), cssRaw, "utf8");
    writeJsonAtomic(path.join(tmpDir, "daily-edition.json"), archivedEdition);

    const stamp =
      asString(createdAt) ||
      (now instanceof Date
        ? now.toISOString()
        : asString(now) || new Date().toISOString());

    const manifest = {
      version: ARCHIVE_MANIFEST_VERSION,
      editionId,
      editionDate: identity.editionDate,
      createdAt: stamp,
      source: {
        dailyEditionPath: "daily-edition.json",
        htmlPath: "index.html",
        cssPath: "edition.css",
      },
      files: {
        html: "index.html",
        css: "edition.css",
        dailyEdition: "daily-edition.json",
        articles: articleFiles.slice().sort(),
        reports: reportFiles.slice().sort(),
      },
      summary: {
        articleCount: articleFiles.length,
        reportCount: reportFiles.length,
        missingArticleCount,
        missingReportCount,
        warningsCount: warnings.length,
      },
      warnings,
    };

    assertNoAbsolutePaths(manifest, "archive-manifest");
    writeJsonAtomic(path.join(tmpDir, "archive-manifest.json"), manifest);

    // Validate required files before swap
    for (const req of [
      "index.html",
      "edition.css",
      "daily-edition.json",
      "archive-manifest.json",
    ]) {
      if (!fs.existsSync(path.join(tmpDir, req))) {
        const err = new Error(`Archive 必須ファイルが欠けています: ${req}`);
        err.code = "archive-incomplete";
        throw err;
      }
    }

    // Atomic-ish replace: remove old, rename tmp → final
    rmrf(finalDir);
    fs.renameSync(tmpDir, finalDir);

    return {
      editionId,
      editionDate: identity.editionDate,
      archiveDir: finalDir,
      manifest,
      warnings,
    };
  } catch (error) {
    // Do not leave a partial final archive; clean tmp
    try {
      rmrf(tmpDir);
    } catch (_e) {
      // best-effort
    }
    throw error;
  }
}

module.exports = {
  buildEditionArchive,
  resolveEditionIdentity,
  sanitizeEditionId,
  flattenPublishedEntries,
  resolveSafeUnderRoot,
  archiveRelFromEntryPath,
  rewriteArchiveHtml,
  rewriteDailyEditionForArchive,
  ARCHIVE_MANIFEST_VERSION,
  SECTIONS,
};
