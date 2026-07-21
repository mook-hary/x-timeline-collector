const path = require("path");
const {
  parseDateOnly,
  resolveLocalDateRange,
  parsePostedAtMs,
} = require("./lib/date-range");
const { fail, readJsonArrayRequired } = require("./lib/pipeline-io");
const { getCategoryOrder } = require("./lib/categories");
const {
  getSearchCategory,
  getSearchableTags,
  splitTextTerms,
  normalizeSearchOptions,
  searchPosts,
} = require("./lib/search-core");

const INPUT_FILE = path.join(__dirname, "output", "timeline_enriched.json");

const OPTION_SPECS = {
  "--category": { type: "string", key: "category", multi: true },
  "--importance": { type: "integer", key: "importance" },
  "--tag": { type: "string", key: "tag", multi: true },
  "--author": { type: "string", key: "author" },
  "--text": { type: "string", key: "text" },
  "--from": { type: "date", key: "from" },
  "--to": { type: "date", key: "to" },
  "--limit": { type: "integer", key: "limit" },
  "--json": { type: "boolean", key: "json" },
  "--explain": { type: "boolean", key: "explain" },
  "--help": { type: "boolean", key: "help" },
  "-h": { type: "boolean", key: "help" },
};

function printHelp() {
  console.log(`x-timeline-collector 検索ツール

使い方:
  node search.js [options]

オプション:
  --category <名前>     カテゴリ完全一致（複数指定時は OR。categories.json で検証）
  --importance <1-5>    enrichment.importance が指定値以上
  --tag <語>            タグ部分一致（複数指定時は AND。大小無視）
  --author <語>         authorName / authorHandle を部分一致（大小無視）
  --text <語...>        空白区切り語を AND（大小無視）
  --from <YYYY-MM-DD>   postedAt が指定日以降（ローカル日付の 0:00:00）
  --to <YYYY-MM-DD>     postedAt が指定日以前（ローカル日付の 23:59:59.999 まで含む）
  --limit <件数>        表示件数の上限（正の整数）
  --json                検索結果を JSON で標準出力
  --explain             一致理由を表示（JSON 時は { post, match } ラッパー）
  --help, -h            このヘルプを表示

条件の種類をまたぐ結合は AND です。
  複数 --category … OR
  複数 --tag … AND
  --text の複数語 … AND
日付は実行環境のローカル日付です（digest.js と同じ境界）。
並び順: importance 降順 → postedAt 新しい順（空の postedAt は最後）

例:
  node search.js --category AI
  node search.js --category AI --category プログラミング・IT
  node search.js --tag AI --tag アニメ
  node search.js --text "OpenAI animation"
  node search.js --importance 4 --tag Cursor --explain
  node search.js --from 2026-07-01 --to 2026-07-15
  node search.js --category AI --json --limit 2
`);
}

function parseArgs(argv) {
  const options = {
    categories: [],
    tags: [],
    importance: null,
    author: null,
    text: null,
    from: null,
    to: null,
    limit: null,
    json: false,
    explain: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const spec = OPTION_SPECS[token];

    if (!spec) {
      fail(`未知のオプションです: ${token}\n使い方は node search.js --help を参照してください。`);
    }

    if (spec.type === "boolean") {
      options[spec.key] = true;
      continue;
    }

    const value = argv[i + 1];
    if (value == null || value.startsWith("--") || value === "-h") {
      fail(`${token} には値が必要です。`);
    }
    i += 1;

    if (spec.type === "string") {
      if (spec.multi && spec.key === "category") {
        options.categories.push(value);
      } else if (spec.multi && spec.key === "tag") {
        options.tags.push(value);
      } else {
        options[spec.key] = value;
      }
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
      if (spec.key === "importance" && (num < 1 || num > 5)) {
        fail("--importance には 1 から 5 の整数を指定してください。");
      }
      options[spec.key] = num;
    }
  }

  if (options.from || options.to) {
    resolveLocalDateRange(
      { today: false, from: options.from, to: options.to },
      fail
    );
  }

  if (options.categories.length > 0) {
    const allowed = new Set(getCategoryOrder());
    for (const category of options.categories) {
      if (!allowed.has(category)) {
        fail(
          `未知のカテゴリです: ${category}\n` +
            `利用可能: ${[...allowed].join(", ")}`
        );
      }
    }
  }

  return options;
}

function loadPosts() {
  return readJsonArrayRequired(INPUT_FILE, "検索対象ファイル");
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
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatExplainLines(match, query) {
  const lines = [];
  lines.push(`  category: ${match.category}`);
  lines.push(
    `  importance: ${match.importance == null ? "(なし)" : match.importance}`
  );
  if (query.textTerms.length > 0) {
    lines.push(
      `  matched text: ${
        match.textTerms.length ? match.textTerms.join(", ") : "(なし)"
      }`
    );
  }
  if (query.tags.length > 0) {
    lines.push(
      `  matched tags: ${match.tags.length ? match.tags.join(", ") : "(なし)"}`
    );
  }
  if (query.author != null) {
    lines.push(`  matched author: ${match.author ? "yes" : "no"}`);
  }
  if (query.range && query.range.hasRange) {
    lines.push(`  date passed: ${match.datePassed ? "yes" : "no"}`);
  }
  return lines.join("\n");
}

function formatPost(post, index, query, match) {
  const category = getSearchCategory(post);
  const importance = post.enrichment?.importance;
  const summary =
    (post.enrichment?.summary && String(post.enrichment.summary).trim()) ||
    (post.text || "");
  const { humanTags, keywordTags } = getSearchableTags(post);
  const authorName = post.authorName || "";
  const authorHandle = post.authorHandle || "@unknown";

  let body =
    `[${index}] ${formatStars(importance)} ${category}\n` +
    `${formatPostedAt(post.postedAt)}\n` +
    `${authorName} / ${authorHandle}\n` +
    `\n` +
    `${summary}\n` +
    `\n` +
    `Tags: ${humanTags.length ? humanTags.join(", ") : "(なし)"}\n`;

  if (query.explain && keywordTags.length > 0) {
    body += `Keywords: ${keywordTags.join(", ")}\n`;
  }

  body += `${post.url || "(URLなし)"}\n`;

  if (query.explain && match) {
    body += `\nMatch:\n${formatExplainLines(match, query)}\n`;
  }

  return body;
}

function printNormal(results, query) {
  console.log("========================================");
  console.log(`検索結果: ${results.length}件`);
  console.log("========================================");
  console.log("");

  if (results.length === 0) {
    console.log("条件に一致する投稿はありません。");
    return;
  }

  for (let i = 0; i < results.length; i++) {
    const { post, match } = results[i];
    console.log(formatPost(post, i + 1, query, match));
    console.log("----------------------------------------");
    console.log("");
  }
}

function main() {
  const rawOptions = parseArgs(process.argv.slice(2));

  if (rawOptions.help) {
    printHelp();
    return;
  }

  const posts = loadPosts();
  const range = resolveLocalDateRange(
    { today: false, from: rawOptions.from, to: rawOptions.to },
    fail
  );
  const query = normalizeSearchOptions(
    {
      categories: rawOptions.categories,
      tags: rawOptions.tags,
      text: rawOptions.text,
      textTerms: splitTextTerms(rawOptions.text),
      author: rawOptions.author,
      importance: rawOptions.importance,
      explain: rawOptions.explain,
      limit: rawOptions.limit,
    },
    range
  );

  const results = searchPosts(posts, query);

  if (rawOptions.json) {
    if (rawOptions.explain) {
      const payload = results.map(({ post, match }) => ({ post, match }));
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${JSON.stringify(
          results.map(({ post }) => post),
          null,
          2
        )}\n`
      );
    }
    return;
  }

  printNormal(results, query);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  getSearchCategory,
  getSearchableTags,
  splitTextTerms,
  normalizeSearchOptions,
  searchPosts,
};
