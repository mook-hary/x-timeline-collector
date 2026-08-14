/**
 * Today's Picks freshness vs previous edition (no AI).
 * Ephemeral score penalties only — does not mutate stored editorialScore.
 */

const { extractLinkedResourceKey, buildTopicKey } = require("./digest-core");
const { pickIdentity } = require("./today-picks-history");

/** Soft demotion — keep major news selectable. */
const PREVIOUS_URL_PENALTY = 32;
const PREVIOUS_LINK_PENALTY = 28;
const PREVIOUS_STORY_PENALTY = 28;
const PREVIOUS_TOPIC_PENALTY = 16;
const CONTINUATION_PENALTY_FACTOR = 0.25;

const CONTINUATION_MARKERS = [
  "続報",
  "続々",
  "追加発表",
  "新たに発表",
  "新たに判明",
  "更新",
  "改定",
  "改訂",
  "リリース",
  "公開開始",
  "発表",
  "速報",
  "追記",
  "update",
  "updated",
  "breaking",
];

const DATE_HINT_RE =
  /\d{4}[-\/年]\d{1,2}[-\/月]\d{1,2}|[0-9]{1,2}月[0-9]{1,2}日|本日|きょう|昨日|きのう|今朝/;

function getSummary(post) {
  if (!post || typeof post !== "object") return "";
  return String(post.summary != null ? post.summary : post.enrichment?.summary || "").trim();
}

function getUrl(post) {
  if (!post || typeof post !== "object") return "";
  return String(post.url || "").trim();
}

function getLinkedArticleKey(post) {
  return (
    extractLinkedResourceKey(`${getSummary(post)}\n${post?.text || ""}`) || ""
  );
}

function textBlob(post) {
  return `${getSummary(post)}\n${post && post.text ? post.text : ""}`;
}

function hasContinuationSignal(post) {
  const blob = textBlob(post).toLowerCase();
  if (DATE_HINT_RE.test(blob)) return true;
  for (const marker of CONTINUATION_MARKERS) {
    if (blob.includes(String(marker).toLowerCase())) return true;
  }
  return false;
}

function indexPreviousPicks(previousPicks) {
  const urls = new Set();
  const links = new Set();
  const stories = new Set();
  const topics = new Set();
  const byTopic = new Map();
  const list = Array.isArray(previousPicks) ? previousPicks : [];
  for (const raw of list) {
    const id = pickIdentity(raw);
    if (id.url) urls.add(id.url);
    if (id.linkedArticleKey) links.add(id.linkedArticleKey);
    if (id.storyId) stories.add(id.storyId);
    if (id.topicKey) {
      topics.add(id.topicKey);
      if (!byTopic.has(id.topicKey)) byTopic.set(id.topicKey, []);
      byTopic.get(id.topicKey).push(id);
    }
  }
  return { urls, links, stories, topics, byTopic, list };
}

function matchPreviousDay(post, index) {
  const id = pickIdentity(post);
  if (id.url && index.urls.has(id.url)) {
    return { kind: "url", continuation: false };
  }
  if (id.storyId && index.stories.has(id.storyId)) {
    return { kind: "storyId", continuation: false };
  }
  if (id.linkedArticleKey && index.links.has(id.linkedArticleKey)) {
    return { kind: "linked", continuation: false };
  }
  if (id.topicKey && index.topics.has(id.topicKey)) {
    const prev = (index.byTopic.get(id.topicKey) || [])[0];
    const continuation = isContinuationUpdate(post, prev);
    return { kind: "topic", continuation };
  }
  return null;
}

function isContinuationUpdate(post, previousIdentity) {
  if (!previousIdentity) return hasContinuationSignal(post);
  const currLink = getLinkedArticleKey(post) || "";
  if (
    currLink &&
    previousIdentity.linkedArticleKey &&
    currLink !== previousIdentity.linkedArticleKey
  ) {
    return true;
  }
  const currUrl = getUrl(post) || "";
  if (
    currUrl &&
    previousIdentity.url &&
    currUrl !== previousIdentity.url &&
    hasContinuationSignal(post)
  ) {
    return true;
  }
  if (!hasContinuationSignal(post)) return false;
  const prevSummary = String(previousIdentity.summary || "");
  const currSummary = getSummary(post) || "";
  if (currSummary && prevSummary && currSummary !== prevSummary) {
    return true;
  }
  return true;
}

function penaltyForMatch(match) {
  if (!match) return 0;
  let base = PREVIOUS_TOPIC_PENALTY;
  if (match.kind === "url") base = PREVIOUS_URL_PENALTY;
  else if (match.kind === "linked") base = PREVIOUS_LINK_PENALTY;
  else if (match.kind === "storyId") base = PREVIOUS_STORY_PENALTY;
  if (match.continuation) {
    return Math.round(base * CONTINUATION_PENALTY_FACTOR);
  }
  return base;
}

function applyPreviousDayPenalties(ranked, previousPicks) {
  const index = indexPreviousPicks(previousPicks);
  const matches = new Map();
  const list = Array.isArray(ranked) ? ranked : [];
  if (!index.list.length) {
    return { ranked: list, matches };
  }

  const next = list.map((item) => {
    const match = matchPreviousDay(item.post, index);
    if (!match) return item;
    const penalty = penaltyForMatch(match);
    matches.set(item.stableId || getUrl(item.post), {
      ...match,
      penalty,
    });
    if (penalty <= 0) return item;
    return {
      ...item,
      editorialScore: Number(item.editorialScore) - penalty,
      previousDayMatch: match,
      previousDayPenalty: penalty,
    };
  });
  return { ranked: next, matches };
}

function computePicksFreshnessMetrics(picks, previousPicks) {
  const list = Array.isArray(picks) ? picks : [];
  const picksCount = list.length;
  const index = indexPreviousPicks(previousPicks);
  let repeated = 0;
  for (const pick of list) {
    const post =
      pick && pick.post && typeof pick.post === "object" ? pick.post : pick;
    const match = matchPreviousDay(post, index);
    if (match && !match.continuation) repeated += 1;
  }
  const newVsYesterday = Math.max(0, picksCount - repeated);
  const repeatRate =
    picksCount === 0 ? 0 : Math.round((repeated / picksCount) * 1000) / 1000;
  const targetNewRate = 0.7;
  const newRate = picksCount === 0 ? null : newVsYesterday / picksCount;
  return {
    picksCount,
    newVsYesterday,
    repeated,
    repeatRate,
    targetNewRate,
    metTarget: newRate == null ? null : newRate >= targetNewRate,
  };
}

function formatPicksFreshnessLine(metrics) {
  if (!metrics) return "";
  const pct = Math.round((Number(metrics.repeatRate) || 0) * 100);
  return (
    `Today's Picks: ${metrics.picksCount}\n` +
    `New vs yesterday: ${metrics.newVsYesterday}\n` +
    `Repeated: ${metrics.repeated}\n` +
    `Repeat rate: ${pct}%`
  );
}

module.exports = {
  PREVIOUS_URL_PENALTY,
  PREVIOUS_LINK_PENALTY,
  PREVIOUS_STORY_PENALTY,
  PREVIOUS_TOPIC_PENALTY,
  CONTINUATION_PENALTY_FACTOR,
  CONTINUATION_MARKERS,
  hasContinuationSignal,
  isContinuationUpdate,
  matchPreviousDay,
  applyPreviousDayPenalties,
  computePicksFreshnessMetrics,
  formatPicksFreshnessLine,
  buildTopicKey,
  getLinkedArticleKey,
};
