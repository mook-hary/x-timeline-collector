const path = require("path");
const {
  pad2,
  parseDateOnly,
  resolveLocalDateRange,
  parsePostedAtMs,
} = require("./lib/date-range");
const { fail, readJsonArrayRequired } = require("./lib/pipeline-io");
const {
  getImportance,
  buildPostSummary,
  buildEditorView,
} = require("./lib/editor-core");

const INPUT_FILE = path.join(__dirname, "output", "timeline_enriched.json");

const OPTION_SPECS = {
  "--today": { type: "boolean", key: "today" },
  "--from": { type: "date", key: "from" },
  "--to": { type: "date", key: "to" },
  "--category": { type: "string", key: "category" },
  "--limit": { type: "integer", key: "limit" },
  "--json": { type: "boolean", key: "json" },
  "--help": { type: "boolean", key: "help" },
  "-h": { type: "boolean", key: "help" },
};

function printHelp() {
  console.log(`x-timeline-collector Editor（編集ビュー）

使い方:
  node editor.js [options]

役割:
  Reporter（収集）→ Editor（Topic 単位で整理して読む）

オプション:
  --today                 今日（ローカル日付の 0:00:00〜23:59:59.999）を対象
  --from <YYYY-MM-DD>     指定日以降を対象（ローカル日付の 0:00:00）
  --to <YYYY-MM-DD>       指定日以前を対象（ローカル日付の 23:59:59.999 まで含む）
  --category <名前>       カテゴリ完全一致（互換フォールバックあり）
  --limit <件数>          表示する Topic 数の上限（正の整数）
  --json                  Topic 配列を JSON で標準出力
  --help, -h              このヘルプを表示

注意:
  --today と --from / --to は併用できません。
  日付契約は search.js と同じ（postedAt・ローカル日付境界）です。
  Topic Key は Digest と同じ契約です（永続 Identity ではありません）。
  正式入力は output/timeline_enriched.json です。

例:
  node editor.js --today
  node editor.js --from 2026-07-01 --to 2026-07-15
  node editor.js --category AI --limit 10
  node editor.js --today --json
`);
}

function parseArgs(argv) {
  const options = {
    today: false,
    from: null,
    to: null,
    category: null,
    limit: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const spec = OPTION_SPECS[token];

    if (!spec) {
      fail(`未知のオプションです: ${token}\n使い方は node editor.js --help を参照してください。`);
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

function formatPostedAt(value) {
  const ms = parsePostedAtMs(value);
  if (ms == null) return "(日時不明)";
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatStars(importance) {
  const value = Number(importance);
  const filled = Number.isInteger(value) ? Math.min(5, Math.max(0, value)) : 0;
  return `${"★".repeat(filled)}${"☆".repeat(5 - filled)}`;
}

function oneLine(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderTopic(topic) {
  const lines = [];
  lines.push("=================");
  lines.push("Topic");
  lines.push(topic.topicKey);
  lines.push("");
  lines.push("Category");
  lines.push(topic.category);
  lines.push("");
  lines.push("Tags");
  lines.push(topic.tags.length ? topic.tags.join(", ") : "(none)");
  lines.push("");
  lines.push("Posts");
  lines.push(String(topic.postCount));
  lines.push("");
  lines.push("Importance");
  lines.push(`max ${topic.maxImportance} / avg ${topic.averageImportance.toFixed(1)}`);
  lines.push("");
  lines.push("Latest");
  lines.push(formatPostedAt(topic.newestPostedAt));
  lines.push("");
  lines.push("Summary");
  lines.push(topic.summary);
  lines.push("");
  lines.push("↓");
  lines.push("投稿一覧");
  lines.push("");

  topic.posts.forEach((post, index) => {
    const importance = getImportance(post);
    const authorHandle = post.authorHandle || "@unknown";
    const authorName = post.authorName || "";
    const summary = oneLine(buildPostSummary(post));
    const url = post.url || "(なし)";
    lines.push(
      `${index + 1}. ${formatStars(importance)} ${authorName} / ${authorHandle}`
    );
    lines.push(`   ${summary}`);
    lines.push(`   ${formatPostedAt(post.postedAt)} | ${url}`);
    lines.push("");
  });

  lines.push("=================");
  return lines.join("\n");
}

function renderText(view, range) {
  const lines = [];
  lines.push("# Editor View");
  lines.push("");

  if (range.labelFrom || range.labelTo) {
    const fromLabel = range.labelFrom || "(開始指定なし)";
    const toLabel = range.labelTo || "(終了指定なし)";
    lines.push(`対象期間: ${fromLabel} 〜 ${toLabel}`);
  } else {
    lines.push("対象期間: 全期間");
  }

  lines.push(`投稿: ${view.totalPosts}件 / Topic: ${view.totalTopics}件（表示 ${view.topics.length}件）`);
  lines.push("");

  if (view.topics.length === 0) {
    lines.push("条件に一致する Topic はありませんでした。");
    lines.push("");
    return `${lines.join("\n")}`;
  }

  for (const topic of view.topics) {
    lines.push(renderTopic(topic));
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function toPublicJson(view, range) {
  return {
    generatedAt: new Date().toISOString(),
    range: range.rangeJson,
    totalPosts: view.totalPosts,
    totalTopics: view.totalTopics,
    topics: view.topics,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const range = resolveLocalDateRange(options, fail);
  const posts = loadPosts();
  const view = buildEditorView(
    posts,
    {
      category: options.category,
      limit: options.limit,
    },
    range
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(toPublicJson(view, range), null, 2)}\n`);
    return;
  }

  process.stdout.write(renderText(view, range));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  renderText,
  toPublicJson,
};
