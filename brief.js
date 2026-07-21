const fs = require("fs");
const path = require("path");
const { fail } = require("./lib/pipeline-io");
const { loadKnowledgeStatusConfig } = require("./lib/knowledge-core");
const {
  loadKnowledge,
  listKnowledge,
} = require("./lib/knowledge-store");
const {
  buildKnowledgeBrief,
  validateBrief,
  resolveAllowedStatuses,
  dedupeIds,
  DEFAULT_PURPOSE,
  DEFAULT_CONFIDENCE_THRESHOLD,
} = require("./lib/brief-core");

const DEFAULT_BASE_DIR = path.join(process.cwd(), "knowledge-base");

function printHelp() {
  console.log(`x-timeline-collector Knowledge Brief Builder

使い方:
  node brief.js build [options]
  node brief.js validate --input <path>
  node brief.js --help

役割:
  Knowledge Base の Knowledge から、編集指示用の構造化 Brief を生成する。
  任意で --stories を渡すと Editorial Brief v2（headline / angle / keyFacts 等）を付与する。
  派生ビューのみ。Knowledge Base / Knowledge Object は変更しない。
  AI・記事本文生成・URL 取得は行いません。Brief は保存しません。

build:
  --knowledge <id>            Knowledge ID（複数可 / カンマ区切り可）
  --status <status>           status で候補選択（複数可。未指定かつ ID なし時は published）
  --allow-status <status>     published 以外を明示許可（draft / review / archived）
  --title <text>              Brief タイトル
  --purpose <text>            執筆目的（既定: research-note）
  --id <brief-id>             Brief id（未指定時は自動生成）
  --confidence-threshold <N>  low-confidence 閾値（既定: 50）
  --constraint <text>         追加制約（複数可）
  --stories <path>            任意。stories.js --json 相当（Editorial Brief v2）
  --base-dir <path>           Knowledge Base パス（既定: ./knowledge-base/）

validate:
  --input <path>              Brief JSON（読み取り専用）

選択規則:
  - 既定で使える Knowledge status は published のみ
  - 明示 ID でも published 以外は --allow-status が必要
  - 明示 ID 指定時: 指定順を維持
  - status 検索時: status優先 → confidence降順 → updatedAt降順 → id昇順

例:
  node brief.js build --knowledge ai-agents --title "AIエージェント" --purpose explainer
  node brief.js build --knowledge creative-tech --stories /tmp/stories.json
  node brief.js build --status published
  node brief.js validate --input /tmp/brief.json
`);
}

function parseArgs(argv, specs) {
  const options = {
    help: false,
    baseDir: DEFAULT_BASE_DIR,
    knowledge: [],
    status: [],
    allowStatus: [],
    constraints: [],
    title: null,
    purpose: DEFAULT_PURPOSE,
    id: null,
    input: null,
    stories: null,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
  };

  const byFlag = new Map();
  for (const spec of specs) {
    byFlag.set(spec.flag, spec);
  }
  byFlag.set("--base-dir", { flag: "--base-dir", key: "baseDir", type: "string" });
  byFlag.set("--help", { flag: "--help", key: "help", type: "boolean" });
  byFlag.set("-h", { flag: "-h", key: "help", type: "boolean" });

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const spec = byFlag.get(token);
    if (!spec) {
      fail(`未知のオプションです: ${token}\n使い方は node brief.js --help を参照してください。`);
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
    if (spec.type === "integer") {
      if (!/^\d+$/.test(value)) {
        fail(`${token} には整数を指定してください。`);
      }
      const num = Number(value);
      if (!Number.isInteger(num) || num < 0) {
        fail(`${token} には 0 以上の整数を指定してください。`);
      }
      options[spec.key] = num;
    } else if (spec.multi) {
      if (spec.splitComma) {
        for (const part of value.split(",")) {
          const trimmed = part.trim();
          if (trimmed) options[spec.key].push(trimmed);
        }
      } else {
        options[spec.key].push(value);
      }
    } else {
      options[spec.key] = value;
    }
  }

  return options;
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function expandKnowledgeIds(rawIds) {
  const expanded = [];
  for (const raw of rawIds) {
    if (raw.includes(",")) {
      for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (trimmed) expanded.push(trimmed);
      }
    } else {
      expanded.push(raw);
    }
  }
  return dedupeIds(expanded);
}

function selectKnowledgeList(options, statusConfig) {
  const allowed = resolveAllowedStatuses({ allowStatus: options.allowStatus });
  const explicitIds = expandKnowledgeIds(options.knowledge);
  const statusFilters = dedupeIds(options.status);

  if (explicitIds.length === 0 && statusFilters.length === 0) {
    statusFilters.push("published");
  }

  for (const status of [...statusFilters, ...options.allowStatus]) {
    if (!statusConfig.statuses.includes(status)) {
      fail(`未知の Knowledge status です: ${status}`);
    }
  }

  const loaded = [];
  const seen = new Set();

  if (explicitIds.length > 0) {
    for (const id of explicitIds) {
      let knowledge;
      try {
        knowledge = loadKnowledge(options.baseDir, id, { statusConfig });
      } catch (error) {
        fail(error.message);
      }
      if (!allowed.has(knowledge.status)) {
        fail(
          `Knowledge "${id}" の status は ${knowledge.status} です。` +
            ` 既定では published のみ使用できます。--allow-status ${knowledge.status} を指定してください。`
        );
      }
      if (statusFilters.length > 0 && !statusFilters.includes(knowledge.status)) {
        fail(
          `Knowledge "${id}" の status (${knowledge.status}) が --status 条件に一致しません。`
        );
      }
      if (!seen.has(knowledge.id)) {
        seen.add(knowledge.id);
        loaded.push(knowledge);
      }
    }
    return { knowledgeList: loaded, preserveOrder: true, knowledgeIds: explicitIds };
  }

  // status search via index → loadKnowledge
  let listed;
  try {
    listed = listKnowledge(options.baseDir, { statusConfig });
  } catch (error) {
    fail(error.message);
  }

  const candidateIds = listed.items
    .filter((item) => statusFilters.includes(item.status))
    .filter((item) => allowed.has(item.status))
    .map((item) => item.id);

  for (const id of candidateIds) {
    let knowledge;
    try {
      knowledge = loadKnowledge(options.baseDir, id, { statusConfig });
    } catch (error) {
      fail(error.message);
    }
    if (!statusFilters.includes(knowledge.status)) continue;
    if (!allowed.has(knowledge.status)) continue;
    if (!seen.has(knowledge.id)) {
      seen.add(knowledge.id);
      loaded.push(knowledge);
    }
  }

  return {
    knowledgeList: loaded,
    preserveOrder: false,
    knowledgeIds: loaded.map((k) => k.id),
  };
}

function cmdBuild(argv, statusConfig) {
  const options = parseArgs(argv, [
    { flag: "--knowledge", key: "knowledge", type: "string", multi: true, splitComma: true },
    { flag: "--status", key: "status", type: "string", multi: true },
    { flag: "--allow-status", key: "allowStatus", type: "string", multi: true },
    { flag: "--title", key: "title", type: "string" },
    { flag: "--purpose", key: "purpose", type: "string" },
    { flag: "--id", key: "id", type: "string" },
    {
      flag: "--confidence-threshold",
      key: "confidenceThreshold",
      type: "integer",
    },
    { flag: "--constraint", key: "constraints", type: "string", multi: true },
    { flag: "--stories", key: "stories", type: "string" },
  ]);

  if (options.help) {
    printHelp();
    return;
  }

  const selected = selectKnowledgeList(options, statusConfig);
  if (selected.knowledgeList.length === 0) {
    fail("条件に一致する Knowledge が 0 件です。Brief を生成できません。");
  }

  let storiesPayload;
  if (options.stories) {
    try {
      storiesPayload = JSON.parse(fs.readFileSync(options.stories, "utf8"));
    } catch (error) {
      fail(`Stories の読み込みに失敗しました: ${error.message}`);
    }
  }

  try {
    const buildOptions = {
      id: options.id,
      title: options.title,
      purpose: options.purpose,
      confidenceThreshold: options.confidenceThreshold,
      constraints: options.constraints,
      preserveOrder: selected.preserveOrder,
    };
    if (options.stories) {
      buildOptions.stories = storiesPayload;
    }
    const brief = buildKnowledgeBrief(
      selected.knowledgeList,
      buildOptions,
      { now: new Date() }
    );

    writeJson({
      brief,
      operation: {
        type: "build-brief",
        knowledgeIds: selected.knowledgeIds,
        baseDir: path.resolve(options.baseDir),
      },
    });
  } catch (error) {
    fail(error.message);
  }
}

function cmdValidate(argv) {
  const options = parseArgs(argv, [
    { flag: "--input", key: "input", type: "string" },
  ]);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.input) {
    fail("--input <path> が必要です。");
  }

  let raw;
  try {
    raw = fs.readFileSync(options.input, "utf8");
  } catch (error) {
    fail(`入力ファイルの読み込みに失敗しました: ${error.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    fail(`Brief JSON の解析に失敗しました: ${error.message}`);
  }

  const result = validateBrief(data);
  writeJson({
    valid: result.ok,
    errors: result.errors,
  });
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return;
  }

  let statusConfig;
  try {
    statusConfig = loadKnowledgeStatusConfig();
  } catch (error) {
    fail(error.message);
  }

  const command = argv[0];
  const rest = argv.slice(1);

  if (command === "build") cmdBuild(rest, statusConfig);
  else if (command === "validate") cmdValidate(rest);
  else {
    fail(
      `未知のコマンドです: ${command}\n使い方は node brief.js --help を参照してください。`
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  printHelp,
  DEFAULT_BASE_DIR,
};
