/**
 * ED-001 — Today's Picks debug view (console only).
 * Enabled only when DEBUG_TODAY_PICKS=true. Never written to Reader/HTML/history.
 */
const {
  getCategory,
  getImportanceOrNull,
  getSummary,
  getUrl,
} = require("./editorial-score");
const {
  categorySoftCap,
  isExactDuplicate,
  isNearDuplicate,
  meetsQualityFloor,
  getAuthorKey,
  getDomainKey,
  getTitleText,
} = require("./today-picks");

const ENV_FLAG = "DEBUG_TODAY_PICKS";
const REJECTED_PREVIEW_LIMIT = 12;
const TITLE_MAX = 48;

const SIGNAL_LABELS = {
  "highest-score": "Highest Score",
  "unique-topic": "Unique Topic",
  "category-balance": "Category Balance",
  "source-diversity": "Source Diversity",
  "fallback-selection": "Fallback Selection",
};

function isTodayPicksDebugEnabled(env = process.env) {
  return String(env?.[ENV_FLAG] || "").trim().toLowerCase() === "true";
}

function truncateTitle(value, max = TITLE_MAX) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "(untitled)";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function importanceLabel(importance) {
  if (importance == null || !Number.isFinite(Number(importance))) {
    return "—";
  }
  const n = Number(importance);
  if (n >= 4) return `High (${n})`;
  if (n >= 3) return `Medium (${n})`;
  return `Low (${n})`;
}

function sourceLabel(post) {
  const domain = getDomainKey(post);
  if (domain && domain !== "x.com") return domain;
  const author = getAuthorKey(post);
  if (author) return `@${author}`;
  if (domain) return domain;
  return "—";
}

function pickTitle(post) {
  const summary = getSummary(post);
  if (summary && summary !== "要約なし") return summary;
  return getTitleText(post);
}

function displaySignals(signalKeys) {
  const labels = [];
  const seen = new Set();
  for (const key of signalKeys || []) {
    const label = SIGNAL_LABELS[key] || null;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function explainRejection(candidate, selected, bestScore, catCap) {
  for (const item of selected) {
    if (isExactDuplicate(candidate.post, item.post)) {
      return ["Exact Duplicate"];
    }
  }
  for (const item of selected) {
    if (isNearDuplicate(candidate.post, item.post)) {
      return ["Near Duplicate"];
    }
  }
  if (!meetsQualityFloor(candidate.editorialScore, bestScore)) {
    return ["Quality Floor"];
  }

  const category = getCategory(candidate.post);
  let catCount = 0;
  for (const item of selected) {
    if (getCategory(item.post) === category) catCount += 1;
  }
  if (catCount >= catCap) {
    return ["Category Soft Cap"];
  }

  const author = getAuthorKey(candidate.post);
  if (author) {
    let authorCount = 0;
    for (const item of selected) {
      if (getAuthorKey(item.post) === author) authorCount += 1;
    }
    if (authorCount >= 1) return ["Source Diversity"];
  }

  const domain = getDomainKey(candidate.post);
  if (domain && domain !== "x.com") {
    let domainCount = 0;
    for (const item of selected) {
      if (getDomainKey(item.post) === domain) domainCount += 1;
    }
    if (domainCount >= 2) return ["Source Diversity"];
  }

  return ["Lower Score"];
}

/**
 * Build a plain debug object from ranked candidates + selected internals.
 * Does not mutate inputs. Safe to discard.
 *
 * @param {Array} ranked
 * @param {Array} selected
 * @param {number} limit
 */
function buildTodayPicksDebug(ranked, selected, limit) {
  const list = Array.isArray(ranked) ? ranked : [];
  const chosen = Array.isArray(selected) ? selected : [];
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  const bestScore = list.length > 0 ? list[0].editorialScore : 0;
  const catCap = categorySoftCap(cap);
  const selectedIds = new Set(chosen.map((item) => item.stableId));

  const maxSelectedScore = chosen.reduce(
    (max, item) => Math.max(max, item.editorialScore),
    Number.NEGATIVE_INFINITY
  );

  const selectedRows = chosen.map((item, index) => {
    const signals = [...(item.selectionSignals || [])];
    if (item.editorialScore === maxSelectedScore) {
      signals.unshift("highest-score");
    }
    return {
      rank: index + 1,
      title: truncateTitle(pickTitle(item.post)),
      score: item.editorialScore,
      category: getCategory(item.post),
      importance: getImportanceOrNull(item.post),
      source: sourceLabel(item.post),
      url: getUrl(item.post),
      signals: displaySignals(signals),
      signalKeys: [...new Set(signals)],
    };
  });

  const rejectedRows = [];
  for (const candidate of list) {
    if (selectedIds.has(candidate.stableId)) continue;
    if (rejectedRows.length >= REJECTED_PREVIEW_LIMIT) break;
    rejectedRows.push({
      title: truncateTitle(pickTitle(candidate.post)),
      score: candidate.editorialScore,
      category: getCategory(candidate.post),
      reasons: explainRejection(candidate, chosen, bestScore, catCap),
      url: getUrl(candidate.post),
    });
  }

  return {
    candidateCount: list.length,
    selectedCount: chosen.length,
    limit: cap,
    selected: selectedRows,
    rejected: rejectedRows,
  };
}

function formatTodayPicksDebug(debug) {
  if (!debug) return "";
  const lines = [];
  lines.push("Today's Picks Debug");
  lines.push("");
  lines.push(
    `Selected: ${debug.selectedCount} / Candidates: ${debug.candidateCount}`
  );
  lines.push("");

  if (debug.selected.length > 0) {
    lines.push("Selected Picks");
    lines.push("");
    for (const row of debug.selected) {
      lines.push(`${row.rank}. ${row.title}`);
      lines.push(`   Score: ${row.score}`);
      lines.push(`   Category: ${row.category || "—"}`);
      lines.push(`   Importance: ${importanceLabel(row.importance)}`);
      lines.push(`   Source: ${row.source}`);
      lines.push("   Signals:");
      if (row.signals.length === 0) {
        lines.push("   ✓ Selected");
      } else {
        for (const signal of row.signals) {
          lines.push(`   ✓ ${signal}`);
        }
      }
      lines.push("");
    }
  } else {
    lines.push("Selected Picks");
    lines.push("(none)");
    lines.push("");
  }

  lines.push("Rejected");
  lines.push("");
  if (debug.rejected.length === 0) {
    lines.push("(none)");
  } else {
    for (const row of debug.rejected) {
      lines.push(row.title);
      lines.push("Reason:");
      for (const reason of row.reasons) {
        lines.push(`- ${reason}`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function maybeLogTodayPicksDebug(debug, env = process.env, logger = console) {
  if (!isTodayPicksDebugEnabled(env)) return false;
  const text = formatTodayPicksDebug(debug);
  if (!text) return false;
  if (logger && typeof logger.log === "function") {
    logger.log(text);
  }
  return true;
}

module.exports = {
  ENV_FLAG,
  isTodayPicksDebugEnabled,
  buildTodayPicksDebug,
  formatTodayPicksDebug,
  maybeLogTodayPicksDebug,
  truncateTitle,
  importanceLabel,
  SIGNAL_LABELS,
};
