/**
 * EP-006 — Edition Layout from decisions + ranking.
 * Selection + order + section only. No Writer / Daily Edition control yet.
 * Deterministic. No AI. Does not mutate decisions or ranking.
 */

const { extractStoriesList } = require("./editor-decision");

const EDITION_VERSION = "1.0";
const MAX_SELECTED = 9;
const MAX_TOP = 1;
const MAX_SECONDARY = 3;
const MAX_BRIEF = 5;

const SECTION_TOP = "top";
const SECTION_SECONDARY = "secondary";
const SECTION_BRIEF = "brief";

const REASON_CAPACITY = "edition-capacity";
const REASON_NOT_RANKED = "not-ranked";
const REASON_STORY_NOT_FOUND = "story-not-found";
const REASON_DUPLICATE = "duplicate-story";

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function storyById(stories, storyId) {
  const id = asString(storyId);
  if (!id) return null;
  return stories.find((s) => asString(s?.id) === id) || null;
}

function decisionMap(decisions) {
  const map = new Map();
  for (const d of Array.isArray(decisions) ? decisions : []) {
    const id = asString(d?.storyId);
    if (!id) continue;
    if (!map.has(id)) map.set(id, asString(d?.decision));
  }
  return map;
}

function compareCandidates(a, b) {
  const rankA = asNumber(a.rank);
  const rankB = asNumber(b.rank);
  const rankAValid = rankA != null && rankA > 0;
  const rankBValid = rankB != null && rankB > 0;

  if (rankAValid && rankBValid && rankA !== rankB) return rankA - rankB;
  if (rankAValid && !rankBValid) return -1;
  if (!rankAValid && rankBValid) return 1;

  const scoreA = asNumber(a.score) ?? -1;
  const scoreB = asNumber(b.score) ?? -1;
  if (scoreA !== scoreB) return scoreB - scoreA;

  return a.storyId.localeCompare(b.storyId);
}

function assignSection(position) {
  if (position === 1) return SECTION_TOP;
  if (position >= 2 && position <= 4) return SECTION_SECONDARY;
  if (position >= 5 && position <= 9) return SECTION_BRIEF;
  return SECTION_BRIEF;
}

function emptySummary() {
  return {
    candidateCount: 0,
    selectedCount: 0,
    omittedCount: 0,
    topCount: 0,
    secondaryCount: 0,
    briefCount: 0,
  };
}

function pushOmitted(omitted, storyId, reasonCode, seenOmit) {
  const id = asString(storyId);
  const code = asString(reasonCode);
  if (!id || !code) return;
  const key = `${id}|${code}`;
  if (seenOmit.has(key)) return;
  seenOmit.add(key);
  omitted.push({ storyId: id, reasonCode: code });
}

/**
 * Build edition layout from editor decisions + ranking + stories.
 */
function buildEditorEdition({ decisions, ranking, stories } = {}) {
  const storyList = extractStoriesList(stories);
  const decisionsById = decisionMap(decisions);
  const rankingList = Array.isArray(ranking) ? ranking : [];

  const omitted = [];
  const seenOmit = new Set();
  const warnings = [];

  // accept but not ranked
  for (const [storyId, decision] of decisionsById.entries()) {
    if (decision !== "accept") continue;
    const inRanking = rankingList.some((r) => asString(r?.storyId) === storyId);
    if (!inRanking) {
      pushOmitted(omitted, storyId, REASON_NOT_RANKED, seenOmit);
    }
  }

  // Walk ranking in array order first to detect duplicates, then sort for selection.
  const seenInRanking = new Set();
  const rawCandidates = [];

  for (const entry of rankingList) {
    const storyId = asString(entry?.storyId);
    if (!storyId) {
      warnings.push("ranking-entry-missing-storyId");
      continue;
    }

    const decision = decisionsById.get(storyId);
    // hold / reject (or unknown) — never select; do not flood omitted
    if (decision !== "accept") {
      continue;
    }

    if (seenInRanking.has(storyId)) {
      pushOmitted(omitted, storyId, REASON_DUPLICATE, seenOmit);
      continue;
    }
    seenInRanking.add(storyId);

    const story = storyById(storyList, storyId);
    if (!story) {
      pushOmitted(omitted, storyId, REASON_STORY_NOT_FOUND, seenOmit);
      continue;
    }

    rawCandidates.push({
      storyId,
      rank: asNumber(entry.rank),
      score: asNumber(entry.score) ?? 0,
    });
  }

  rawCandidates.sort(compareCandidates);

  const candidateCount = rawCandidates.length;
  const selected = [];
  const capacityPool = rawCandidates.slice(0, MAX_SELECTED);
  const overflow = rawCandidates.slice(MAX_SELECTED);

  for (const item of overflow) {
    pushOmitted(omitted, item.storyId, REASON_CAPACITY, seenOmit);
  }

  for (let i = 0; i < capacityPool.length; i++) {
    const item = capacityPool[i];
    const position = i + 1;
    selected.push({
      storyId: item.storyId,
      rank: item.rank != null ? item.rank : position,
      score: item.score,
      section: assignSection(position),
      position,
    });
  }

  // Stable omitted order: reasonCode then storyId
  omitted.sort((a, b) => {
    if (a.reasonCode !== b.reasonCode) {
      return a.reasonCode.localeCompare(b.reasonCode);
    }
    return a.storyId.localeCompare(b.storyId);
  });

  const summary = emptySummary();
  summary.candidateCount = candidateCount;
  summary.selectedCount = selected.length;
  summary.omittedCount = omitted.length;
  summary.topCount = selected.filter((s) => s.section === SECTION_TOP).length;
  summary.secondaryCount = selected.filter(
    (s) => s.section === SECTION_SECONDARY
  ).length;
  summary.briefCount = selected.filter((s) => s.section === SECTION_BRIEF).length;

  // Cap sanity (should always hold by construction)
  if (summary.topCount > MAX_TOP) summary.topCount = MAX_TOP;
  if (summary.secondaryCount > MAX_SECONDARY) {
    summary.secondaryCount = MAX_SECONDARY;
  }
  if (summary.briefCount > MAX_BRIEF) summary.briefCount = MAX_BRIEF;

  const edition = {
    version: EDITION_VERSION,
    selected,
    omitted,
    summary,
  };

  if (warnings.length > 0) {
    edition.warnings = [...new Set(warnings)].sort();
  }

  return edition;
}

function mergeEditionIntoEditorView(editorView, edition) {
  const base =
    editorView && typeof editorView === "object" && !Array.isArray(editorView)
      ? { ...editorView }
      : {};
  return {
    ...base,
    edition:
      edition && typeof edition === "object"
        ? edition
        : {
            version: EDITION_VERSION,
            selected: [],
            omitted: [],
            summary: emptySummary(),
          },
  };
}

module.exports = {
  buildEditorEdition,
  mergeEditionIntoEditorView,
  assignSection,
  compareCandidates,
  EDITION_VERSION,
  MAX_SELECTED,
  MAX_TOP,
  MAX_SECONDARY,
  MAX_BRIEF,
  SECTION_TOP,
  SECTION_SECONDARY,
  SECTION_BRIEF,
  REASON_CAPACITY,
  REASON_NOT_RANKED,
  REASON_STORY_NOT_FOUND,
  REASON_DUPLICATE,
};
