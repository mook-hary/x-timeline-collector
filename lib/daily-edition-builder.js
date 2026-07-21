/**
 * EP-010 — Build multi-article Daily Edition layout from articles-manifest.json.
 * Does not re-run Writer / Report / Ranking / Decision.
 * Deterministic. No AI.
 */

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./pipeline-io");

const EDITION_VERSION = "1.0";
const SECTIONS = ["top", "secondary", "brief"];

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveWorkRoot(manifestPath) {
  return path.dirname(path.resolve(manifestPath));
}

function resolveUnderRoot(workRoot, relPath) {
  const rel = asString(relPath);
  if (!rel) return null;
  if (path.isAbsolute(rel)) return null;
  if (rel.split(/[/\\]/).includes("..")) return null;
  return path.resolve(workRoot, rel);
}

function normalizeSection(section) {
  const s = asString(section);
  if (SECTIONS.includes(s)) return s;
  return "brief";
}

function emptySectionCounts() {
  return { top: 0, secondary: 0, brief: 0 };
}

/**
 * Select publishable articles from articles-manifest.
 * Condition: article.status=generated AND report.status=generated
 * Order: Manifest articles[] order (no re-sort).
 */
function selectEditionArticles(manifest, workRoot, warnings) {
  const articles = Array.isArray(manifest?.articles) ? manifest.articles : [];
  const selected = [];

  for (const entry of articles) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.status !== "generated") continue;
    if (!entry.report || entry.report.status !== "generated") {
      if (entry.status === "generated") {
        warnings.push({
          code: "missing-or-failed-report",
          storyId: asString(entry.storyId) || null,
        });
      }
      continue;
    }

    const articleAbs = resolveUnderRoot(workRoot, entry.articlePath);
    if (!articleAbs || !fs.existsSync(articleAbs)) {
      warnings.push({
        code: "article-file-not-found",
        storyId: asString(entry.storyId) || null,
        articlePath: asString(entry.articlePath) || null,
      });
      continue;
    }

    const reportAbs = resolveUnderRoot(workRoot, entry.report.reportPath);
    if (!reportAbs || !fs.existsSync(reportAbs)) {
      warnings.push({
        code: "report-file-not-found",
        storyId: asString(entry.storyId) || null,
        reportPath: asString(entry.report.reportPath) || null,
      });
      continue;
    }

    const item = {
      storyId: asString(entry.storyId),
      position: entry.position != null ? entry.position : null,
      section: normalizeSection(entry.section),
      rank: entry.rank != null ? entry.rank : null,
      score: entry.score != null ? entry.score : null,
      articlePath: asString(entry.articlePath),
      reportPath: asString(entry.report.reportPath),
      readyForAiRewrite: entry.report.readyForAiRewrite === true,
    };
    if (
      Object.prototype.hasOwnProperty.call(entry.report, "publishable")
    ) {
      item.publishable = entry.report.publishable === true;
    }
    selected.push(item);
  }

  return selected;
}

function groupBySection(items) {
  const edition = { top: [], secondary: [], brief: [] };
  for (const item of items) {
    const section = normalizeSection(item.section);
    edition[section].push({ ...item, section });
  }
  return edition;
}

/**
 * Build Daily Edition JSON from articles-manifest.
 *
 * @param {object} options
 * @param {object|string} options.manifest - object or path to articles-manifest.json
 * @param {string} [options.outputPath] - write daily-edition.json
 * @param {string} [options.legacyDeManifestPath] - write legacy DE manifest for daily-edition.js
 * @param {string} [options.date] - YYYY-MM-DD for legacy DE manifest
 * @returns {{
 *   editionDoc: object,
 *   legacyDeManifest: object|null,
 *   included: object[],
 * }}
 */
function buildDailyEditionFromArticlesManifest({
  manifest,
  outputPath = null,
  legacyDeManifestPath = null,
  date = null,
} = {}) {
  let manifestObj = manifest;
  let manifestPath = null;

  if (typeof manifest === "string") {
    manifestPath = path.resolve(manifest);
    if (!fs.existsSync(manifestPath)) {
      const err = new Error(`articles-manifest が見つかりません: ${manifestPath}`);
      err.code = "manifest-not-found";
      throw err;
    }
    try {
      manifestObj = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      const err = new Error(`articles-manifest が不正です: ${error.message}`);
      err.code = "manifest-invalid";
      throw err;
    }
  }

  if (!manifestObj || typeof manifestObj !== "object" || Array.isArray(manifestObj)) {
    const err = new Error("articles-manifest はオブジェクトである必要があります。");
    err.code = "manifest-invalid";
    throw err;
  }

  const workRoot = manifestPath
    ? resolveWorkRoot(manifestPath)
    : outputPath
      ? path.dirname(path.resolve(outputPath))
      : process.cwd();

  const warnings = [];
  const included = selectEditionArticles(manifestObj, workRoot, warnings);
  const edition = groupBySection(included);
  const sectionCounts = emptySectionCounts();
  sectionCounts.top = edition.top.length;
  sectionCounts.secondary = edition.secondary.length;
  sectionCounts.brief = edition.brief.length;

  const editionDoc = {
    version: EDITION_VERSION,
    edition,
    summary: {
      articleCount: included.length,
      sectionCounts,
      warningsCount: warnings.length,
    },
    warnings,
    legacyPrimaryArticlePath:
      asString(manifestObj.legacyPrimaryArticlePath) || null,
    legacyPrimaryReportPath:
      asString(manifestObj.legacyPrimaryReportPath) || null,
  };

  if (outputPath) {
    ensureDir(path.dirname(path.resolve(outputPath)));
    writeJsonAtomic(path.resolve(outputPath), editionDoc);
  }

  let legacyDeManifest = null;
  if (legacyDeManifestPath || date) {
    const ymd =
      asString(date) ||
      new Date().toISOString().slice(0, 10);
    legacyDeManifest = {
      date: ymd,
      title: "Daily Edition",
      items: included.map((item, index) => ({
        article: path.isAbsolute(item.articlePath)
          ? item.articlePath
          : path.resolve(workRoot, item.articlePath),
        report: path.isAbsolute(item.reportPath)
          ? item.reportPath
          : path.resolve(workRoot, item.reportPath),
        // Content category for legacy DE (not section). Section lives in daily-edition.json.
        category: "other",
        priority: (item.position != null ? Number(item.position) : index + 1) * 10,
      })),
    };
    if (legacyDeManifestPath) {
      ensureDir(path.dirname(path.resolve(legacyDeManifestPath)));
      writeJsonAtomic(path.resolve(legacyDeManifestPath), legacyDeManifest);
    }
  }

  return {
    editionDoc,
    legacyDeManifest,
    included,
  };
}

module.exports = {
  buildDailyEditionFromArticlesManifest,
  selectEditionArticles,
  groupBySection,
  normalizeSection,
  EDITION_VERSION,
  SECTIONS,
};
