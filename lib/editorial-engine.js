/**
 * EP-054 — Editorial Engine.
 * High-level facade over Store / Workflow / Similarity / Rules / Ranking.
 * Does not reimplement low-level logic; does not mutate workflow automatically.
 */
const { createEditorialStore } = require("./editorial-store");
const { getDefaultRules } = require("./editorial-rules");
const {
  getDefaultRankingWeights,
  calculateRanking,
} = require("./editorial-ranking");

/**
 * @param {object} [options]
 * @param {string} [options.directory] editorial JSON directory
 * @param {string} [options.rootDir] project root (default cwd) when directory omitted
 * @param {object[]} [options.rules]
 * @param {object} [options.rankingWeights]
 * @param {function} [options.now] () => Date|string|number
 * @param {object} [options.deps]
 */
function createEditorialEngine(options = {}) {
  const defaultRules =
    options.rules != null ? options.rules : getDefaultRules();
  const defaultWeights =
    options.rankingWeights != null
      ? options.rankingWeights
      : getDefaultRankingWeights();
  const nowFn = typeof options.now === "function" ? options.now : null;

  const store = createEditorialStore({
    rootDir: options.rootDir,
    directory: options.directory,
    now: nowFn || undefined,
    deps: options.deps,
  });

  function resolveNow(callOptions = {}) {
    if (callOptions.now != null) {
      const v = callOptions.now;
      return typeof v === "function" ? v() : v;
    }
    if (nowFn) return nowFn();
    return new Date().toISOString();
  }

  function resolveRules(callOptions = {}) {
    return callOptions.rules != null ? callOptions.rules : defaultRules;
  }

  function resolveWeights(callOptions = {}) {
    return callOptions.weights != null ? callOptions.weights : defaultWeights;
  }

  function filterItems(items, callOptions = {}) {
    let list = Array.isArray(items) ? items.slice() : [];
    if (callOptions.source != null && String(callOptions.source).trim()) {
      const source = String(callOptions.source).trim();
      list = list.filter((item) => item && item.source === source);
    }
    if (callOptions.type != null && String(callOptions.type).trim()) {
      const type = String(callOptions.type).trim();
      list = list.filter((item) => item && item.type === type);
    }
    return list;
  }

  function applyLimit(rows, callOptions = {}) {
    if (callOptions.limit == null) return rows;
    const limit = Number(callOptions.limit);
    if (!Number.isInteger(limit) || limit < 0) {
      const err = new Error("limit must be a non-negative integer");
      err.code = "editorial-engine-options";
      throw err;
    }
    return rows.slice(0, limit);
  }

  function sortByRankingScore(rows) {
    rows.sort((a, b) => {
      const sa = a.ranking && a.ranking.score != null ? a.ranking.score : 0;
      const sb = b.ranking && b.ranking.score != null ? b.ranking.score : 0;
      if (sa !== sb) return sb - sa;
      const ua = String((a.item && a.item.updatedAt) || "");
      const ub = String((b.item && b.item.updatedAt) || "");
      if (ua !== ub) return ub < ua ? -1 : 1;
      return String((a.item && a.item.id) || "").localeCompare(
        String((b.item && b.item.id) || "")
      );
    });
    return rows;
  }

  function enrichItem(item, callOptions = {}, extraContext = {}) {
    const rules = resolveRules(callOptions);
    const weights = resolveWeights(callOptions);
    const now = resolveNow(callOptions);
    const evaluation = store.evaluateItem(item, {
      rules,
      context: { ...extraContext },
      includeSimilarity: true,
      similarityOptions: callOptions.similarityOptions,
    });
    const ranking = calculateRanking(item, {
      evaluation,
      maxSimilarity:
        evaluation.context && evaluation.context.maxSimilarity != null
          ? evaluation.context.maxSimilarity
          : undefined,
      now,
      weights,
    });
    return {
      item,
      evaluation,
      similarItems: evaluation.similarItems || [],
      ranking,
    };
  }

  function create(item) {
    return store.create(item);
  }

  function update(id, patch) {
    return store.update(id, patch);
  }

  function find(id) {
    return store.find(id);
  }

  function transition(id, nextStatus, transitionOptions) {
    return store.transition(id, nextStatus, transitionOptions);
  }

  function evaluate(id, callOptions = {}) {
    return store.evaluate(id, {
      ...callOptions,
      rules: resolveRules(callOptions),
    });
  }

  function rank(callOptions = {}) {
    return store.rank({
      ...callOptions,
      rules: resolveRules(callOptions),
      weights: resolveWeights(callOptions),
      now: resolveNow(callOptions),
    });
  }

  /**
   * Review queue: status=review, with evaluation + similarity + ranking.
   */
  function getReviewQueue(callOptions = {}) {
    const items = filterItems(store.listByStatus("review"), callOptions);
    const rows = items.map((item) => enrichItem(item, callOptions));
    sortByRankingScore(rows);
    return applyLimit(rows, callOptions);
  }

  /**
   * Publish candidates: approved + due scheduled.
   * Items with rule errors are excluded (unless includeRejected).
   * Does not change workflow status.
   */
  function getPublishCandidates(callOptions = {}) {
    const now = resolveNow(callOptions);
    const approved = filterItems(store.listByStatus("approved"), callOptions);
    const dueScheduled = filterItems(
      store.listReadyToPublish(now),
      callOptions
    );

    const seen = new Set();
    const pool = [];
    for (const item of [...approved, ...dueScheduled]) {
      if (!item || item.id == null) continue;
      const id = String(item.id);
      if (seen.has(id)) continue;
      seen.add(id);
      pool.push(item);
    }

    const candidates = [];
    const rejected = [];
    for (const item of pool) {
      const row = enrichItem(item, callOptions, { operation: "publish" });
      if (row.evaluation && row.evaluation.passed === false) {
        rejected.push(row);
      } else {
        candidates.push(row);
      }
    }

    sortByRankingScore(candidates);
    sortByRankingScore(rejected);

    const limitedCandidates = applyLimit(candidates, callOptions);

    if (callOptions.includeRejected === true) {
      return { candidates: limitedCandidates, rejected };
    }
    return limitedCandidates;
  }

  /**
   * Ops dashboard summary.
   */
  function getDashboard(callOptions = {}) {
    const now = resolveNow(callOptions);
    const generatedAt =
      now instanceof Date
        ? now.toISOString()
        : typeof now === "number"
          ? new Date(now).toISOString()
          : String(now);

    const items = filterItems(store.list(), callOptions);
    const totals = {
      all: items.length,
      draft: 0,
      review: 0,
      approved: 0,
      scheduled: 0,
      published: 0,
      archived: 0,
    };
    for (const item of items) {
      const status = item && item.status;
      if (status && Object.prototype.hasOwnProperty.call(totals, status)) {
        totals[status] += 1;
      }
    }

    const readyToPublish = filterItems(
      store.listReadyToPublish(now),
      callOptions
    ).length;
    const reviewQueue = totals.review;

    const ruleFailures = { error: 0, warning: 0, info: 0 };
    const rankingScores = [];
    const rules = resolveRules(callOptions);
    const weights = resolveWeights(callOptions);

    for (const item of items) {
      const evaluation = store.evaluateItem(item, {
        rules,
        includeSimilarity: true,
        similarityOptions: callOptions.similarityOptions,
      });
      ruleFailures.error += Number(evaluation.counts.error) || 0;
      ruleFailures.warning += Number(evaluation.counts.warning) || 0;
      ruleFailures.info += Number(evaluation.counts.info) || 0;

      const ranking = calculateRanking(item, {
        evaluation,
        maxSimilarity:
          evaluation.context && evaluation.context.maxSimilarity != null
            ? evaluation.context.maxSimilarity
            : undefined,
        now,
        weights,
      });
      rankingScores.push(ranking.score);
    }

    const averageRankingScore =
      rankingScores.length === 0
        ? null
        : Math.round(
            (rankingScores.reduce((a, b) => a + b, 0) / rankingScores.length) *
              100
          ) / 100;

    const topLimit =
      callOptions.topLimit == null ? 5 : Number(callOptions.topLimit);
    if (!Number.isInteger(topLimit) || topLimit < 0) {
      const err = new Error("topLimit must be a non-negative integer");
      err.code = "editorial-engine-options";
      throw err;
    }

    const topCandidates = getPublishCandidates({
      ...callOptions,
      limit: topLimit,
      includeRejected: false,
    });

    return {
      generatedAt,
      totals,
      readyToPublish,
      reviewQueue,
      ruleFailures,
      averageRankingScore,
      topCandidates,
    };
  }

  return {
    store,
    directory: store.storeDir,
    create,
    update,
    find,
    transition,
    evaluate,
    rank,
    getReviewQueue,
    getPublishCandidates,
    getDashboard,
  };
}

module.exports = {
  createEditorialEngine,
};
