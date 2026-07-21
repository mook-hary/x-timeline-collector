const fs = require("fs");
const path = require("path");
const {
  pad2,
  parseDateOnly,
  resolveLocalDateRange,
  parsePostedAtMs,
} = require("./lib/date-range");
const { fail, readJsonArrayRequired, writeJsonAtomic } = require("./lib/pipeline-io");
const {
  getImportance,
  buildPostSummary,
  buildEditorView,
} = require("./lib/editor-core");
const {
  buildEditorDecisions,
  mergeDecisionsIntoEditorView,
} = require("./lib/editor-decision");
const {
  buildEditorRanking,
  mergeRankingIntoEditorView,
} = require("./lib/editor-ranking");

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
  node editor.js decide --stories <path> --brief <path> [options]
  node editor.js rank --stories <path> --brief <path> --editor <path> [options]

役割:
  Reporter（収集）→ Editor（Topic 単位で整理して読む）
  decide: Story / Editorial / Knowledge から掲載可否（accept|hold|reject）を判定
  rank: accept のみを決定論的に順位付け（ranking[]）。紙面構成・掲載制御はしない

オプション（view）:
  --today                 今日（ローカル日付の 0:00:00〜23:59:59.999）を対象
  --from <YYYY-MM-DD>     指定日以降を対象（ローカル日付の 0:00:00）
  --to <YYYY-MM-DD>       指定日以前を対象（ローカル日付の 23:59:59.999 まで含む）
  --category <名前>       カテゴリ完全一致（互換フォールバックあり）
  --limit <件数>          表示する Topic 数の上限（正の整数）
  --json                  Topic 配列を JSON で標準出力
  --help, -h              このヘルプを表示

オプション（decide / rank）:
  --stories <path>        stories.js --json 相当
  --brief <path>          Brief JSON（editorial + knowledge を含む）
  --knowledge <path>      Knowledge 配列 JSON（任意。未指定時は Brief.knowledge）
  --editor <path>         既存 editor.json（decide: topics 維持 / rank: decisions 必須）
  --output <path>         結果 JSON を保存（任意）
  --json                  JSON を標準出力（decide/rank では既定）

注意:
  --today と --from / --to は併用できません。
  日付契約は search.js と同じ（postedAt・ローカル日付境界）です。
  Topic Key は Digest と同じ契約です（永続 Identity ではありません）。
  正式入力は output/timeline_enriched.json です。
  decide / rank は既存 topics / decisions を削除しません。

例:
  node editor.js --today
  node editor.js --from 2026-07-01 --to 2026-07-15
  node editor.js --category AI --limit 10
  node editor.js --today --json
  node editor.js decide --stories stories.json --brief brief.json --output editor.json
  node editor.js rank --stories stories.json --brief brief.json --editor editor.json --output editor.json
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

function readJsonFile(filePath, label) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    fail(`${label} が見つかりません: ${resolved}`);
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (err) {
    fail(`${label} の JSON を読めません: ${err.message}`);
  }
}

function parseDecideArgs(argv) {
  const options = {
    stories: null,
    brief: null,
    knowledge: null,
    editor: null,
    output: null,
    json: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    const map = {
      "--stories": "stories",
      "--brief": "brief",
      "--knowledge": "knowledge",
      "--editor": "editor",
      "--output": "output",
    };
    const key = map[token];
    if (!key) {
      fail(`未知のオプションです: ${token}\n使い方は node editor.js --help を参照してください。`);
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith("-")) {
      fail(`${token} には値が必要です。`);
    }
    i += 1;
    options[key] = value;
  }
  return options;
}

function runDecide(argv) {
  const options = parseDecideArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.stories) fail("decide には --stories が必要です。");
  if (!options.brief) fail("decide には --brief が必要です。");

  const stories = readJsonFile(options.stories, "stories");
  const brief = readJsonFile(options.brief, "brief");
  const knowledge = options.knowledge
    ? readJsonFile(options.knowledge, "knowledge")
    : brief.knowledge;

  const decisions = buildEditorDecisions({
    stories,
    editorial: brief,
    knowledge,
  });

  let payload = { decisions };
  if (options.editor) {
    const existing = readJsonFile(options.editor, "editor");
    payload = mergeDecisionsIntoEditorView(existing, decisions);
  }

  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (options.output) {
    writeJsonAtomic(path.resolve(options.output), payload);
  }
  if (options.json || !options.output) {
    process.stdout.write(text);
  }
}

function runRank(argv) {
  const options = parseDecideArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.stories) fail("rank には --stories が必要です。");
  if (!options.brief) fail("rank には --brief が必要です。");
  if (!options.editor) fail("rank には --editor が必要です（decisions を含む）。");

  const stories = readJsonFile(options.stories, "stories");
  const brief = readJsonFile(options.brief, "brief");
  const knowledge = options.knowledge
    ? readJsonFile(options.knowledge, "knowledge")
    : brief.knowledge;
  const existing = readJsonFile(options.editor, "editor");
  const decisions = Array.isArray(existing.decisions) ? existing.decisions : [];

  const ranking = buildEditorRanking({
    stories,
    editorial: brief,
    knowledge,
    decisions,
  });

  const payload = mergeRankingIntoEditorView(existing, ranking);

  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (options.output) {
    writeJsonAtomic(path.resolve(options.output), payload);
  }
  if (options.json || !options.output) {
    process.stdout.write(text);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "decide") {
    runDecide(argv.slice(1));
    return;
  }
  if (argv[0] === "rank") {
    runRank(argv.slice(1));
    return;
  }

  const options = parseArgs(argv);

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
  parseDecideArgs,
  renderText,
  toPublicJson,
  runDecide,
  runRank,
};
