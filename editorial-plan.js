const fs = require("fs");
const { fail } = require("./lib/pipeline-io");
const { validateBrief, extractBriefPayload } = require("./lib/brief-core");
const {
  createEditorialPlan,
  validateEditorialPlan,
  DEFAULT_PURPOSE,
  DEFAULT_FORMAT,
  DEFAULT_LANGUAGE,
  DEFAULT_LENGTH_TARGET,
} = require("./lib/editorial-plan-core");

function printHelp() {
  console.log(`x-timeline-collector Editorial Plan

使い方:
  node editorial-plan.js build [options]
  node editorial-plan.js validate --input <path>
  node editorial-plan.js --help

役割:
  Knowledge Brief を Writer へ渡す前に、誰に・何を・どの形式で・どの長さで
  伝えるかを定義する人間入力の執筆方針。
  AI・記事本文生成・Brief 変更・Knowledge Base 読込みは行いません。
  Plan は保存しません（標準出力のみ）。

build:
  --brief <path>              Brief JSON（任意・読み取り専用）
  --id <plan-id>              Plan id（未指定時は自動生成）
  --title <text>              企画タイトル（未指定時は Brief title → 既定）
  --purpose <text>            目的（既定: explain）
  --audience <text>           読者説明
  --knowledge-level <level>   beginner|intermediate|advanced|expert|unspecified
  --format <text>             記事形式（既定: article。推奨値以外も可）
  --tone <text>               文体 style（既定: clear）
  --formality <level>         casual|neutral|formal（既定: neutral）
  --language <code>           出力言語（既定: ja）
  --length <N>                目安文字数/語数（既定: 1200）
  --min-length <N>
  --max-length <N>
  --length-unit <unit>        characters|words（既定: characters）
  --section <label>           構成セクション（複数可。未指定時は導入/本文/まとめ）
  --required <text>           必須観点（複数可）
  --exclude <text>            禁止内容（複数可）
  --constraint <text>         Plan 制約（複数可。Brief constraints はコピーしない）

validate:
  --input <path>              Plan JSON（読み取り専用）

例:
  node editorial-plan.js build --brief /tmp/brief.json --title "AIエージェント入門" \\
    --audience "AI初心者" --knowledge-level beginner --format explainer --length 1200
  node editorial-plan.js validate --input /tmp/plan.json
`);
}

function parseArgs(argv, specs) {
  const options = {
    help: false,
    brief: null,
    input: null,
    id: null,
    title: null,
    purpose: DEFAULT_PURPOSE,
    audience: null,
    knowledgeLevel: "unspecified",
    format: DEFAULT_FORMAT,
    tone: "clear",
    formality: "neutral",
    language: DEFAULT_LANGUAGE,
    length: DEFAULT_LENGTH_TARGET,
    minLength: null,
    maxLength: null,
    lengthUnit: "characters",
    sections: [],
    requiredPoints: [],
    excludedPoints: [],
    constraints: [],
  };

  const byFlag = new Map(specs.map((spec) => [spec.flag, spec]));
  byFlag.set("--help", { flag: "--help", key: "help", type: "boolean" });
  byFlag.set("-h", { flag: "-h", key: "help", type: "boolean" });

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const spec = byFlag.get(token);
    if (!spec) {
      fail(
        `未知のオプションです: ${token}\n使い方は node editorial-plan.js --help を参照してください。`
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
        fail(`${token} には正の整数を指定してください。`);
      }
      const num = Number(value);
      if (!Number.isInteger(num) || num < 1) {
        fail(`${token} には正の整数を指定してください。`);
      }
      options[spec.key] = num;
    } else if (spec.multi) {
      options[spec.key].push(value);
    } else {
      options[spec.key] = value;
    }
  }

  return options;
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function readBriefFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`Brief ファイルの読み込みに失敗しました: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    fail(`Brief JSON の解析に失敗しました: ${error.message}`);
  }
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

function cmdBuild(argv) {
  const options = parseArgs(argv, [
    { flag: "--brief", key: "brief", type: "string" },
    { flag: "--id", key: "id", type: "string" },
    { flag: "--title", key: "title", type: "string" },
    { flag: "--purpose", key: "purpose", type: "string" },
    { flag: "--audience", key: "audience", type: "string" },
    { flag: "--knowledge-level", key: "knowledgeLevel", type: "string" },
    { flag: "--format", key: "format", type: "string" },
    { flag: "--tone", key: "tone", type: "string" },
    { flag: "--formality", key: "formality", type: "string" },
    { flag: "--language", key: "language", type: "string" },
    { flag: "--length", key: "length", type: "integer" },
    { flag: "--min-length", key: "minLength", type: "integer" },
    { flag: "--max-length", key: "maxLength", type: "integer" },
    { flag: "--length-unit", key: "lengthUnit", type: "string" },
    { flag: "--section", key: "sections", type: "string", multi: true },
    { flag: "--required", key: "requiredPoints", type: "string", multi: true },
    { flag: "--exclude", key: "excludedPoints", type: "string", multi: true },
    { flag: "--constraint", key: "constraints", type: "string", multi: true },
  ]);

  if (options.help) {
    printHelp();
    return;
  }

  let brief = null;
  if (options.brief) {
    brief = readBriefFile(options.brief);
  }

  try {
    const plan = createEditorialPlan(
      {
        id: options.id,
        title: options.title,
        purpose: options.purpose,
        audience: options.audience,
        knowledgeLevel: options.knowledgeLevel,
        format: options.format,
        tone: options.tone,
        formality: options.formality,
        language: options.language,
        length: options.length,
        minLength: options.minLength,
        maxLength: options.maxLength,
        lengthUnit: options.lengthUnit,
        sections: options.sections,
        requiredPoints: options.requiredPoints,
        excludedPoints: options.excludedPoints,
        constraints: options.constraints,
      },
      brief,
      { now: new Date() }
    );
    writeJson(plan);
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
    fail(`Plan JSON の解析に失敗しました: ${error.message}`);
  }

  const result = validateEditorialPlan(data);
  if (!result.ok) {
    for (const err of result.errors) {
      process.stderr.write(`${err}\n`);
    }
    writeJson({ valid: false, errors: result.errors });
    process.exitCode = 1;
    return;
  }
  writeJson({ valid: true, errors: [] });
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
      `未知のコマンドです: ${command}\n使い方は node editorial-plan.js --help を参照してください。`
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  printHelp,
};
