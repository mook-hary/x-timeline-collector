const fs = require("fs");
const path = require("path");
const { fail, writeJsonAtomic, ensureDir } = require("./lib/pipeline-io");
const {
  validateDailyEditionManifest,
  resolveManifestPaths,
  buildDailyEdition,
  validateEditionReport,
} = require("./lib/daily-edition-core");

function printHelp() {
  console.log(`x-timeline-collector Daily Edition Builder v1

使い方:
  node daily-edition.js build --manifest <path> [options]
  node daily-edition.js validate --input <path>
  node daily-edition.js --help

役割:
  複数の Writer Markdown + Article Report を、決定論的に日刊版 Markdown へまとめる。
  新しい事実は作らない。AI なし。Knowledge Base / Brief / Plan は読まない。
  入力ファイルは読み取り専用。

build:
  --manifest <path>          Daily Edition Manifest JSON
  --output <path>            Daily Edition Markdown を保存（atomic）
  --report-output <path>     Edition Report JSON を保存（atomic）
  --exclude-warnings         status=warning の記事を非掲載
  --edition-id <id>          Edition id（任意）

validate:
  --input <path>             Edition Report JSON

例:
  node daily-edition.js build \\
    --manifest daily-manifest.json \\
    --output daily-edition.md \\
    --report-output daily-edition-report.json

stdout は Daily Edition Markdown のみ。進捗は stderr。
`);
}

function parseArgs(argv, specs) {
  const options = {
    help: false,
    manifest: null,
    input: null,
    output: null,
    reportOutput: null,
    editionId: null,
    excludeWarnings: false,
  };

  const byFlag = new Map(specs.map((s) => [s.flag, s]));
  byFlag.set("--help", { flag: "--help", key: "help", type: "boolean" });
  byFlag.set("-h", { flag: "-h", key: "help", type: "boolean" });

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const spec = byFlag.get(token);
    if (!spec) {
      fail(
        `未知のオプションです: ${token}\n使い方は node daily-edition.js --help を参照してください。`
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
    options[spec.key] = value;
  }
  return options;
}

function logProgress(message) {
  process.stderr.write(`${message}\n`);
}

function writeTextAtomic(filePath, text) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(tmpPath, text, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_e) {
      // best-effort
    }
    fail(`ファイルの保存に失敗しました: ${filePath}\n詳細: ${error.message}`);
  }
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

function loadManifest(manifestPath) {
  const abs = path.resolve(manifestPath);
  const data = readJson(abs, "Manifest");
  const validated = validateDailyEditionManifest(data);
  if (!validated.ok) {
    fail(`Manifest が不正です:\n${validated.errors.join("\n")}`);
  }
  const withPaths = resolveManifestPaths(
    validated.manifest,
    path.dirname(abs)
  );
  return { manifest: withPaths, manifestPath: abs };
}

function loadItems(manifest) {
  return manifest.items.map((item) => {
    let markdown = null;
    let report = null;
    let markdownReadable = true;
    let reportReadable = true;

    try {
      markdown = fs.readFileSync(item.articlePath, "utf8");
    } catch (error) {
      markdownReadable = false;
      logProgress(
        `[daily-edition] warn: article 読込失敗 ${item.articlePath}: ${error.message}`
      );
    }

    try {
      const raw = fs.readFileSync(item.reportPath, "utf8");
      report = JSON.parse(raw);
    } catch (error) {
      reportReadable = false;
      logProgress(
        `[daily-edition] warn: report 読込失敗 ${item.reportPath}: ${error.message}`
      );
    }

    return {
      markdown,
      report,
      articlePath: item.articlePath,
      reportPath: item.reportPath,
      category: item.category,
      priority: item.priority,
      manifestIndex: item.manifestIndex,
      markdownReadable,
      reportReadable,
    };
  });
}

function cmdBuild(argv) {
  const options = parseArgs(argv, [
    { flag: "--manifest", key: "manifest", type: "string" },
    { flag: "--output", key: "output", type: "string" },
    { flag: "--report-output", key: "reportOutput", type: "string" },
    { flag: "--edition-id", key: "editionId", type: "string" },
    { flag: "--exclude-warnings", key: "excludeWarnings", type: "boolean" },
  ]);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.manifest) fail("--manifest <path> が必要です。");

  logProgress("[daily-edition] build start");
  const { manifest } = loadManifest(options.manifest);
  const loadedItems = loadItems(manifest);

  try {
    const result = buildDailyEdition(
      manifest,
      loadedItems,
      {
        excludeWarnings: options.excludeWarnings === true,
        editionId: options.editionId,
      },
      { now: new Date() }
    );

    if (options.output) {
      writeTextAtomic(path.resolve(options.output), result.markdown);
      logProgress(`[daily-edition] wrote markdown: ${path.resolve(options.output)}`);
    }
    if (options.reportOutput) {
      writeJsonAtomic(path.resolve(options.reportOutput), result.report);
      logProgress(
        `[daily-edition] wrote report: ${path.resolve(options.reportOutput)}`
      );
    }

    logProgress(
      `[daily-edition] included=${result.report.articles.included} excluded=${result.report.articles.excluded} publishable=${result.report.reviewSummary.publishable}`
    );

    process.stdout.write(result.markdown);
    if (!result.markdown.endsWith("\n")) {
      process.stdout.write("\n");
    }
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

  const data = readJson(path.resolve(options.input), "Edition Report");
  const result = validateEditionReport(data);
  process.stdout.write(
    `${JSON.stringify({ valid: result.ok, errors: result.errors }, null, 2)}\n`
  );
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
      `未知のコマンドです: ${command}\n使い方は node daily-edition.js --help を参照してください。`
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  printHelp,
};
