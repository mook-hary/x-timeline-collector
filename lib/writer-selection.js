/**
 * EP-007 — Writer Selection from editor.edition.selected[].
 * Filters Writer story input. Does not change Decision / Ranking / Edition / prose.
 * Deterministic. No AI.
 */

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractStoriesList(storiesInput) {
  if (storiesInput == null) return [];
  if (Array.isArray(storiesInput)) {
    return storiesInput.filter((s) => s && typeof s === "object");
  }
  if (typeof storiesInput === "object" && Array.isArray(storiesInput.stories)) {
    return storiesInput.stories.filter((s) => s && typeof s === "object");
  }
  if (typeof storiesInput === "object" && asString(storiesInput.id)) {
    return [storiesInput];
  }
  return [];
}

function emptySummary() {
  return {
    requestedCount: 0,
    resolvedCount: 0,
    missingCount: 0,
    duplicateCount: 0,
  };
}

function compareSelectedEntries(a, b) {
  const posA = asNumber(a.position);
  const posB = asNumber(b.position);
  const posAOk = posA != null && posA > 0;
  const posBOk = posB != null && posB > 0;
  if (posAOk && posBOk && posA !== posB) return posA - posB;
  if (posAOk && !posBOk) return -1;
  if (!posAOk && posBOk) return 1;

  const rankA = asNumber(a.rank);
  const rankB = asNumber(b.rank);
  const rankAOk = rankA != null && rankA > 0;
  const rankBOk = rankB != null && rankB > 0;
  if (rankAOk && rankBOk && rankA !== rankB) return rankA - rankB;
  if (rankAOk && !rankBOk) return -1;
  if (!rankAOk && rankBOk) return 1;

  return asString(a.storyId).localeCompare(asString(b.storyId));
}

function hasEditionSelected(editor) {
  return !!(
    editor &&
    typeof editor === "object" &&
    editor.edition &&
    typeof editor.edition === "object" &&
    Array.isArray(editor.edition.selected)
  );
}

/**
 * Select Writer targets from edition.selected[].
 *
 * @param {object} options
 * @param {object} options.editor - editor.json (may include edition)
 * @param {object|object[]} options.stories - stories payload
 * @param {boolean} [options.requireEdition=false] - Pipeline: true → error if edition missing
 * @returns {{
 *   ok: boolean,
 *   mode: "edition"|"compat",
 *   error: string|null,
 *   selectedStories: object[],
 *   warnings: object[],
 *   summary: object,
 * }}
 */
function selectStoriesForWriter({
  editor = null,
  stories = null,
  requireEdition = false,
} = {}) {
  const storyList = extractStoriesList(stories);
  const storyById = new Map();
  for (const story of storyList) {
    const id = asString(story?.id);
    if (id && !storyById.has(id)) storyById.set(id, story);
  }

  const warnings = [];
  const summary = emptySummary();

  if (!hasEditionSelected(editor)) {
    if (requireEdition) {
      return {
        ok: false,
        mode: "edition",
        error: "edition-required",
        selectedStories: [],
        warnings: [
          {
            code: "edition-required",
            message:
              "Pipeline では editor.edition.selected[] が必須です。全 Story への暗黙フォールバックはしません。",
          },
        ],
        summary,
      };
    }

    // Compat: Writer CLI without Edition — pass through stories (no filter).
    const selectedStories = storyList.map((story, index) => ({
      storyId: asString(story?.id) || `(index:${index})`,
      position: index + 1,
      section: null,
      rank: null,
      score: null,
      story,
    }));
    summary.requestedCount = selectedStories.length;
    summary.resolvedCount = selectedStories.length;
    return {
      ok: true,
      mode: "compat",
      error: null,
      selectedStories,
      warnings,
      summary,
    };
  }

  const selectedEntries = [...editor.edition.selected].sort(compareSelectedEntries);
  summary.requestedCount = selectedEntries.length;

  const seen = new Set();
  const selectedStories = [];

  for (const entry of selectedEntries) {
    const storyId = asString(entry?.storyId);
    if (!storyId) continue;

    if (seen.has(storyId)) {
      summary.duplicateCount += 1;
      warnings.push({ code: "duplicate-selected-story", storyId });
      continue;
    }
    seen.add(storyId);

    const story = storyById.get(storyId);
    if (!story) {
      summary.missingCount += 1;
      warnings.push({ code: "selected-story-not-found", storyId });
      continue;
    }

    selectedStories.push({
      storyId,
      position: asNumber(entry.position),
      section: asString(entry.section) || null,
      rank: asNumber(entry.rank),
      score: asNumber(entry.score),
      story,
    });
  }

  summary.resolvedCount = selectedStories.length;
  warnings.sort((a, b) => {
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    return asString(a.storyId).localeCompare(asString(b.storyId));
  });

  return {
    ok: true,
    mode: "edition",
    error: null,
    selectedStories,
    warnings,
    summary,
  };
}

/**
 * Build stories payload for Writer. Preserves selection order.
 * Sets __preserveStoryOrder so Writer does not re-pick by Brief evidence alone.
 */
function toWriterStoriesInput(selectionResult, originalStoriesInput = null) {
  const stories = (selectionResult?.selectedStories || []).map(
    (item) => item.story
  );
  const base =
    originalStoriesInput &&
    typeof originalStoriesInput === "object" &&
    !Array.isArray(originalStoriesInput)
      ? { ...originalStoriesInput }
      : {};
  return {
    ...base,
    stories,
    __preserveStoryOrder: true,
    __writerSelection: {
      mode: selectionResult?.mode || "edition",
      summary: selectionResult?.summary || emptySummary(),
      warnings: selectionResult?.warnings || [],
      editionContext: (selectionResult?.selectedStories || []).map((item) => ({
        storyId: item.storyId,
        position: item.position,
        section: item.section,
        rank: item.rank,
        score: item.score,
      })),
    },
  };
}

module.exports = {
  selectStoriesForWriter,
  toWriterStoriesInput,
  hasEditionSelected,
  compareSelectedEntries,
  extractStoriesList,
};
