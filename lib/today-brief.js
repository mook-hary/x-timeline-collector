/**
 * EP-029 — Deterministic Today's Brief lines from classified posts.
 * Pure functions only. No AI.
 */

const { getCategory } = require("./editorial-score");

const WEAK_BRIEF_CATEGORIES = new Set(["その他", "広告・PR"]);

/**
 * @param {object[]} posts
 * @returns {{ category: string, count: number }[]}
 */
function countCategoriesByPost(posts) {
  const counts = new Map();
  for (const post of Array.isArray(posts) ? posts : []) {
    const category = getCategory(post);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.category.localeCompare(b.category, "ja");
    });
}

/**
 * Prefer non-weak categories when any major category exists.
 * @param {{ category: string, count: number }[]} ranked
 */
function selectBriefCategoryRanking(ranked) {
  const list = Array.isArray(ranked) ? ranked : [];
  const majors = list.filter((item) => !WEAK_BRIEF_CATEGORIES.has(item.category));
  if (majors.length > 0) return majors;
  return list;
}

/**
 * Build Today's Brief lines (max 3). Deterministic. No AI.
 *
 * @param {object[]} posts filter-applied posts
 * @param {object[]|number} picks Today's Picks array or count
 * @returns {string[]}
 */
function buildTodayBrief(posts, picks) {
  const list = Array.isArray(posts) ? posts : [];
  if (list.length === 0) {
    return ["条件に一致する投稿がありません"];
  }

  const ranked = selectBriefCategoryRanking(countCategoriesByPost(list));
  const lines = [];

  if (ranked[0]) {
    lines.push(`${ranked[0].category}関連の投稿が最も多い日です`);
  }
  if (ranked[1]) {
    lines.push(`${ranked[1].category}関連も多く流れています`);
  }

  const pickCount = Array.isArray(picks)
    ? picks.length
    : Number.isFinite(Number(picks))
      ? Math.max(0, Number(picks))
      : 0;
  lines.push(`まず読む投稿を${pickCount}件選びました`);

  return lines.slice(0, 3);
}

module.exports = {
  WEAK_BRIEF_CATEGORIES,
  countCategoriesByPost,
  selectBriefCategoryRanking,
  buildTodayBrief,
};
