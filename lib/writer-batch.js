/**
 * EP-008 — Multi-Article Writer batch runner.
 * 1 selected Story = 1 Writer run. Does not change Decision / Ranking / Edition / prose.
 * Deterministic. No AI.
 */

const fs = require("fs");
const path = require("path");
const { renderMarkdown } = require("./writer-core");
const { toWriterStoriesInput } = require("./writer-selection");

const MANIFEST_VERSION = "1.0";

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Safe filename segment from storyId.
 */
function sanitizeStoryId(storyId) {
  let s = asString(storyId).toLowerCase();
  s = s
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "story";
}

/**
 * Deterministic article filename: {NN}-{safe-id}.md
 * Never overwrites an already-claimed name in usedNames.
 */
function buildArticleFileName(position, storyId, usedNames) {
  const posNum =
    asNumber(position) != null && asNumber(position) > 0
      ? Math.floor(asNumber(position))
      : 1;
  const pos = String(posNum).padStart(2, "0");
  const base = sanitizeStoryId(storyId);
  let name = `${pos}-${base}.md`;
  let n = 2;
  while (usedNames.has(name)) {
    name = `${pos}-${base}-${n}.md`;
    n += 1;
  }
  usedNames.add(name);
  return name;
}

function buildSingleStoryInput(selectedItem, originalStoriesInput = null) {
  const miniSelection = {
    mode: "edition",
    summary: {
      requestedCount: 1,
      resolvedCount: 1,
      missingCount: 0,
      duplicateCount: 0,
    },
    warnings: [],
    selectedStories: [selectedItem],
  };
  return toWriterStoriesInput(miniSelection, originalStoriesInput);
}

function emptyManifestSummary() {
  return {
    requestedCount: 0,
    generatedCount: 0,
    failedCount: 0,
    skippedCount: 0,
  };
}

/**
 * Run Writer once per selected story.
 *
 * @param {object} options
 * @param {object} options.selectionResult - from selectStoriesForWriter
 * @param {object} options.brief
 * @param {object} options.plan
 * @param {string} options.outputDir - articles directory
 * @param {string} [options.manifestPath]
 * @param {string} [options.legacyPrimaryPath] - article.md for AR/DE
 * @param {object} [options.originalStoriesInput]
 * @param {function} [options.renderFn] - inject for tests (default renderMarkdown)
 * @returns {{
 *   manifest: object,
 *   legacyPrimaryMarkdown: string,
 *   legacyPrimaryArticlePath: string|null,
 *   articles: object[],
 * }}
 */
function runWriterBatch({
  selectionResult,
  brief,
  plan,
  outputDir,
  manifestPath = null,
  legacyPrimaryPath = null,
  originalStoriesInput = null,
  renderFn = null,
} = {}) {
  const render = typeof renderFn === "function" ? renderFn : renderMarkdown;
  const selected = Array.isArray(selectionResult?.selectedStories)
    ? selectionResult.selectedStories
    : [];

  ensureDir(outputDir);

  const usedNames = new Set();
  const articles = [];
  const warnings = [];
  const summary = emptyManifestSummary();
  summary.requestedCount = selected.length;

  let legacyPrimaryMarkdown = "";
  let legacyPrimaryArticlePath = null;

  for (let index = 0; index < selected.length; index++) {
    const item = selected[index];
    const position =
      asNumber(item.position) != null && asNumber(item.position) > 0
        ? Math.floor(asNumber(item.position))
        : index + 1;
    const storyId = asString(item.storyId) || `index-${index + 1}`;
    const fileName = buildArticleFileName(position, storyId, usedNames);
    const absolutePath = path.join(outputDir, fileName);
    const relativePath = path
      .join(path.basename(outputDir), fileName)
      .replace(/\\/g, "/");

    const entry = {
      storyId,
      position,
      section: asString(item.section) || null,
      rank: asNumber(item.rank),
      score: asNumber(item.score),
      articlePath: relativePath,
      status: "skipped",
    };

    if (!item.story || typeof item.story !== "object") {
      entry.status = "failed";
      entry.errorCode = "selected-story-not-found";
      summary.failedCount += 1;
      articles.push(entry);
      continue;
    }

    let markdown = "";
    try {
      const storiesInput = buildSingleStoryInput(item, originalStoriesInput);
      markdown = render(brief, plan, { stories: storiesInput });
    } catch (_err) {
      entry.status = "failed";
      entry.errorCode = "writer-generation-failed";
      summary.failedCount += 1;
      articles.push(entry);
      continue;
    }

    if (typeof markdown !== "string" || !markdown.trim()) {
      entry.status = "failed";
      entry.errorCode = "writer-empty-output";
      summary.failedCount += 1;
      articles.push(entry);
      continue;
    }

    try {
      fs.writeFileSync(absolutePath, markdown, "utf8");
    } catch (_err) {
      entry.status = "failed";
      entry.errorCode = "article-write-failed";
      summary.failedCount += 1;
      articles.push(entry);
      continue;
    }

    entry.status = "generated";
    summary.generatedCount += 1;
    articles.push(entry);

    if (legacyPrimaryArticlePath == null) {
      legacyPrimaryMarkdown = markdown;
      legacyPrimaryArticlePath = relativePath;
    }
  }

  const manifest = {
    version: MANIFEST_VERSION,
    articles,
    summary,
    warnings: warnings.slice().sort(),
    legacyPrimaryArticlePath,
  };

  if (manifestPath) {
    ensureDir(path.dirname(manifestPath));
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
  }

  if (legacyPrimaryPath != null) {
    ensureDir(path.dirname(legacyPrimaryPath));
    fs.writeFileSync(legacyPrimaryPath, legacyPrimaryMarkdown, "utf8");
  }

  return {
    manifest,
    legacyPrimaryMarkdown,
    legacyPrimaryArticlePath,
    articles,
  };
}

module.exports = {
  runWriterBatch,
  sanitizeStoryId,
  buildArticleFileName,
  buildSingleStoryInput,
  MANIFEST_VERSION,
};
