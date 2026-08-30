/**
 * DAILY-COLLECT-SCOPE-001 — Daily Editorial Scope vs Archive.
 * Scope is the Collect run's newPosts, not postedAt-is-today.
 */

const fs = require("fs");
const path = require("path");
const { readJsonRequired, writeJsonAtomic } = require("./pipeline-io");

const DAILY_SCOPE_REL = path.join("output", "daily-scope.json");
const DAILY_ANALYZED_REL = path.join("output", "daily-analyzed.json");
const DAILY_AI_REL = path.join("output", "daily-ai.json");
const DAILY_ENRICHED_REL = path.join("output", "daily-enriched.json");

function buildDailyScope(input = {}) {
  const posts = Array.isArray(input.posts) ? input.posts.slice() : [];
  const itemCount = posts.length;
  const totalStored = Number(input.totalStored);
  return {
    collectedAt:
      input.collectedAt == null || input.collectedAt === ""
        ? null
        : String(input.collectedAt),
    fetchedFromScreen: Number(input.fetchedFromScreen) || 0,
    newPosts: Number.isFinite(Number(input.newPosts))
      ? Number(input.newPosts)
      : itemCount,
    duplicateUrlsSkipped: Number(input.duplicateUrlsSkipped) || 0,
    totalStored: Number.isFinite(totalStored) ? totalStored : 0,
    itemCount,
    posts,
  };
}

function buildDailyScopeSummary(input = {}) {
  if (!input || typeof input !== "object") return null;
  const itemCount = Number(input.itemCount);
  const archiveTotal = Number(input.archiveTotal);
  if (!Number.isFinite(itemCount) && !Number.isFinite(archiveTotal)) {
    return null;
  }
  const out = {
    itemCount: Number.isFinite(itemCount) ? Math.max(0, Math.floor(itemCount)) : 0,
  };
  if (Number.isFinite(archiveTotal)) {
    out.archiveTotal = Math.max(0, Math.floor(archiveTotal));
  }
  return out;
}

function pickDailyScope(input) {
  if (!input || typeof input !== "object") return null;
  if (input.dailyScope && typeof input.dailyScope === "object") {
    return buildDailyScopeSummary(input.dailyScope);
  }
  if (input.collect && typeof input.collect === "object") {
    const collect = input.collect;
    if (collect.newPosts != null || collect.totalStored != null) {
      return buildDailyScopeSummary({
        itemCount: collect.newPosts,
        archiveTotal: collect.totalStored,
      });
    }
  }
  return null;
}

function resolveDailyScopePath(rootDir) {
  return path.join(path.resolve(rootDir || process.cwd()), DAILY_SCOPE_REL);
}

function saveDailyScope(rootDir, scope, deps = {}) {
  const write = deps.writeJsonAtomic || writeJsonAtomic;
  const filePath = resolveDailyScopePath(rootDir);
  const dir = path.dirname(filePath);
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  mkdirSync(dir, { recursive: true });
  const payload = buildDailyScope(scope);
  write(filePath, payload);
  return { path: filePath, scope: payload };
}

function readEditorialPosts(filePath, label) {
  const data = readJsonRequired(filePath, label || filePath);
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray(data.posts)) {
    return data.posts;
  }
  const err = new Error(
    `${label || filePath} は投稿配列または { posts: [] } ではありません`
  );
  err.code = "DAILY_SCOPE_INVALID";
  throw err;
}

function parseIoFlags(argv, failFn) {
  const fail =
    typeof failFn === "function"
      ? failFn
      : (message) => {
          throw new Error(message);
        };
  const rest = [];
  let input = null;
  let output = null;
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token === "--input") {
      const value = list[i + 1];
      if (value == null || String(value).startsWith("-")) {
        fail("--input にはパスを指定してください。");
      }
      input = String(value);
      i += 1;
      continue;
    }
    if (token === "--output") {
      const value = list[i + 1];
      if (value == null || String(value).startsWith("-")) {
        fail("--output にはパスを指定してください。");
      }
      output = String(value);
      i += 1;
      continue;
    }
    rest.push(token);
  }
  return { input, output, rest };
}

function resolveOptionalPath(explicit, fallback) {
  if (explicit == null || explicit === "") return fallback;
  return path.resolve(process.cwd(), explicit);
}

function morningAnalyzeArgs() {
  return ["--input", DAILY_SCOPE_REL, "--output", DAILY_ANALYZED_REL];
}

function morningAnalyzeAiArgs(limit) {
  return [
    "--limit",
    String(limit),
    "--input",
    DAILY_ANALYZED_REL,
    "--output",
    DAILY_AI_REL,
  ];
}

function morningEnrichArgs(limit) {
  return [
    "--limit",
    String(limit),
    "--input",
    DAILY_AI_REL,
    "--output",
    DAILY_ENRICHED_REL,
  ];
}

function morningReaderInputArgs() {
  return ["--input", DAILY_ENRICHED_REL];
}

module.exports = {
  DAILY_SCOPE_REL,
  DAILY_ANALYZED_REL,
  DAILY_AI_REL,
  DAILY_ENRICHED_REL,
  buildDailyScope,
  buildDailyScopeSummary,
  pickDailyScope,
  resolveDailyScopePath,
  saveDailyScope,
  readEditorialPosts,
  parseIoFlags,
  resolveOptionalPath,
  morningAnalyzeArgs,
  morningAnalyzeAiArgs,
  morningEnrichArgs,
  morningReaderInputArgs,
};
