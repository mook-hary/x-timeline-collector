const fs = require("fs");
const path = require("path");
const { getCategoryOrder } = require("./lib/categories");
const {
  pad2,
  parseDateOnly,
  resolveLocalDateRange,
  parsePostedAtMs,
} = require("./lib/date-range");
const {
  fail,
  ensureDir,
  readJsonArrayRequired,
  readJsonObjectOptional,
} = require("./lib/pipeline-io");
const {
  DEFAULT_DIGEST_CONFIG,
  getDigestCategory,
  getImportance,
  getCategoryWeight,
  getPersonalScore,
  mergeDisplayTags,
  mergeDigestConfig,
  sortPostsByImportance,
  buildDigestSelection,
} = require("./lib/digest-core");

const INPUT_FILE = path.join(__dirname, "output", "timeline_enriched.json");
const CONFIG_FILE = path.join(__dirname, "digest.config.json");

// Source of Truth: config/categories.json (key order)
const CATEGORY_ORDER = getCategoryOrder();

const OPTION_SPECS = {
  "--today": { type: "boolean", key: "today" },
  "--from": { type: "date", key: "from" },
  "--to": { type: "date", key: "to" },
  "--category": { type: "string", key: "category" },
  "--min-importance": { type: "integer", key: "minImportance" },
  "--top": { type: "integer", key: "top" },
  "--output": { type: "string", key: "output" },
  "--json": { type: "boolean", key: "json" },
  "--full": { type: "boolean", key: "full" },
  "--explain": { type: "boolean", key: "explain" },
  "--help": { type: "boolean", key: "help" },
  "-h": { type: "boolean", key: "help" },
};

function printHelp() {
  console.log(`x-timeline-collector ダイジェストツール

使い方:
  node digest.js [options]

オプション:
  --today                 今日（ローカル日付の 0:00:00〜23:59:59.999）を対象
  --from <YYYY-MM-DD>     指定日以降を対象（ローカル日付の 0:00:00）
  --to <YYYY-MM-DD>       指定日以前を対象（ローカル日付の 23:59:59.999 まで含む）
  --category <名前>       finalAnalysis.category の完全一致
  --min-importance <1-5>  enrichment.importance が指定値以上
  --top <件数>            注目投稿の上限件数（未指定時 5）
  --full                  カテゴリ別一覧を省略せず全件表示
  --output <パス>         Markdown または JSON をファイルへ保存
  --json                  構造化 JSON を出力
  --explain               選定理由・Digest 統計を表示（メタは保存しない）
  --help, -h              このヘルプを表示

注意:
  --today と --from / --to は併用できません。
  複数条件は AND です。
  注目投稿は personalScore（ユーザー関連度）順です。
  同一話題は topicCap（未設定時 1）で抑制し、不足時のみ topic 制約を緩和します。
  設定は digest.config.json を参照します。
  --explain なしの --json 出力構造は従来どおりです。

例:
  node digest.js --today
  node digest.js --from 2026-07-01 --to 2026-07-15 --top 10
  node digest.js --category AI --top 3
  node digest.js --min-importance 4 --top 5
  node digest.js --from 2026-07-14 --to 2026-07-15 --json
  node digest.js --from 2026-07-14 --to 2026-07-15 --explain
  node digest.js --today --explain --json
  node digest.js --full
  node digest.js --today --output output/digest_today.md
`);
}

function loadConfig() {
  const data = readJsonObjectOptional(CONFIG_FILE, null, "digest.config.json");
  if (data == null) {
    return mergeDigestConfig(DEFAULT_DIGEST_CONFIG);
  }
  return mergeDigestConfig(data);
}

function parseArgs(argv) {
  const options = {
    today: false,
    from: null,
    to: null,
    category: null,
    minImportance: null,
    top: 5,
    output: null,
    json: false,
    full: false,
    explain: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const spec = OPTION_SPECS[token];

    if (!spec) {
      fail(`未知のオプションです: ${token}\n使い方は node digest.js --help を参照してください。`);
    }

    if (spec.type === "boolean") {
      options[spec.key] = true;
      continue;
    }

    const value = argv[i + 1];
    if (value == null || value.startsWith("-")) {
      fail(`${token} には値が必要です。`);
    }
    i += 1;

    if (spec.type === "string") {
      options[spec.key] = value;
      continue;
    }

    if (spec.type === "date") {
      options[spec.key] = parseDateOnly(value, token, fail);
      continue;
    }

    if (spec.type === "integer") {
      if (!/^\d+$/.test(value)) {
        fail(`${token} には正の整数を指定してください。`);
      }
      const num = Number(value);
      if (!Number.isInteger(num) || num < 1) {
        fail(`${token} には正の整数を指定してください。`);
      }
      if (spec.key === "minImportance" && (num < 1 || num > 5)) {
        fail("--min-importance には 1 から 5 の整数を指定してください。");
      }
      options[spec.key] = num;
    }
  }

  if (options.today && (options.from || options.to)) {
    fail("--today と --from / --to は併用できません。");
  }

  return options;
}

function loadPosts() {
  return readJsonArrayRequired(INPUT_FILE, "入力ファイル");
}

function formatStars(importance) {
  const value = Number(importance);
  const filled = Number.isInteger(value) ? Math.min(5, Math.max(0, value)) : 0;
  return `${"★".repeat(filled)}${"☆".repeat(5 - filled)}`;
}

function formatPostedAt(value) {
  const ms = parsePostedAtMs(value);
  if (ms == null) return "(日時不明)";
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function normalizeSummary(post) {
  const summary = String(post.enrichment?.summary || "").trim();
  if (summary) {
    return summary.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n");
  }
  const text = String(post.text || "").trim();
  if (text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n");
  }
  return "要約なし";
}

function oneLineSummary(post) {
  return normalizeSummary(post).replace(/\s+/g, " ").trim();
}

function averageImportance(posts) {
  if (posts.length === 0) return 0;
  const sum = posts.reduce((acc, post) => acc + getImportance(post), 0);
  return Math.round((sum / posts.length) * 10) / 10;
}

function groupByCategory(posts) {
  const groups = new Map();

  for (const post of posts) {
    const category = getDigestCategory(post);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(post);
  }

  const known = CATEGORY_ORDER.filter((name) => groups.has(name));
  const unknown = [...groups.keys()]
    .filter((name) => !CATEGORY_ORDER.includes(name))
    .sort((a, b) => a.localeCompare(b, "ja"));

  return [...known, ...unknown].map((category) => {
    const categoryPosts = sortPostsByImportance(groups.get(category));
    return {
      category,
      count: categoryPosts.length,
      averageImportance: averageImportance(categoryPosts),
      posts: categoryPosts,
    };
  });
}

function toPostJson(post, config) {
  const category = getDigestCategory(post);
  return {
    authorName: post.authorName || "",
    authorHandle: post.authorHandle || "",
    postedAt: post.postedAt || "",
    text: post.text || "",
    url: post.url || "",
    category,
    importance: getImportance(post),
    personalScore: getPersonalScore(post, config),
    categoryWeight: getCategoryWeight(category, config),
    summary: normalizeSummary(post),
    reason: post.enrichment?.reason || "",
    tags: mergeDisplayTags(post),
  };
}

function buildDigest(posts, options, range, config) {
  const selection = buildDigestSelection(posts, options, range, config);
  const topPosts = selection.topSelected.map((item) => item.post);
  const categories = groupByCategory(selection.filtered);
  const displayLimit = options.full ? Number.POSITIVE_INFINITY : config.categoryDisplayLimit;

  return {
    generatedAt: new Date().toISOString(),
    range: range.rangeJson,
    total: selection.filtered.length,
    averageImportance: averageImportance(selection.filtered),
    settings: {
      topMinimumImportance: config.topMinimumImportance,
      topExcludedCategories: config.topExcludedCategories,
      maxPostsPerCategoryInTop: config.maxPostsPerCategoryInTop,
      maxPostsPerAuthorInTop: config.maxPostsPerAuthorInTop,
      categoryDisplayLimit: config.categoryDisplayLimit,
    },
    topPosts: topPosts.map((post) => toPostJson(post, config)),
    categories: categories.map((item) => {
      const displayed = item.posts.slice(0, displayLimit);
      return {
        category: item.category,
        count: item.count,
        totalPostCount: item.count,
        displayedPostCount: displayed.length,
        averageImportance: item.averageImportance,
        posts: displayed.map((post) => toPostJson(post, config)),
      };
    }),
    _rawTopPosts: topPosts,
    _topSelected: selection.topSelected,
    _selectionStats: selection.stats,
    _rawCategories: categories,
    _displayLimit: displayLimit,
    _labelFrom: range.labelFrom,
    _labelTo: range.labelTo,
    _rangeMode: range.mode,
    _config: config,
  };
}

function topSectionTitle(digest) {
  const count = digest._rawTopPosts.length;
  if (digest._rangeMode === "today") return `## 今日の注目投稿（${count}件）`;
  if (digest._rangeMode === "range") return `## この期間の注目投稿（${count}件）`;
  return `## 注目投稿（${count}件）`;
}

function renderSelectionExplain(selection) {
  const topic = selection.topicKey || "(none)";
  const authorUsage =
    selection.authorUsage == null ? "(n/a)" : String(selection.authorUsage);
  return (
    `- 選定: rank=${selection.selectedRank}` +
    ` score=${selection.personalScore}` +
    ` importance=${selection.importance}` +
    ` category=${selection.category}` +
    ` weight=${selection.categoryWeight}` +
    ` authorUsage=${authorUsage}` +
    ` topic=${topic}` +
    ` pass=${selection.selectionPass}` +
    ` topicRelaxed=${selection.topicCapRelaxed ? "yes" : "no"}\n`
  );
}

function renderSelectionSummary(stats, config) {
  const categoryParts = Object.entries(stats.categoryCounts)
    .map(([name, count]) => `${name}:${count}`)
    .join(", ");
  const topicParts = Object.entries(stats.topicCounts)
    .slice(0, 8)
    .map(([name, count]) => `${name}:${count}`)
    .join(", ");

  return (
    `## 選定サマリー\n\n` +
    `- 選定件数: ${stats.selectedCount} / 候補: ${stats.candidateCount}\n` +
    `- topicCap: ${config.topicCap}\n` +
    `- カテゴリ内訳: ${categoryParts || "(なし)"}\n` +
    `- topic 緩和採用: ${stats.topicRelaxedCount}\n` +
    `- topicKey なし: ${stats.missingTopicKeyCount}\n` +
    `- topics: ${topicParts || "(なし)"}\n`
  );
}

function renderPostMarkdown(post, heading, config, selection, explain) {
  const stars = formatStars(getImportance(post));
  const category = getDigestCategory(post);
  const summary = normalizeSummary(post);
  const authorName = post.authorName || "";
  const authorHandle = post.authorHandle || "@unknown";
  const tags = mergeDisplayTags(post);
  const reason = String(post.enrichment?.reason || "").trim() || "(なし)";
  const url = post.url || "(なし)";
  const tagsText = tags.length ? tags.join(", ") : "(なし)";
  const importance = getImportance(post);
  const personalScore = getPersonalScore(post, config);

  let body =
    `${heading} ${stars} ${category}\n\n` +
    `${summary}\n\n` +
    `- 投稿者: ${authorName} / ${authorHandle}\n` +
    `- 投稿日時: ${formatPostedAt(post.postedAt)}\n` +
    `- タグ: ${tagsText}\n` +
    `- 重要度: ${importance}\n` +
    `- 関連度: ${personalScore}\n` +
    `- 理由: ${reason}\n` +
    `- URL: ${url}\n`;

  if (explain && selection) {
    body += renderSelectionExplain(selection);
  }

  return body;
}

function renderMarkdown(digest, options) {
  if (digest.total === 0) {
    return (
      `# Xタイムライン・ダイジェスト\n\n` +
      `対象投稿: 0件\n\n` +
      `条件に一致する投稿はありませんでした。\n`
    );
  }

  const lines = [];
  lines.push("# Xタイムライン・ダイジェスト");
  lines.push("");

  if (digest._labelFrom || digest._labelTo) {
    const fromLabel = digest._labelFrom || "(開始指定なし)";
    const toLabel = digest._labelTo || "(終了指定なし)";
    lines.push(`対象期間: ${fromLabel} 〜 ${toLabel}`);
  } else {
    lines.push("対象期間: 全期間");
  }

  lines.push(`対象投稿: ${digest.total}件`);
  lines.push(`平均重要度: ${digest.averageImportance.toFixed(1)}`);
  lines.push("");

  if (options.explain) {
    lines.push(renderSelectionSummary(digest._selectionStats, digest._config).trimEnd());
    lines.push("");
  }

  lines.push(topSectionTitle(digest));
  lines.push("");

  if (digest._rawTopPosts.length === 0) {
    lines.push("基準を満たす注目投稿はありませんでした。");
    lines.push("");
  } else {
    digest._topSelected.forEach((item, index) => {
      lines.push(
        renderPostMarkdown(
          item.post,
          `### ${index + 1}.`,
          digest._config,
          item.selection,
          options.explain
        ).trimEnd()
      );
      lines.push("");
    });
  }

  lines.push("## カテゴリ別サマリー");
  lines.push("");
  lines.push("| カテゴリ | 件数 | 平均重要度 |");
  lines.push("|---|---:|---:|");
  for (const item of digest._rawCategories) {
    lines.push(
      `| ${item.category} | ${item.count} | ${item.averageImportance.toFixed(1)} |`
    );
  }
  lines.push("");

  for (const item of digest._rawCategories) {
    lines.push(`## ${item.category}（${item.count}件）`);
    lines.push("");

    const displayed = item.posts.slice(0, digest._displayLimit);
    for (const post of displayed) {
      const stars = formatStars(getImportance(post));
      const summary = oneLineSummary(post);
      const authorName = post.authorName || "";
      const authorHandle = post.authorHandle || "@unknown";
      const tags = mergeDisplayTags(post);
      const url = post.url || "(なし)";

      lines.push(`### ${stars} ${summary}`);
      lines.push("");
      lines.push(`- 投稿者: ${authorName} / ${authorHandle}`);
      lines.push(`- 投稿日時: ${formatPostedAt(post.postedAt)}`);
      lines.push(`- タグ: ${tags.length ? tags.join(", ") : "(なし)"}`);
      lines.push(`- URL: ${url}`);
      lines.push("");
    }

    const remaining = item.count - displayed.length;
    if (remaining > 0) {
      lines.push(`ほか ${remaining}件`);
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function toPublicJson(digest) {
  return {
    generatedAt: digest.generatedAt,
    range: digest.range,
    total: digest.total,
    averageImportance: digest.averageImportance,
    settings: digest.settings,
    topPosts: digest.topPosts,
    categories: digest.categories,
  };
}

function toExplainJson(digest) {
  return {
    ...toPublicJson(digest),
    topPosts: digest._topSelected.map((item) => ({
      post: toPostJson(item.post, digest._config),
      selection: item.selection,
    })),
    selectionStats: digest._selectionStats,
    topicCap: digest._config.topicCap,
  };
}

function writeOutput(filePath, content) {
  try {
    ensureDir(path.dirname(path.resolve(filePath)));
    fs.writeFileSync(filePath, content, "utf8");
  } catch (error) {
    fail(`出力ファイルの書き込みに失敗しました: ${error.message}`);
  }
  console.log(`保存先: ${path.resolve(filePath)}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const range = resolveLocalDateRange(options, fail);
  const posts = loadPosts();
  const digest = buildDigest(posts, options, range, config);

  if (options.json) {
    const payload = options.explain ? toExplainJson(digest) : toPublicJson(digest);
    const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
    if (options.output) {
      writeOutput(options.output, jsonText);
    } else {
      process.stdout.write(jsonText);
    }
    return;
  }

  const markdown = renderMarkdown(digest, options);
  if (options.output) {
    writeOutput(options.output, markdown);
  } else {
    process.stdout.write(markdown);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildDigest,
  loadConfig,
  parseArgs,
};
