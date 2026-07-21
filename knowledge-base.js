const fs = require("fs");
const path = require("path");
const { fail } = require("./lib/pipeline-io");
const {
  loadKnowledgeStatusConfig,
  parseKnowledgeInput,
} = require("./lib/knowledge-core");
const {
  initializeKnowledgeBase,
  saveKnowledge,
  loadKnowledge,
  loadKnowledgeVersion,
  listKnowledge,
  listKnowledgeVersions,
  rebuildKnowledgeIndex,
  validateKnowledgeBase,
} = require("./lib/knowledge-store");

const DEFAULT_BASE_DIR = path.join(process.cwd(), "knowledge-base");

function printHelp() {
  console.log(`x-timeline-collector Knowledge Base

使い方:
  node knowledge-base.js init [--base-dir <path>]
  node knowledge-base.js save --input <path> [--base-dir <path>]
  node knowledge-base.js show --id <id> [--version <N>] [--base-dir <path>]
  node knowledge-base.js list [--json] [--base-dir <path>]
  node knowledge-base.js history --id <id> [--base-dir <path>]
  node knowledge-base.js rebuild-index [--base-dir <path>]
  node knowledge-base.js validate [--base-dir <path>]
  node knowledge-base.js --help

役割:
  Knowledge Object をローカルに永続保存する。
  Knowledge Workflow（knowledge.js）は編集、本CLIは保存・読出し。
  AI は使いません。入力ファイルは読み取り専用です。

既定保存先:
  ./knowledge-base/
    items/<id>.json          現行 Knowledge（正本）
    history/<id>/00000N.json 変更不能な履歴
    index.json               再生成可能な一覧インデックス

例:
  node knowledge-base.js init
  node knowledge-base.js save --input /tmp/k.json
  node knowledge-base.js show --id ai-agents
  node knowledge-base.js show --id ai-agents --version 1
  node knowledge-base.js list
  node knowledge-base.js history --id ai-agents
  node knowledge-base.js validate --base-dir /tmp/kb-test
`);
}

function parseArgs(argv, specs) {
  const options = { help: false, baseDir: DEFAULT_BASE_DIR, json: false };
  for (const spec of specs) {
    if (spec.multi) options[spec.key] = [];
    else if (spec.type === "boolean") options[spec.key] = false;
    else if (spec.key !== "baseDir") {
      options[spec.key] = spec.default !== undefined ? spec.default : null;
    }
  }

  const byFlag = new Map(specs.map((spec) => [spec.flag, spec]));
  byFlag.set("--base-dir", { flag: "--base-dir", key: "baseDir", type: "string" });
  byFlag.set("--json", { flag: "--json", key: "json", type: "boolean" });
  byFlag.set("--help", { flag: "--help", key: "help", type: "boolean" });
  byFlag.set("-h", { flag: "-h", key: "help", type: "boolean" });

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const spec = byFlag.get(token);
    if (!spec) {
      fail(`未知のオプションです: ${token}\n使い方は node knowledge-base.js --help を参照してください。`);
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
      if (!/^\d+$/.test(value)) fail(`${token} には正の整数を指定してください。`);
      const num = Number(value);
      if (!Number.isInteger(num) || num < 1) {
        fail(`${token} には正の整数を指定してください。`);
      }
      options[spec.key] = num;
    } else {
      options[spec.key] = value;
    }
  }

  return options;
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function readInputFile(filePath, statusConfig) {
  if (!filePath) fail("--input <path> が必要です。");
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

function cmdInit(argv) {
  const options = parseArgs(argv, []);
  if (options.help) {
    printHelp();
    return;
  }
  try {
    const result = initializeKnowledgeBase(options.baseDir);
    writeJson({
      operation: "init",
      baseDir: result.baseDir,
      changed: result.changed,
      paths: result.paths,
    });
  } catch (error) {
    fail(error.message);
  }
}

function cmdSave(argv, statusConfig) {
  const options = parseArgs(argv, [{ flag: "--input", key: "input", type: "string" }]);
  if (options.help) {
    printHelp();
    return;
  }
  const knowledge = readInputFile(options.input, statusConfig);
  try {
    const result = saveKnowledge(options.baseDir, knowledge, { statusConfig });
    writeJson({
      operation: "save",
      baseDir: path.resolve(options.baseDir),
      created: result.created,
      knowledge: result.knowledge,
    });
  } catch (error) {
    fail(error.message);
  }
}

function cmdShow(argv, statusConfig) {
  const options = parseArgs(argv, [
    { flag: "--id", key: "id", type: "string" },
    { flag: "--version", key: "version", type: "integer" },
  ]);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.id) fail("--id は必須です。");
  try {
    const knowledge =
      options.version != null
        ? loadKnowledgeVersion(options.baseDir, options.id, options.version, {
            statusConfig,
          })
        : loadKnowledge(options.baseDir, options.id, { statusConfig });
    writeJson(knowledge);
  } catch (error) {
    fail(error.message);
  }
}

function cmdList(argv, statusConfig) {
  const options = parseArgs(argv, []);
  if (options.help) {
    printHelp();
    return;
  }
  try {
    const listed = listKnowledge(options.baseDir, { statusConfig });
    if (options.json) {
      writeJson(listed);
      return;
    }
    const lines = [];
    lines.push(`Knowledge Base: ${path.resolve(options.baseDir)}`);
    lines.push(`Count: ${listed.items.length}`);
    lines.push("");
    if (listed.items.length === 0) {
      lines.push("(empty)");
    } else {
      for (const item of listed.items) {
        lines.push(
          `${item.id}  [${item.status}] v${item.version}  conf=${item.confidence}  evidence=${item.evidenceCount ?? 0}`
        );
        lines.push(`  ${item.title}`);
        lines.push(`  updated: ${item.updatedAt}`);
        lines.push("");
      }
    }
    process.stdout.write(`${lines.join("\n").trimEnd()}\n`);
  } catch (error) {
    fail(error.message);
  }
}

function cmdHistory(argv, statusConfig) {
  const options = parseArgs(argv, [{ flag: "--id", key: "id", type: "string" }]);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.id) fail("--id は必須です。");
  try {
    const listed = listKnowledgeVersions(options.baseDir, options.id, { statusConfig });
    const rows = [];
    for (const version of listed.versions) {
      const snap = loadKnowledgeVersion(options.baseDir, options.id, version, {
        statusConfig,
      });
      rows.push({
        version: snap.version,
        status: snap.status,
        title: snap.title,
        updatedAt: snap.updatedAt,
      });
    }
    writeJson({
      id: listed.id,
      currentVersion: listed.currentVersion,
      versions: rows,
    });
  } catch (error) {
    fail(error.message);
  }
}

function cmdRebuildIndex(argv, statusConfig) {
  const options = parseArgs(argv, []);
  if (options.help) {
    printHelp();
    return;
  }
  try {
    const index = rebuildKnowledgeIndex(options.baseDir, { statusConfig });
    writeJson({
      operation: "rebuild-index",
      baseDir: path.resolve(options.baseDir),
      itemCount: index.items.length,
      generatedAt: index.generatedAt,
    });
  } catch (error) {
    fail(error.message);
  }
}

function cmdValidate(argv, statusConfig) {
  const options = parseArgs(argv, []);
  if (options.help) {
    printHelp();
    return;
  }
  try {
    const result = validateKnowledgeBase(options.baseDir, { statusConfig });
    writeJson(result);
    if (!result.valid) {
      process.exitCode = 1;
    }
  } catch (error) {
    fail(error.message);
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

  if (command === "init") cmdInit(rest);
  else if (command === "save") cmdSave(rest, statusConfig);
  else if (command === "show") cmdShow(rest, statusConfig);
  else if (command === "list") cmdList(rest, statusConfig);
  else if (command === "history") cmdHistory(rest, statusConfig);
  else if (command === "rebuild-index") cmdRebuildIndex(rest, statusConfig);
  else if (command === "validate") cmdValidate(rest, statusConfig);
  else {
    fail(
      `未知のコマンドです: ${command}\n使い方は node knowledge-base.js --help を参照してください。`
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
