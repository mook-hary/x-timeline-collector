/**
 * Persist Today's Picks for next-day freshness (local only, not Pages).
 */
const fs = require("fs");
const path = require("path");
const { extractLinkedResourceKey, buildTopicKey } = require("./digest-core");

const HISTORY_DIR_REL = path.join("data", "today-picks-history");
const LATEST_BASENAME = "latest.json";
const HISTORY_VERSION = 1;

function resolveHistoryDir(rootDir) {
  return path.join(path.resolve(rootDir || process.cwd()), HISTORY_DIR_REL);
}

function latestPath(rootDir) {
  return path.join(resolveHistoryDir(rootDir), LATEST_BASENAME);
}

function localDateKey(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    let host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "twitter.com") host = "x.com";
    const pathName = parsed.pathname.replace(/\/+$/, "") || "";
    return `${parsed.protocol}//${host}${pathName}`;
  } catch (_error) {
    return raw.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function extractStatusId(url) {
  const m = String(url || "").match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
  return m ? m[1] : "";
}

function linkedKeyFromPost(post) {
  if (!post || typeof post !== "object") return "";
  if (post.linkedArticleKey) return String(post.linkedArticleKey);
  return (
    extractLinkedResourceKey(
      `${post.enrichment?.summary || post.summary || ""}\n${post.text || ""}`
    ) || ""
  );
}

function pickIdentity(postOrPick) {
  const post =
    postOrPick && postOrPick.post && typeof postOrPick.post === "object"
      ? postOrPick.post
      : postOrPick;
  const url = normalizeUrl(
    (postOrPick && postOrPick.url) || (post && post.url) || ""
  );
  const linkedArticleKey =
    (postOrPick && postOrPick.linkedArticleKey) ||
    linkedKeyFromPost(post) ||
    "";
  const topicKey =
    (postOrPick && postOrPick.topicKey) ||
    (post ? buildTopicKey(post) : null) ||
    null;
  const storyId =
    (postOrPick && postOrPick.storyId) || (post && post.storyId) || null;
  const statusId = url ? extractStatusId(url) : "";
  return {
    url: url || "",
    linkedArticleKey: linkedArticleKey || "",
    topicKey: topicKey || null,
    storyId: storyId ? String(storyId) : null,
    statusId: statusId || "",
    category: String(
      (postOrPick && postOrPick.category) ||
        (post && (post.finalAnalysis?.category || post.category)) ||
        ""
    ),
    summary: String(
      (postOrPick && postOrPick.summary) ||
        (post && (post.enrichment?.summary || post.summary)) ||
        ""
    ).slice(0, 240),
  };
}

function buildPicksSnapshot(picks, options = {}) {
  const list = Array.isArray(picks) ? picks : [];
  const savedAt =
    options.savedAt ||
    (options.now instanceof Date
      ? options.now.toISOString()
      : options.now
        ? String(options.now)
        : new Date().toISOString());
  const date =
    options.date ||
    localDateKey(options.now ? new Date(options.now) : new Date(savedAt));
  return {
    version: HISTORY_VERSION,
    date,
    savedAt,
    picks: list.map((p) => pickIdentity(p)),
    metrics:
      options.metrics && typeof options.metrics === "object"
        ? options.metrics
        : null,
  };
}

function saveTodayPicksHistory(rootDir, picks, options = {}) {
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const writeFileSync = options.writeFileSync || fs.writeFileSync;
  const dir = resolveHistoryDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const snapshot = buildPicksSnapshot(picks, options);
  const filePath = latestPath(rootDir);
  writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  if (snapshot.date) {
    const dated = path.join(dir, `${snapshot.date}.json`);
    writeFileSync(dated, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
  return { path: filePath, snapshot };
}

function loadTodayPicksHistory(rootDir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const filePath = latestPath(rootDir);
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(String(readFileSync(filePath, "utf8")));
    if (!raw || typeof raw !== "object") return null;
    return {
      version: Number(raw.version) || HISTORY_VERSION,
      date: String(raw.date || ""),
      savedAt: String(raw.savedAt || ""),
      picks: Array.isArray(raw.picks) ? raw.picks : [],
      metrics:
        raw.metrics && typeof raw.metrics === "object" ? raw.metrics : null,
    };
  } catch (_error) {
    return null;
  }
}

/**
 * Prefer yesterday's snapshot; fall back to latest when dated file missing.
 */
function loadPreviousTodayPicks(rootDir, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const today = localDateKey(now);
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;

  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = localDateKey(y);
  const datedPath = path.join(resolveHistoryDir(rootDir), `${yesterday}.json`);
  if (existsSync(datedPath)) {
    try {
      const raw = JSON.parse(String(readFileSync(datedPath, "utf8")));
      if (raw && Array.isArray(raw.picks)) {
        return {
          version: Number(raw.version) || HISTORY_VERSION,
          date: String(raw.date || yesterday),
          savedAt: String(raw.savedAt || ""),
          picks: raw.picks,
          metrics:
            raw.metrics && typeof raw.metrics === "object" ? raw.metrics : null,
        };
      }
    } catch (_error) {
      // fall through
    }
  }

  const latest = loadTodayPicksHistory(rootDir, options);
  if (!latest) return null;
  if (latest.date && latest.date !== today) return latest;
  return null;
}

module.exports = {
  HISTORY_DIR_REL,
  LATEST_BASENAME,
  HISTORY_VERSION,
  resolveHistoryDir,
  localDateKey,
  pickIdentity,
  buildPicksSnapshot,
  saveTodayPicksHistory,
  loadTodayPicksHistory,
  loadPreviousTodayPicks,
};
