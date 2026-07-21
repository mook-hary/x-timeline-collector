const path = require("path");
const {
  pad2,
  parseDateOnly,
  resolveLocalDateRange,
  parsePostedAtMs,
} = require("./lib/date-range");
const { fail, readJsonArrayRequired } = require("./lib/pipeline-io");
const { getCategoryOrder } = require("./lib/categories");
const { buildConceptLibrary } = require("./lib/concept-core");

const INPUT_FILE = path.join(__dirname, "output", "timeline_enriched.json");

const OPTION_SPECS = {
  "--today": { type: "boolean", key: "today" },
  "--from": { type: "date", key: "from" },
  "--to": { type: "date", key: "to" },
  "--category": { type: "string", key: "categories", multi: true },
  "--min-days": { type: "integer", key: "minDays" },
  "--min-topics": { type: "integer", key: "minTopics" },
  "--limit": { type: "integer", key: "limit" },
  "--json": { type: "boolean", key: "json" },
  "--explain": { type: "boolean", key: "explain" },
  "--help": { type: "boolean", key: "help" },
  "-h": { type: "boolean", key: "help" },
};

function printHelp() {
  console.log(`x-timeline-collector Concept Library

使い方:
  node concepts.js [options]

役割:
  Editor Topic → 時間をまたぐ継続テーマ（Concept）へ整理する派生ビュー。
  AI は使いません。投稿・Concept を永続保存しません。

オプション:
  --today                 今日（ローカル日付の 0:00:00〜23:59:59.999）を対象
  --from <YYYY-MM-DD>     指定日以降を対象（ローカル日付の 0:00:00）
  --to <YYYY-MM-DD>       指定日以前を対象（ローカル日付の 23:59:59.999 まで含む）
  --category <名前>       Concept 内に当該カテゴリの Topic/投稿が含まれる（複数指定は OR）
  --min-days <N>          activeDays が N 以上
  --min-topics <N>        topicCount が N 以上
  --limit <N>             表示する Concept 数の上限（フィルター・ソート後）
  --json                  Concept 配列を JSON で標準出力
  --explain               統合理由を表示（JSON 併用時は { concept, explanation }）
  --help, -h              このヘルプを表示

注意:
  --today と --from / --to は併用できません。
  日付契約は search / editor と同じ（postedAt・ローカル日付境界）です。
  Topic は時点の話題、Concept は継続テーマです（詳細は DATA_CONTRACT）。
  正式入力は output/timeline_enriched.json です。

例:
  node concepts.js --today
  node concepts.js --from 2026-07-01 --to 2026-07-15
  node concepts.js --category AI --category プログラミング・IT
  node concepts.js --min-days 2 --min-topics 2 --limit 10
  node concepts.js --explain --json
`);
}

function parseArgs(argv) {
  const options = {
    today: false,
    from: null,
    to: null,
    categories: [],
    minDays: null,
    minTopics: null,
    limit: null,
    json: false,
    explain: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const spec = OPTION_SPECS[token];

    if (!spec) {
      fail(`未知のオプションです: ${token}\n使い方は node concepts.js --help を参照してください。`);
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
      if (spec.multi) {
        options[spec.key].push(value);
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
      options[spec.key] = num;
    }
  }

  if (options.today && (options.from || options.to)) {
    fail("--today と --from / --to は併用できません。");
  }

  if (options.categories.length > 0) {
    const allowed = new Set(getCategoryOrder());
    for (const category of options.categories) {
      if (!allowed.has(category)) {
        fail(
          `不正なカテゴリです: ${category}\n許可されるカテゴリは config/categories.json を参照してください。`
        );
      }
    }
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

function formatConceptKey(concept, explanation) {
  if (explanation && explanation.singletonFallback) {
    return "(derived singleton)";
  }
  if (concept.conceptKey) return concept.conceptKey;
  return "(derived singleton)";
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function renderExplainBlock(explanation) {
  const lines = [];
  lines.push("  Explain:");
  lines.push(
    `    keySources: ${explanation.keySources.length ? explanation.keySources.join(", ") : "(none)"}`
  );
  lines.push(
    `    humanTags: ${
      explanation.humanTagsUsed.length
        ? explanation.humanTagsUsed.join(", ")
        : "(none)"
    }`
  );
  lines.push(`    topicKeys: ${explanation.topicKeys.join(" | ")}`);
  lines.push(
    `    dominantCategory: ${explanation.dominantCategory}` +
      ` (posts=${explanation.dominantCategoryReason.postCount}` +
      `, maxImp=${explanation.dominantCategoryReason.maxImportance})`
  );
  lines.push(
    `    activeDates: ${
      explanation.activeDates.length ? explanation.activeDates.join(", ") : "(none)"
    }`
  );
  lines.push(`    singletonFallback: ${explanation.singletonFallback ? "yes" : "no"}`);
  return lines.join("\n");
}

function renderConcept(item, explain) {
  const { concept, explanation } = item;
  const lines = [];
  lines.push("========================================");
  lines.push("");
  lines.push(`Concept: ${concept.label}`);
  lines.push(`Key: ${formatConceptKey(concept, explanation)}`);
  lines.push(`Category: ${concept.category}`);
  lines.push(`Tags: ${concept.tags.length ? concept.tags.join(", ") : "(none)"}`);
  lines.push(`Active days: ${concept.activeDays}`);
  lines.push(`Topics: ${concept.topicCount}`);
  lines.push(`Posts: ${concept.postCount}`);
  lines.push(
    `Importance: max ${concept.maxImportance} / average ${concept.averageImportance.toFixed(1)}`
  );
  lines.push(
    `Period: ${formatPostedAt(concept.oldestPostedAt)} - ${formatPostedAt(concept.newestPostedAt)}`
  );
  lines.push(`Summary: ${oneLine(concept.summary)}`);
  lines.push("");
  lines.push("Recent Topics:");

  const recent = concept.topics.slice(0, 5);
  if (recent.length === 0) {
    lines.push("- (none)");
  } else {
    for (const topic of recent) {
      lines.push(
        `- [${topic.maxImportance}] ${topic.category} · posts=${topic.postCount} · ${oneLine(topic.summary)}`
      );
    }
  }

  if (explain) {
    lines.push("");
    lines.push(renderExplainBlock(explanation));
  }

  lines.push("");
  return lines.join("\n");
}

function renderText(library, range, explain) {
  const lines = [];
  lines.push("# Concept Library");
  lines.push("");

  if (range.labelFrom || range.labelTo) {
    const fromLabel = range.labelFrom || "(開始指定なし)";
    const toLabel = range.labelTo || "(終了指定なし)";
    lines.push(`対象期間: ${fromLabel} 〜 ${toLabel}`);
  } else {
    lines.push("対象期間: 全期間");
  }

  lines.push(
    `投稿: ${library.totalPosts}件 / Topic: ${library.totalTopics}件 / Concept: ${library.totalConcepts}件（表示 ${library.concepts.length}件）`
  );
  lines.push("");

  if (library.concepts.length === 0) {
    lines.push("条件に一致する Concept はありませんでした。");
    lines.push("");
    return lines.join("\n");
  }

  for (const item of library.concepts) {
    lines.push(renderConcept(item, explain));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function toPublicJson(library, range, explain) {
  if (explain) {
    return library.concepts.map((item) => ({
      concept: item.concept,
      explanation: item.explanation,
    }));
  }

  return library.concepts.map((item) => item.concept);
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const range = resolveLocalDateRange(options, fail);
  const posts = loadPosts();
  const library = buildConceptLibrary(
    posts,
    {
      categories: options.categories,
      minDays: options.minDays,
      minTopics: options.minTopics,
      limit: options.limit,
    },
    range
  );

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(toPublicJson(library, range, options.explain), null, 2)}\n`
    );
    return;
  }

  process.stdout.write(renderText(library, range, options.explain));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  renderText,
  toPublicJson,
};
