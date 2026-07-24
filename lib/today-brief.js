/**
 * EP-029 / EP-038 — Deterministic Morning Brief (editorial paragraphs).
 * Pure functions only. No AI. No CSS.
 *
 * Returns up to 3 paragraph strings:
 * 1. Today's Theme
 * 2. Editorial View
 * 3. Reading Suggestion
 */

const { getCategory } = require("./editorial-score");

const WEAK_BRIEF_CATEGORIES = new Set(["その他", "広告・PR"]);

const TECH_CATEGORIES = new Set([
  "AI",
  "プログラミング・IT",
  "ゲーム・ゲーム開発",
]);
const CREATIVE_CATEGORIES = new Set([
  "アニメ・漫画",
  "イラスト・美術",
  "エンタメ・イベント",
]);
const SOCIETY_CATEGORIES = new Set(["政治・社会", "ニュース・報道"]);

const BRIEF_MIN_CHARS = 80;
const BRIEF_MAX_CHARS = 180;

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

function pickCountOf(picks) {
  if (Array.isArray(picks)) return picks.length;
  if (Number.isFinite(Number(picks))) return Math.max(0, Number(picks));
  return 0;
}

function charCount(text) {
  return Array.from(String(text || "")).length;
}

function totalChars(lines) {
  return charCount((Array.isArray(lines) ? lines : []).join(""));
}

/**
 * Legacy concise bullets (EP-029). Used as fallback.
 */
function buildLegacyBrief(posts, picks) {
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

  const pickCount = pickCountOf(picks);
  lines.push(`まず読む投稿を${pickCount}件選びました`);

  return lines.slice(0, 3);
}

/**
 * @param {{ category: string, count: number }} top
 * @param {{ category: string, count: number }|undefined} second
 * @param {number} total
 */
function buildThemeParagraph(top, second, total) {
  const share = total > 0 ? top.count / total : 0;

  if (share >= 0.5) {
    if (top.category === "AI") {
      return "今日はAI関連の動きが中心となり、技術の話題が目立つ一日でした。";
    }
    return `今日は${top.category}関連の投稿が中心となり、関心の方向がはっきりした一日でした。`;
  }

  if (second) {
    if (top.category === "AI") {
      return `AIの話題が多い一方、${second.category}に関する投稿も見られました。`;
    }
    return `${top.category}の話題が目立つ一方、${second.category}関連の投稿も多く見られました。`;
  }

  return `今日は${top.category}関連の投稿が続き、関心の厚みが印象的でした。`;
}

/**
 * @param {{ category: string, count: number }[]} ranked
 */
function buildEditorialParagraph(ranked) {
  const cats = ranked.map((r) => r.category);
  const set = new Set(cats);
  const hasTech = [...set].some((c) => TECH_CATEGORIES.has(c));
  const hasCreative = [...set].some((c) => CREATIVE_CATEGORIES.has(c));
  const hasSociety = [...set].some((c) => SOCIETY_CATEGORIES.has(c));

  if (hasTech && hasCreative) {
    return "技術の話題と制作・表現の話題が並び、効率化と現場感の両方に目が向く一日でした。";
  }
  if (hasTech && hasSociety) {
    return "技術動向と社会・報道の話題が交差し、出来事の背景を追う視点が印象的でした。";
  }
  if (hasCreative && hasSociety) {
    return "表現の話題と社会の動きが並び、文化と世相の両方に触れる投稿が目立ちました。";
  }
  if (hasTech) {
    return "共通して見られたのは実装や効率化の視点です。道具として使う動きが目立ちました。";
  }
  if (hasCreative) {
    return "表現や制作に関する投稿が続き、現場の空気が伝わる内容が印象的でした。";
  }
  if (hasSociety) {
    return "社会や報道に関する話題が続き、出来事の背景を追う投稿が目立ちました。";
  }
  if (cats.length >= 2) {
    return `${cats[0]}と${cats[1]}を併せて見ると、今日の関心の広がりが分かります。`;
  }
  return `${cats[0]}関連の投稿が続き、関心の厚みが印象的でした。`;
}

/**
 * @param {{ category: string, count: number }} top
 * @param {{ category: string, count: number }|undefined} second
 * @param {number} pickCount
 */
function buildReadingParagraph(top, second, pickCount) {
  if (pickCount > 0) {
    return "Today's Picksから読むだけで、今日の主要トピックはほぼ把握できます。";
  }
  if (second) {
    return `まず${top.category}関連を読み、次に${second.category}を見ると流れを掴みやすいでしょう。`;
  }
  return `${top.category}関連から読み進めると、今日の流れを把握しやすいでしょう。`;
}

function shortenEditorial(ranked) {
  const cats = ranked.map((r) => r.category);
  if (cats.length >= 2) {
    return `${cats[0]}と${cats[1]}が並び、関心の幅が印象的でした。`;
  }
  return `${cats[0]}関連の投稿が目立ちました。`;
}

function shortenReading(pickCount, top) {
  if (pickCount > 0) {
    return "Today's Picksから読むと要点を掴みやすいでしょう。";
  }
  return `${top.category}から読むと流れを掴みやすいでしょう。`;
}

/**
 * Build editorial Morning Brief (3 paragraphs). Deterministic. No AI.
 * Falls back to legacy concise brief when signal is thin.
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

  // Too few posts → keep legacy (insufficient editorial signal).
  if (list.length < 2) {
    return buildLegacyBrief(list, picks);
  }

  const ranked = selectBriefCategoryRanking(countCategoriesByPost(list));
  if (!ranked[0]) {
    return buildLegacyBrief(list, picks);
  }

  const top = ranked[0];
  const second = ranked[1];
  const pickCount = pickCountOf(picks);

  let theme = buildThemeParagraph(top, second, list.length);
  let view = buildEditorialParagraph(ranked.slice(0, 3));
  let reading = buildReadingParagraph(top, second, pickCount);

  let lines = [theme, view, reading];
  let len = totalChars(lines);

  // Trim toward 180 chars without dropping the 3-part structure.
  if (len > BRIEF_MAX_CHARS) {
    view = shortenEditorial(ranked.slice(0, 2));
    lines = [theme, view, reading];
    len = totalChars(lines);
  }
  if (len > BRIEF_MAX_CHARS) {
    reading = shortenReading(pickCount, top);
    lines = [theme, view, reading];
    len = totalChars(lines);
  }
  if (len > BRIEF_MAX_CHARS) {
    // Still too long → legacy fallback (shorter, still useful).
    return buildLegacyBrief(list, picks);
  }

  // Very short but structured is acceptable; legacy only if under-formed.
  if (len < BRIEF_MIN_CHARS && ranked.length < 2 && pickCount === 0) {
    return buildLegacyBrief(list, picks);
  }

  return lines;
}

module.exports = {
  WEAK_BRIEF_CATEGORIES,
  BRIEF_MIN_CHARS,
  BRIEF_MAX_CHARS,
  countCategoriesByPost,
  selectBriefCategoryRanking,
  buildLegacyBrief,
  buildTodayBrief,
};
