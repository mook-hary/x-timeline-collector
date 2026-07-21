const fs = require("fs");
const path = require("path");
const { fail, writeJsonAtomic } = require("./lib/pipeline-io");
const { extractBriefPayload, validateBrief } = require("./lib/brief-core");
const { validateEditorialPlan } = require("./lib/editorial-plan-core");
const {
  buildArticleReport,
  validateArticleReport,
  DEFAULT_CONFIDENCE_THRESHOLD,
} = require("./lib/article-report-core");

function printHelp() {
  console.log(`x-timeline-collector Article Report v1

使い方:
  node article-report.js build --brief <path> --plan <path> --article <path> [options]
  node article-report.js validate --input <path>
  node article-report.js --help

役割:
  Brief + Editorial Plan + Writer Markdown から、記事の根拠・不足・採用状況を
  診断する決定論的 Report を生成する。記事本文ではない。AI なし。
  Knowledge Base は読みません。入力ファイルは読み取り専用です。

build:
  --brief <path>                 Brief JSON（純形式または { brief, operation }）
  --plan <path>                  Editorial Plan JSON
  --article <path>               Writer v1 Markdown
  --confidence-threshold <N>     既定: ${DEFAULT_CONFIDENCE_THRESHOLD}
  --id <report-id>               Report id（任意）
  --output <path>                Report JSON を保存（atomic write）

validate:
  --input <path>                 Report JSON

例:
  node article-report.js build \\
    --brief /tmp/brief.json --plan /tmp/plan.json --article /tmp/article.md
  node article-report.js build ... --output /tmp/article-report.json
  node article-report.js validate --input /tmp/article-report.json
`);
}

function parseArgs(argv, specs) {
  const options = {
    help: false,
    brief: null,
    plan: null,
    article: null,
    input: null,
    output: null,
    id: null,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
  };

  const byFlag = new Map(specs.map((s) => [s.flag, s]));
  byFlag.set("--help", { flag: "--help", key: "help", type: "boolean" });
  byFlag.set("-h", { flag: "-h", key: "help", type: "boolean" });

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const spec = byFlag.get(token);
    if (!spec) {
      fail(
        `未知のオプションです: ${token}\n使い方は node article-report.js --help を参照してください。`
      );
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
      options[spec.key] = Number(value);
    } else {
      options[spec.key] = value;
    }
  }
  return options;
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function readText(filePath, label) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`${label} の読み込みに失敗しました: ${error.message}`);
  }
}

function readJson(filePath, label) {
  const raw = readText(filePath, label);
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} JSON の解析に失敗しました: ${error.message}`);
  }
}

function loadBrief(filePath) {
  const data = readJson(filePath, "Brief");
  let payload;
  try {
    payload = extractBriefPayload(data);
  } catch (error) {
    fail(error.message);
  }
  const validated = validateBrief(payload);
  if (!validated.ok) {
    fail(`Brief が不正です:\n${validated.errors.join("\n")}`);
  }
  return validated.brief;
}

function loadPlan(filePath) {
  const data = readJson(filePath, "Plan");
  const validated = validateEditorialPlan(data);
  if (!validated.ok) {
    fail(`Plan が不正です:\n${validated.errors.join("\n")}`);
  }
  return validated.plan;
}

function cmdBuild(argv) {
  const options = parseArgs(argv, [
    { flag: "--brief", key: "brief", type: "string" },
    { flag: "--plan", key: "plan", type: "string" },
    { flag: "--article", key: "article", type: "string" },
    { flag: "--output", key: "output", type: "string" },
    { flag: "--id", key: "id", type: "string" },
    {
      flag: "--confidence-threshold",
      key: "confidenceThreshold",
      type: "integer",
    },
  ]);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.brief) fail("--brief <path> が必要です。");
  if (!options.plan) fail("--plan <path> が必要です。");
  if (!options.article) fail("--article <path> が必要です。");

  const brief = loadBrief(options.brief);
  const plan = loadPlan(options.plan);
  const markdown = readText(options.article, "Markdown");

  try {
    const report = buildArticleReport(
      brief,
      plan,
      markdown,
      {
        id: options.id,
        confidenceThreshold: options.confidenceThreshold,
      },
      { now: new Date() }
    );

    if (options.output) {
      const outPath = path.resolve(options.output);
      writeJsonAtomic(outPath, report);
    }

    writeJson(report);
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
  if (!options.input) fail("--input <path> が必要です。");

  const data = readJson(options.input, "Report");
  const result = validateArticleReport(data);
  writeJson({ valid: result.ok, errors: result.errors });
  if (!result.ok) {
    for (const err of result.errors) {
      process.stderr.write(`${err}\n`);
    }
    process.exitCode = 1;
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return;
  }

  const command = argv[0];
  const rest = argv.slice(1);
  if (command === "build") cmdBuild(rest);
  else if (command === "validate") cmdValidate(rest);
  else {
    fail(
      `未知のコマンドです: ${command}\n使い方は node article-report.js --help を参照してください。`
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  printHelp,
};
