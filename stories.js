const path = require("path");
const {
  pad2,
  parseDateOnly,
  resolveLocalDateRange,
  parsePostedAtMs,
} = require("./lib/date-range");
const { fail, readJsonArrayRequired } = require("./lib/pipeline-io");
const { getCategoryOrder } = require("./lib/categories");
const {
  loadStoryDefinitions,
  buildStoryView,
} = require("./lib/story-core");

const INPUT_FILE = path.join(__dirname, "output", "timeline_enriched.json");

const OPTION_SPECS = {
  "--today": { type: "boolean", key: "today" },
  "--from": { type: "date", key: "from" },
  "--to": { type: "date", key: "to" },
  "--category": { type: "string", key: "categories", multi: true },
  "--story": { type: "string", key: "storyIds", multi: true },
  "--min-days": { type: "integer", key: "minDays" },
  "--min-concepts": { type: "integer", key: "minConcepts" },
  "--limit": { type: "integer", key: "limit" },
  "--show-unassigned": { type: "boolean", key: "showUnassigned" },
  "--json": { type: "boolean", key: "json" },
  "--explain": { type: "boolean", key: "explain" },
  "--help": { type: "boolean", key: "help" },
  "-h": { type: "boolean", key: "help" },
};

function printHelp() {
  console.log(`x-timeline-collector Story Engine（Editor in Chief）

使い方:
  node stories.js [options]

役割:
  Concept → 複数Conceptを束ねた編集上の主要論点（Story）へ整理する派生ビュー。
  Story定義は config/stories.json。AI は使いません。集計は保存しません。

オプション:
  --today                 今日（ローカル日付の 0:00:00〜23:59:59.999）を対象
  --from <YYYY-MM-DD>     指定日以降を対象（ローカル日付の 0:00:00）
  --to <YYYY-MM-DD>       指定日以前を対象（ローカル日付の 23:59:59.999 まで含む）
  --category <名前>       Story 内に当該カテゴリの Concept/投稿が含まれる（複数は OR）
  --story <ID>            Story ID で絞り込み（複数は OR。label ではなく id）
  --min-days <N>          activeDays が N 以上
  --min-concepts <N>      conceptCount が N 以上
  --limit <N>             表示する Story 数の上限（フィルター・ソート後）
  --show-unassigned       未分類 Concept を末尾に表示
  --json                  JSON を標準出力
  --explain               構成・スコア根拠を表示
  --help, -h              このヘルプを表示

注意:
  --today と --from / --to は併用できません。
  日付契約は search / concepts と同じ（postedAt・ローカル日付境界）です。
  一つの Concept は複数 Story に所属できます。
  正式入力は output/timeline_enriched.json です。

例:
  node stories.js --today
  node stories.js --from 2026-07-01 --to 2026-07-15
  node stories.js --story ai-agents --story models-reasoning
  node stories.js --category AI --min-concepts 1 --limit 5
  node stories.js --show-unassigned --explain
  node stories.js --json
`);
}

function parseArgs(argv, definitions) {
  const options = {
    today: false,
    from: null,
    to: null,
    categories: [],
    storyIds: [],
    minDays: null,
    minConcepts: null,
    limit: null,
    showUnassigned: false,
    json: false,
    explain: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const spec = OPTION_SPECS[token];

    if (!spec) {
      fail(`未知のオプションです: ${token}\n使い方は node stories.js --help を参照してください。`);
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

  if (options.storyIds.length > 0) {
    const allowed = new Set(definitions.map((item) => item.id));
    for (const id of options.storyIds) {
      if (!allowed.has(id)) {
        fail(
          `不正な Story ID です: ${id}\nconfig/stories.json の id を指定してください。`
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

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function formatCategories(categories) {
  const entries = Object.entries(categories || {});
  if (entries.length === 0) return "(none)";
  return entries.map(([name, count]) => `${name}:${count}`).join(", ");
}

function renderExplain(explanation) {
  const lines = [];
  lines.push("  Explain:");
  lines.push(
    `    definition: id=${explanation.definition.id} priority=${explanation.definition.priority} index=${explanation.definitionIndex}`
  );
  lines.push(
    `    includeTags: ${
      explanation.definition.includeTags.length
        ? explanation.definition.includeTags.join(", ")
        : "(none)"
    }`
  );
  lines.push(
    `    includeCategories: ${
      explanation.definition.includeCategories.length
        ? explanation.definition.includeCategories.join(", ")
        : "(none)"
    }`
  );
  lines.push(
    `    score: ${Object.entries(explanation.scoreComponents)
      .map(([k, v]) => `${k}=${v}`)
      .join(" + ")}`
  );
  lines.push(
    `    activeDates: ${
      explanation.activeDates.length ? explanation.activeDates.join(", ") : "(none)"
    }`
  );
  lines.push(`    categories: ${formatCategories(explanation.categoryCounts)}`);
  lines.push("    matchedConcepts:");
  for (const item of explanation.matchedConcepts.slice(0, 8)) {
    const tags = item.match.matchedTags.length
      ? `tags=${item.match.matchedTags.join("|")}`
      : "";
    const cats = item.match.matchedCategories.length
      ? `cats=${item.match.matchedCategories.join("|")}`
      : "";
    lines.push(
      `      - ${item.label || item.conceptKey || "(concept)"} [${item.match.reason}] ${tags} ${cats}`.trim()
    );
  }
  if (explanation.matchedConcepts.length > 8) {
    lines.push(`      …ほか ${explanation.matchedConcepts.length - 8}件`);
  }
  return lines.join("\n");
}

function renderStory(item, explain) {
  const { story, explanation } = item;
  const lines = [];
  lines.push("========================================");
  lines.push("");
  lines.push(`Story: ${story.label}`);
  lines.push(`ID: ${story.id}`);
  lines.push(`Score: ${story.score}`);
  lines.push(`Active days: ${story.activeDays}`);
  lines.push(`Concepts: ${story.conceptCount}`);
  lines.push(`Topics: ${story.topicCount}`);
  lines.push(`Posts: ${story.postCount}`);
  lines.push(
    `Importance: max ${story.maxImportance} / average ${story.averageImportance.toFixed(1)}`
  );
  lines.push(
    `Period: ${formatPostedAt(story.oldestPostedAt)} - ${formatPostedAt(story.newestPostedAt)}`
  );
  lines.push(`Categories: ${formatCategories(story.categories)}`);
  lines.push(`Tags: ${story.tags.length ? story.tags.slice(0, 12).join(", ") : "(none)"}`);
  lines.push(`Description: ${story.description || "(none)"}`);
  lines.push("");
  lines.push("Key Concepts:");

  const keyConcepts = story.concepts.slice(0, 5);
  if (keyConcepts.length === 0) {
    lines.push("- (none)");
  } else {
    for (const concept of keyConcepts) {
      lines.push(
        `- [d${concept.activeDays}/i${concept.maxImportance}] ${concept.label} · topics=${concept.topicCount} · ${oneLine(concept.summary)}`
      );
    }
  }

  if (explain) {
    lines.push("");
    lines.push(renderExplain(explanation));
  }

  lines.push("");
  return lines.join("\n");
}

function renderUnassigned(unassignedConcepts, explain) {
  const lines = [];
  lines.push("========================================");
  lines.push("");
  lines.push("Unassigned Concepts");
  lines.push(`Count: ${unassignedConcepts.length}`);
  lines.push("");
  for (const item of unassignedConcepts.slice(0, 20)) {
    const concept = item.concept;
    lines.push(
      `- ${concept.label} · cat=${concept.category} · days=${concept.activeDays} · ${oneLine(concept.summary)}`
    );
    if (explain) {
      lines.push(`  reason: ${item.explanation.reason}`);
    }
  }
  if (unassignedConcepts.length > 20) {
    lines.push(`…ほか ${unassignedConcepts.length - 20}件`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderText(view, range, options) {
  const lines = [];
  lines.push("# Story Engine");
  lines.push("");

  if (range.labelFrom || range.labelTo) {
    const fromLabel = range.labelFrom || "(開始指定なし)";
    const toLabel = range.labelTo || "(終了指定なし)";
    lines.push(`対象期間: ${fromLabel} 〜 ${toLabel}`);
  } else {
    lines.push("対象期間: 全期間");
  }

  const stats = view.statistics;
  lines.push(
    `Stories: ${view.stories.length}/${view.totalStories} · Concepts: matched ${stats.matchedConceptCount} / unassigned ${stats.unassignedConceptCount} / total ${stats.totalConceptCount}`
  );
  lines.push(
    `Coverage: topics=${stats.totalTopicCount} posts(unique)=${stats.totalPostCount} activeDays=${stats.activeDays} multiStoryConcepts=${stats.multiStoryConceptCount}`
  );
  lines.push("");

  if (view.stories.length === 0) {
    lines.push("条件に一致する Story はありませんでした。");
    lines.push("");
  } else {
    for (const item of view.stories) {
      lines.push(renderStory(item, options.explain));
    }
  }

  if (options.showUnassigned) {
    lines.push(renderUnassigned(view.unassignedConcepts, options.explain));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function toPublicJson(view, options) {
  if (options.explain) {
    return {
      stories: view.stories.map((item) => ({
        story: item.story,
        explanation: item.explanation,
      })),
      unassignedConcepts: view.unassignedConcepts,
      statistics: view.statistics,
    };
  }

  return {
    stories: view.stories.map((item) => item.story),
    unassignedConcepts: view.unassignedConcepts.map((item) => item.concept),
    statistics: view.statistics,
  };
}

function main() {
  const helpEarly = process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h");
  if (helpEarly && process.argv.slice(2).length === 1) {
    printHelp();
    return;
  }

  const definitions = loadStoryDefinitions(fail);
  const options = parseArgs(process.argv.slice(2), definitions);

  if (options.help) {
    printHelp();
    return;
  }

  const range = resolveLocalDateRange(options, fail);
  const posts = loadPosts();
  const view = buildStoryView(
    posts,
    definitions,
    {
      categories: options.categories,
      storyIds: options.storyIds,
      minDays: options.minDays,
      minConcepts: options.minConcepts,
      limit: options.limit,
    },
    range
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(toPublicJson(view, options), null, 2)}\n`);
    return;
  }

  process.stdout.write(renderText(view, range, options));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  renderText,
  toPublicJson,
};
