const fs = require("fs");
const { fail } = require("./lib/pipeline-io");
const { extractBriefPayload, validateBrief } = require("./lib/brief-core");
const { validateEditorialPlan } = require("./lib/editorial-plan-core");
const {
  validateWriterInput,
  renderMarkdown,
} = require("./lib/writer-core");

function printHelp() {
  console.log(`x-timeline-collector Writer v2 (Deterministic Markdown Renderer)

使い方:
  node writer.js build --brief <path> --plan <path> [--stories <path>]
  node writer.js validate-input --brief <path> --plan <path>
  node writer.js --help

役割:
  Knowledge Brief と Editorial Plan を Markdown 記事草稿へ整形する。
  任意で Story JSON（--stories）を渡すと、投稿・Concept の具体情報を本文へ反映する。
  AI・要約・言い換え・Knowledge Base 読込みは行いません。
  同じ入力からは常に同じ Markdown を生成します。保存しません（stdout のみ）。

build:
  --brief <path>     Brief JSON（純 Brief または { brief, operation }）
  --plan <path>      Editorial Plan JSON
  --stories <path>   任意。stories.js --json 相当の Story ペイロード

validate-input:
  Brief / Plan の検証と briefReference 整合のみ確認（Markdown は生成しない）

例:
  node writer.js build --brief /tmp/brief.json --plan /tmp/plan.json
  node writer.js build --brief /tmp/brief.json --plan /tmp/plan.json --stories /tmp/stories.json
  node writer.js validate-input --brief /tmp/brief.json --plan /tmp/plan.json
`);
}

function parseArgs(argv) {
  const options = { help: false, brief: null, plan: null, stories: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--brief" || token === "--plan" || token === "--stories") {
      const value = argv[i + 1];
      if (value == null || value.startsWith("-")) {
        fail(`${token} には値が必要です。`);
      }
      i += 1;
      if (token === "--brief") options.brief = value;
      else if (token === "--plan") options.plan = value;
      else options.stories = value;
      continue;
    }
    fail(
      `未知のオプションです: ${token}\n使い方は node writer.js --help を参照してください。`
    );
  }
  return options;
}

function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`${label} の読み込みに失敗しました: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} JSON の解析に失敗しました: ${error.message}`);
  }
}

function loadBrief(filePath) {
  const data = readJsonFile(filePath, "Brief");
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
  const data = readJsonFile(filePath, "Plan");
  const validated = validateEditorialPlan(data);
  if (!validated.ok) {
    fail(`Plan が不正です:\n${validated.errors.join("\n")}`);
  }
  return validated.plan;
}

function cmdBuild(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.brief) fail("--brief <path> が必要です。");
  if (!options.plan) fail("--plan <path> が必要です。");

  const brief = loadBrief(options.brief);
  const plan = loadPlan(options.plan);
  const stories = options.stories
    ? readJsonFile(options.stories, "Stories")
    : null;

  try {
    const markdown = renderMarkdown(brief, plan, { stories });
    process.stdout.write(markdown);
  } catch (error) {
    fail(error.message);
  }
}

function cmdValidateInput(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.brief) fail("--brief <path> が必要です。");
  if (!options.plan) fail("--plan <path> が必要です。");

  const briefData = readJsonFile(options.brief, "Brief");
  const planData = readJsonFile(options.plan, "Plan");

  let briefPayload;
  try {
    briefPayload = extractBriefPayload(briefData);
  } catch (error) {
    fail(error.message);
  }

  const result = validateWriterInput(briefPayload, planData);
  const payload = {
    valid: result.ok,
    errors: result.errors,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
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
  else if (command === "validate-input") cmdValidateInput(rest);
  else {
    fail(
      `未知のコマンドです: ${command}\n使い方は node writer.js --help を参照してください。`
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  printHelp,
};
