const fs = require("fs");
const { fail } = require("./lib/pipeline-io");
const {
  validateKnowledge,
  loadKnowledgeStatusConfig,
  parseKnowledgeInput,
} = require("./lib/knowledge-core");
const {
  createDraft,
  updateDraft,
  addEvidence,
  removeEvidence,
  transitionStatus,
} = require("./lib/knowledge-workflow");

function printHelp() {
  console.log(`x-timeline-collector Knowledge Draft Workflow

使い方:
  node knowledge.js create [options]
  node knowledge.js update --input <path> [options]
  node knowledge.js add-evidence --input <path> --type <story|concept|post> ...
  node knowledge.js remove-evidence --input <path> --type <story|concept|post> ...
  node knowledge.js transition --input <path> --to <status>
  node knowledge.js validate --input <path>
  node knowledge.js --help

役割:
  Story を根拠に Knowledge Draft を作成・Evidence 追加・更新・status 遷移する。
  AI は使いません。入力ファイルは読み取り専用。結果は標準出力のみ（保存しません）。

create:
  --id --title [--summary] [--notes] [--confidence] [--story] [--concept] [--post]

update:
  --input <path> [--title] [--summary] [--notes] [--confidence] のいずれか必須

add-evidence / remove-evidence:
  --input <path> --type story|concept|post
  story/concept: --id <identity>
  post: --url <url>

transition:
  --input <path> --to <status>

注意:
  --input は読み取り専用。純 Knowledge JSON と Workflow 出力 { knowledge, operation } の両方を受け付けます。
  version / updatedAt は意味のある変更時のみ更新されます。
  status 遷移規則は config/knowledge-status.json を参照。
  draft→review / review→published には summary と Evidence が必要です。

例:
  node knowledge.js create --id ai-agents --title "AIエージェント" --summary "本文"
  node knowledge.js add-evidence --input /tmp/k.json --type story --id ai-agents
  node knowledge.js transition --input /tmp/k.json --to review
`);
}

function readInputKnowledge(filePath, statusConfig) {
  if (!filePath) {
    fail("--input <path> が必要です。");
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`入力ファイルの読み込みに失敗しました: ${error.message}`);
  }
  try {
    return parseKnowledgeInput(raw, { statusConfig });
  } catch (error) {
    fail(error.message);
  }
}

function writeOperationResult(result, statusConfig) {
  const payload = {
    knowledge: result.knowledge,
    operation: result.operation,
  };
  // Re-validate without bumping version
  const validated = validateKnowledge(payload.knowledge, { statusConfig });
  if (!validated.ok) {
    fail(validated.errors.join("\n"));
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseArgs(argv, specs) {
  const options = { help: false };
  for (const spec of specs) {
    if (spec.multi) options[spec.key] = [];
    else if (spec.type === "boolean") options[spec.key] = false;
    else options[spec.key] = spec.default !== undefined ? spec.default : null;
  }

  const byFlag = new Map(specs.map((spec) => [spec.flag, spec]));

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    const spec = byFlag.get(token);
    if (!spec) {
      fail(`未知のオプションです: ${token}\n使い方は node knowledge.js --help を参照してください。`);
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
      if (spec.min != null && num < spec.min) fail(`${token} が範囲外です。`);
      if (spec.max != null && num > spec.max) fail(`${token} が範囲外です。`);
      options[spec.key] = num;
    } else if (spec.multi) {
      options[spec.key].push(value);
    } else {
      options[spec.key] = value;
    }
  }

  return options;
}

function cmdCreate(argv, statusConfig) {
  const options = parseArgs(argv, [
    { flag: "--id", key: "id", type: "string" },
    { flag: "--title", key: "title", type: "string" },
    { flag: "--summary", key: "summary", type: "string", default: "" },
    { flag: "--notes", key: "notes", type: "string", default: "" },
    { flag: "--confidence", key: "confidence", type: "integer", default: 0, min: 0, max: 100 },
    { flag: "--story", key: "stories", type: "string", multi: true },
    { flag: "--concept", key: "concepts", type: "string", multi: true },
    { flag: "--post", key: "posts", type: "string", multi: true },
  ]);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.id) fail("--id は必須です。");
  if (!options.title) fail("--title は必須です。");

  try {
    const result = createDraft(
      {
        id: options.id,
        title: options.title,
        summary: options.summary || "",
        notes: options.notes || "",
        confidence: options.confidence ?? 0,
        evidence: {
          stories: options.stories,
          concepts: options.concepts,
          posts: options.posts,
        },
      },
      { statusConfig }
    );
    writeOperationResult(result, statusConfig);
  } catch (error) {
    fail(error.message);
  }
}

function cmdUpdate(argv, statusConfig) {
  const options = parseArgs(argv, [
    { flag: "--input", key: "input", type: "string" },
    { flag: "--title", key: "title", type: "string" },
    { flag: "--summary", key: "summary", type: "string" },
    { flag: "--notes", key: "notes", type: "string" },
    { flag: "--confidence", key: "confidence", type: "integer", min: 0, max: 100 },
  ]);
  if (options.help) {
    printHelp();
    return;
  }

  const changes = {};
  if (options.title != null) changes.title = options.title;
  if (options.summary != null) changes.summary = options.summary;
  if (options.notes != null) changes.notes = options.notes;
  if (options.confidence != null) changes.confidence = options.confidence;
  if (Object.keys(changes).length === 0) {
    fail("更新フィールドがありません。--title / --summary / --notes / --confidence のいずれかを指定してください。");
  }

  const knowledge = readInputKnowledge(options.input, statusConfig);
  try {
    const result = updateDraft(knowledge, changes, { statusConfig });
    writeOperationResult(result, statusConfig);
  } catch (error) {
    fail(error.message);
  }
}

function parseEvidenceCommand(argv) {
  return parseArgs(argv, [
    { flag: "--input", key: "input", type: "string" },
    { flag: "--type", key: "type", type: "string" },
    { flag: "--id", key: "id", type: "string" },
    { flag: "--url", key: "url", type: "string" },
  ]);
}

function resolveEvidenceRef(options) {
  if (!options.type) fail("--type は必須です（story / concept / post）。");
  if (options.type === "post") {
    if (!options.url) fail("post では --url が必要です。");
    return options.url;
  }
  if (!options.id) fail(`${options.type} では --id が必要です。`);
  return options.id;
}

function cmdAddEvidence(argv, statusConfig) {
  const options = parseEvidenceCommand(argv);
  if (options.help) {
    printHelp();
    return;
  }
  const knowledge = readInputKnowledge(options.input, statusConfig);
  const ref = resolveEvidenceRef(options);
  try {
    const result = addEvidence(knowledge, options.type, ref, { statusConfig });
    writeOperationResult(result, statusConfig);
  } catch (error) {
    fail(error.message);
  }
}

function cmdRemoveEvidence(argv, statusConfig) {
  const options = parseEvidenceCommand(argv);
  if (options.help) {
    printHelp();
    return;
  }
  const knowledge = readInputKnowledge(options.input, statusConfig);
  const ref = resolveEvidenceRef(options);
  try {
    const result = removeEvidence(knowledge, options.type, ref, { statusConfig });
    writeOperationResult(result, statusConfig);
  } catch (error) {
    fail(error.message);
  }
}

function cmdTransition(argv, statusConfig) {
  const options = parseArgs(argv, [
    { flag: "--input", key: "input", type: "string" },
    { flag: "--to", key: "to", type: "string" },
  ]);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.to) fail("--to <status> が必要です。");
  const knowledge = readInputKnowledge(options.input, statusConfig);
  try {
    const result = transitionStatus(knowledge, options.to, { statusConfig });
    writeOperationResult(result, statusConfig);
  } catch (error) {
    fail(error.message);
  }
}

function cmdValidate(argv, statusConfig) {
  const options = parseArgs(argv, [{ flag: "--input", key: "input", type: "string" }]);
  if (options.help) {
    printHelp();
    return;
  }
  const knowledge = readInputKnowledge(options.input, statusConfig);
  const validated = validateKnowledge(knowledge, { statusConfig });
  if (!validated.ok) {
    fail(validated.errors.join("\n"));
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        knowledge: validated.knowledge,
      },
      null,
      2
    )}\n`
  );
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

  if (command === "create") cmdCreate(rest, statusConfig);
  else if (command === "update") cmdUpdate(rest, statusConfig);
  else if (command === "add-evidence") cmdAddEvidence(rest, statusConfig);
  else if (command === "remove-evidence") cmdRemoveEvidence(rest, statusConfig);
  else if (command === "transition") cmdTransition(rest, statusConfig);
  else if (command === "validate") cmdValidate(rest, statusConfig);
  else {
    fail(`未知のコマンドです: ${command}\n使い方は node knowledge.js --help を参照してください。`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  printHelp,
};
