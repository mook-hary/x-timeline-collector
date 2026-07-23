const fs = require("fs");
const path = require("path");
const {
  ensureDir,
  readJsonArrayRequired,
  readJsonObjectRequired,
  writeJsonAtomic,
} = require("./lib/pipeline-io");

const INPUT_FILE = path.join(__dirname, "output", "timeline.json");
const OUTPUT_FILE = path.join(__dirname, "output", "timeline_analyzed.json");
const UNCATEGORIZED_JSON = path.join(__dirname, "output", "uncategorized.json");
const UNCATEGORIZED_TXT = path.join(__dirname, "output", "uncategorized.txt");
const REVIEW_DIR = path.join(__dirname, "output", "review");
const LOW_CONFIDENCE_FILE = path.join(
  __dirname,
  "output",
  "review_low_confidence.txt"
);
const CATEGORIES_FILE = path.join(__dirname, "config", "categories.json");

function printHelp() {
  console.log(`x-timeline-collector Keyword Analyze (analyze.js)

Usage:
  node analyze.js
  node analyze.js --help
  npm run analyze

Options:
  --help, -h  Show this help (does not analyze)

Input:
  output/timeline.json
  config/categories.json

Output:
  output/timeline_analyzed.json
  output/uncategorized.json
  output/uncategorized.txt
  output/review/*.txt
  output/review_low_confidence.txt

API:
  None (OpenAI not used)

Chrome:
  Not required
`);
}

function parseAnalyzeArgs(argv) {
  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      return { help: true };
    }
    console.error(`不明なオプション: ${token}`);
    process.exit(1);
  }
  return { help: false };
}

function buildSearchText(post, category) {
  const fields =
    category === "広告・PR"
      ? [post.text, post.authorName, post.authorHandle]
      : [post.text, post.authorName, post.authorHandle, post.url];

  return fields
    .map((value) => (value == null ? "" : String(value)))
    .join("\n");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function needsWordBoundary(keyword) {
  const kw = String(keyword);
  // 1〜4文字の英字、または W杯 など指定の短い語
  if (/^[A-Za-z]{1,4}$/.test(kw)) return true;
  if (kw.toLowerCase() === "w杯") return true;
  return false;
}

function keywordMatches(text, keyword) {
  const kw = String(keyword);
  const textLower = text.toLowerCase();
  const kwLower = kw.toLowerCase();

  if (needsWordBoundary(kw)) {
    if (/^[A-Za-z]+$/.test(kw)) {
      // AI技術 → 一致, KcraftAIart → 不一致, NATO加盟 → 一致
      const re = new RegExp(
        `(?<![a-z])${escapeRegExp(kwLower)}(?![a-z])`,
        "i"
      );
      return re.test(textLower);
    }

    // W杯 など英字+日本語
    const re = new RegExp(`(?<![a-z])${escapeRegExp(kwLower)}`, "i");
    return re.test(textLower);
  }

  return textLower.includes(kwLower);
}

function getKeywords(categoryConfig) {
  if (!categoryConfig || typeof categoryConfig !== "object") return {};
  if (categoryConfig.keywords && typeof categoryConfig.keywords === "object") {
    return categoryConfig.keywords;
  }
  return {};
}

const STRONG_AD_KEYWORDS = new Set(
  [
    "プレゼント",
    "抽選",
    "クーポン",
    "キャンペーン",
    "無料券",
    "新規会員登録",
    "フォロー＆リポスト",
    "フォロー&リポスト",
    "商品紹介",
    "販売中",
  ].map((keyword) => keyword.toLowerCase())
);

function isAdEligible(matched, score) {
  const hasStrong = matched.some((item) =>
    STRONG_AD_KEYWORDS.has(String(item.keyword).toLowerCase())
  );
  if (hasStrong) return true;
  return score >= 4 && matched.length >= 2;
}

function getMinimumScore(categoryConfig) {
  if (!categoryConfig || typeof categoryConfig !== "object") return 0;
  const value = Number(categoryConfig.minimumScore);
  return Number.isFinite(value) ? value : 0;
}

function rankEligibleCategories(categories, categoryScores, categoryEligible, categoryMatched) {
  const ranked = [];

  for (const category of Object.keys(categories)) {
    if (category === "その他") continue;
    if (!categoryEligible[category]) continue;

    const score = categoryScores[category] || 0;
    if (score <= 0) continue;

    ranked.push({
      category,
      score,
      matched: categoryMatched[category] || [],
    });
  }

  // Score desc; ties keep categories.json order (stable sort)
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function computeConfidence(category, score, scoreMargin, tiedByOrder) {
  if (category === "その他") return "low";
  if (tiedByOrder) return "low";
  if (score >= 5 && scoreMargin >= 3) return "high";
  if (score >= 3 && scoreMargin >= 1) return "medium";
  return "low";
}

function classify(post, categories) {
  const categoryScores = {};
  const categoryMatched = {};
  const categoryEligible = {};

  for (const [category, config] of Object.entries(categories)) {
    if (category === "その他") {
      categoryScores[category] = 0;
      categoryMatched[category] = [];
      categoryEligible[category] = true;
      continue;
    }

    const keywords = getKeywords(config);
    const searchText = buildSearchText(post, category);
    let score = 0;
    const matched = [];
    const seen = new Set();

    for (const [keyword, weight] of Object.entries(keywords)) {
      const key = String(keyword).toLowerCase();
      if (seen.has(key)) continue;
      if (!keywordMatches(searchText, keyword)) continue;

      seen.add(key);
      const points = Number(weight) || 0;
      score += points;
      matched.push({ keyword, weight: points });
    }

    categoryScores[category] = score;
    categoryMatched[category] = matched;

    if (category === "広告・PR") {
      // 独自の広告採用条件を優先
      categoryEligible[category] = score > 0 && isAdEligible(matched, score);
    } else {
      const minimumScore = getMinimumScore(config);
      categoryEligible[category] = score >= minimumScore && score > 0;
    }
  }

  if (!("その他" in categoryScores)) {
    categoryScores["その他"] = 0;
    categoryEligible["その他"] = true;
  }

  const ranked = rankEligibleCategories(
    categories,
    categoryScores,
    categoryEligible,
    categoryMatched
  );

  if (ranked.length === 0) {
    return {
      category: "その他",
      score: 0,
      secondCategory: "",
      secondScore: 0,
      scoreMargin: 0,
      confidence: "low",
      tiedByOrder: false,
      categoryScores,
      matchedKeywords: [],
      categoryEligible,
    };
  }

  const first = ranked[0];
  const second = ranked[1] || null;
  const secondCategory = second ? second.category : "";
  const secondScore = second ? second.score : 0;
  const scoreMargin = first.score - secondScore;
  const tiedByOrder = Boolean(second && second.score === first.score);
  const confidence = computeConfidence(
    first.category,
    first.score,
    scoreMargin,
    tiedByOrder
  );

  return {
    category: first.category,
    score: first.score,
    secondCategory,
    secondScore,
    scoreMargin,
    confidence,
    tiedByOrder,
    categoryScores,
    matchedKeywords: first.matched,
    categoryEligible,
  };
}

function formatIneligibleNotes(categoryScores, categoryEligible, winner, categoryOrder) {
  const notes = [];

  for (const category of categoryOrder) {
    if (category === "その他" || category === winner) continue;
    const score = categoryScores[category] || 0;
    if (score <= 0) continue;
    if (categoryEligible[category] !== false) continue;

    if (category === "広告・PR") {
      notes.push(`広告・PRスコア: ${score}（採用条件未達）`);
    } else {
      notes.push(`${category}スコア: ${score}（最低採用スコア未達）`);
    }
  }

  return notes.length ? notes.join("\n") + "\n" : "";
}

function formatRunnerUpLabel(secondCategory, secondScore) {
  if (!secondCategory) return "なし";
  return `${secondCategory} ${secondScore}`;
}

function sortNewestFirst(posts) {
  return [...posts].sort((a, b) => {
    const aTime = Date.parse(a.postedAt || a.collectedAt || "") || 0;
    const bTime = Date.parse(b.postedAt || b.collectedAt || "") || 0;
    return bTime - aTime;
  });
}

function toUncategorizedEntry(post) {
  return {
    authorName: post.authorName || "",
    authorHandle: post.authorHandle || "",
    text: post.text || "",
    url: post.url || "",
    postedAt: post.postedAt || "",
  };
}

function toUncategorizedTxt(posts) {
  return (
    posts
      .map((post, index) => {
        const handle = post.authorHandle || "@unknown";
        const name = post.authorName || "";
        return (
          `[${index + 1}] ${handle} / ${name}\n` +
          `${post.text || ""}\n` +
          `${post.url || ""}\n` +
          "----------------------------------------"
        );
      })
      .join("\n") + (posts.length ? "\n" : "")
  );
}

function formatMatchedKeywords(matchedKeywords) {
  if (!matchedKeywords || matchedKeywords.length === 0) return "なし";
  return matchedKeywords
    .map((item) => `${item.keyword}(${item.weight})`)
    .join(", ");
}

function formatReviewEntry(post, index, categoryOrder) {
  const handle = post.authorHandle || "@unknown";
  const name = post.authorName || "";
  const analysis = post.analysis || {};
  const category = analysis.category || "その他";
  const score = analysis.score || 0;
  const secondCategory = analysis.secondCategory || "";
  const secondScore = analysis.secondScore || 0;
  const scoreMargin = analysis.scoreMargin || 0;
  const confidence = analysis.confidence || "low";
  const tiedByOrder =
    analysis.tiedByOrder ||
    (Boolean(secondCategory) && secondScore === score && category !== "その他");

  const ineligibleNotes = formatIneligibleNotes(
    analysis.categoryScores || {},
    analysis.categoryEligible || {},
    category,
    categoryOrder
  );

  const tieNote = tiedByOrder ? "判定: 同点のためカテゴリ順で決定\n" : "";

  return (
    `[${index + 1}] ${handle} / ${name}\n` +
    `分類: ${category}\n` +
    `スコア: ${score}\n` +
    `確信度: ${confidence}\n` +
    `次点: ${formatRunnerUpLabel(secondCategory, secondScore)}\n` +
    `判定差: ${scoreMargin}\n` +
    tieNote +
    ineligibleNotes +
    `一致キーワード: ${formatMatchedKeywords(analysis.matchedKeywords)}\n` +
    `${post.text || ""}\n` +
    `${post.url || ""}\n` +
    "----------------------------------------"
  );
}

function toReviewTxt(posts, categoryOrder) {
  return (
    posts.map((post, index) => formatReviewEntry(post, index, categoryOrder)).join(
      "\n"
    ) + (posts.length ? "\n" : "")
  );
}

function writeReviewFiles(analyzedPosts, categoryNames) {
  ensureDir(REVIEW_DIR);

  for (const file of fs.readdirSync(REVIEW_DIR)) {
    if (file.endsWith(".txt")) {
      fs.unlinkSync(path.join(REVIEW_DIR, file));
    }
  }

  for (const category of categoryNames) {
    const posts = sortNewestFirst(
      analyzedPosts.filter((post) => post.analysis.category === category)
    );
    const filePath = path.join(REVIEW_DIR, `${category}.txt`);
    fs.writeFileSync(filePath, toReviewTxt(posts, categoryNames), "utf8");
  }
}

function writeLowConfidenceFile(analyzedPosts, categoryNames) {
  const posts = sortNewestFirst(
    analyzedPosts.filter(
      (post) =>
        post.analysis.confidence === "low" || post.analysis.category === "その他"
    )
  );
  fs.writeFileSync(LOW_CONFIDENCE_FILE, toReviewTxt(posts, categoryNames), "utf8");
  return posts.length;
}

function main() {
  const cli = parseAnalyzeArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    return;
  }

  const categories = readJsonObjectRequired(CATEGORIES_FILE, "カテゴリ設定");
  const posts = readJsonArrayRequired(INPUT_FILE, "output/timeline.json");

  const analyzedAt = new Date().toISOString();
  const categoryNames = Object.keys(categories);
  const counts = {};
  const confidenceCounts = { high: 0, medium: 0, low: 0 };

  for (const category of categoryNames) {
    counts[category] = 0;
  }
  if (!("その他" in counts)) {
    counts["その他"] = 0;
    categoryNames.push("その他");
  }

  const analyzedPosts = posts.map((post) => {
    const {
      category,
      score,
      secondCategory,
      secondScore,
      scoreMargin,
      confidence,
      tiedByOrder,
      categoryScores,
      matchedKeywords,
      categoryEligible,
    } = classify(post, categories);

    counts[category] = (counts[category] || 0) + 1;
    confidenceCounts[confidence] = (confidenceCounts[confidence] || 0) + 1;

    return {
      ...post,
      analysis: {
        category,
        score,
        secondCategory,
        secondScore,
        scoreMargin,
        confidence,
        tiedByOrder,
        categoryScores,
        matchedKeywords,
        categoryEligible,
        analyzedAt,
      },
    };
  });

  const uncategorizedPosts = sortNewestFirst(
    analyzedPosts.filter((post) => post.analysis.category === "その他")
  ).map(toUncategorizedEntry);

  const allCategoryNames = Object.keys(counts);

  writeJsonAtomic(OUTPUT_FILE, analyzedPosts);
  writeJsonAtomic(UNCATEGORIZED_JSON, uncategorizedPosts);
  fs.writeFileSync(UNCATEGORIZED_TXT, toUncategorizedTxt(uncategorizedPosts), "utf8");
  writeReviewFiles(analyzedPosts, allCategoryNames);
  const lowConfidenceCount = writeLowConfidenceFile(analyzedPosts, allCategoryNames);

  console.log(`分析対象: ${posts.length} 件`);
  console.log("カテゴリ別件数:");
  for (const [category, count] of Object.entries(counts)) {
    console.log(`  ${category}: ${count}`);
  }
  console.log("確信度別件数:");
  for (const level of ["high", "medium", "low"]) {
    console.log(`  ${level}: ${confidenceCounts[level] || 0}`);
  }
  console.log(`保存先: ${OUTPUT_FILE}`);
  console.log(`その他一覧: ${uncategorizedPosts.length} 件`);
  console.log(`  JSON: ${UNCATEGORIZED_JSON}`);
  console.log(`  TXT: ${UNCATEGORIZED_TXT}`);
  console.log(`レビュー用: ${REVIEW_DIR}`);
  console.log(`低確信度レビュー: ${lowConfidenceCount} 件`);
  console.log(`  ${LOW_CONFIDENCE_FILE}`);
}

if (require.main === module) {
  main();
}
