const fs = require("fs");
const path = require("path");
const {
  runPipeline,
  DEFAULT_DAYS,
  DEFAULT_PURPOSE,
  DEFAULT_AUDIENCE,
  DEFAULT_LENGTH,
  DEFAULT_BASE_DIR,
} = require("./lib/pipeline-runner");

function printHelp() {
  console.log(`x-timeline-collector Pipeline Runner v1

使い方:
  node pipeline.js [options]
  node pipeline.js --help

役割:
  既存 CLI を順番に呼び出し、収集〜Markdown 草稿〜Article Report までを実行する。
  任意で Daily Edition を追加生成できる。オーケストレーションのみ。

実行順:
  connect → analyze → analyze-ai → enrich
  → editor → concept → story
  → knowledge → knowledge-base
  → brief → editorial-plan → writer
  → article-report
  → [daily-edition]   (--daily-manifest 指定時のみ)
  → Markdown (stdout のみ)

オプション:
  --days <N>                    対象日数（ローカル日付。既定: ${DEFAULT_DAYS}）
  --base-dir <path>             Knowledge Base（既定: ${DEFAULT_BASE_DIR}/）
  --plan-title <text>           Editorial Plan / Brief タイトル
  --purpose <text>              Plan purpose（既定: ${DEFAULT_PURPOSE}）
  --audience <text>             読者説明（既定: ${DEFAULT_AUDIENCE}）
  --length <N>                  目安文字数（既定: ${DEFAULT_LENGTH}）
  --output <path>               Markdown をファイルへも保存
  --report-output <path>        Article Report JSON を保存（未指定でも Report 検証は実行）
  --confidence-threshold <N>    Report の confidence 閾値（既定: 50）
  --daily-manifest <path>       Daily Edition Manifest（指定時のみ Daily Edition 実行）
  --daily-output <path>         Daily Edition Markdown 保存（--daily-manifest 時は必須）
  --daily-report-output <path>  Edition Report JSON 保存
  --no-api                      connect / analyze-ai / enrich をスキップ
  --from-enriched               --no-api と同じ
  --skip-connect                connect のみスキップ
  --work-dir <path>             中間 JSON 置き場（既定: .pipeline-work/）
  --help

例:
  node pipeline.js --no-api --days 7 --plan-title "今週のAI動向"
  node pipeline.js --no-api --output article.md --report-output article-report.json
  node pipeline.js --no-api --daily-manifest daily-manifest.json \\
    --daily-output daily-edition.md --daily-report-output daily-edition-report.json

注意:
  進捗は stderr。通常記事 Markdown のみが stdout（Daily Edition と混在しない）。
  Article Report / Daily Edition の reviewSummary.status=fail のとき Pipeline は失敗します。
`);
}

function parseArgs(argv) {
  const options = {
    help: false,
    days: DEFAULT_DAYS,
    baseDir: DEFAULT_BASE_DIR,
    planTitle: null,
    purpose: DEFAULT_PURPOSE,
    audience: DEFAULT_AUDIENCE,
    length: DEFAULT_LENGTH,
    output: null,
    reportOutput: null,
    confidenceThreshold: 50,
    dailyManifest: null,
    dailyOutput: null,
    dailyReportOutput: null,
    noApi: false,
    fromEnriched: false,
    skipConnect: false,
    workDir: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    const needValue = [
      "--days",
      "--base-dir",
      "--plan-title",
      "--purpose",
      "--audience",
      "--length",
      "--output",
      "--report-output",
      "--confidence-threshold",
      "--daily-manifest",
      "--daily-output",
      "--daily-report-output",
      "--work-dir",
    ];
    if (needValue.includes(token)) {
      const value = argv[i + 1];
      if (value == null || value.startsWith("-")) {
        console.error(`${token} には値が必要です。`);
        process.exit(1);
      }
      i += 1;
      if (token === "--days") {
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          console.error("--days は 1 以上の整数である必要があります。");
          process.exit(1);
        }
        options.days = Number(value);
      } else if (token === "--base-dir") options.baseDir = value;
      else if (token === "--plan-title") options.planTitle = value;
      else if (token === "--purpose") options.purpose = value;
      else if (token === "--audience") options.audience = value;
      else if (token === "--length") {
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          console.error("--length は 1 以上の整数である必要があります。");
          process.exit(1);
        }
        options.length = Number(value);
      } else if (token === "--output") options.output = value;
      else if (token === "--report-output") options.reportOutput = value;
      else if (token === "--confidence-threshold") {
        if (!/^\d+$/.test(value)) {
          console.error("--confidence-threshold は整数である必要があります。");
          process.exit(1);
        }
        options.confidenceThreshold = Number(value);
      } else if (token === "--daily-manifest") options.dailyManifest = value;
      else if (token === "--daily-output") options.dailyOutput = value;
      else if (token === "--daily-report-output") {
        options.dailyReportOutput = value;
      } else if (token === "--work-dir") options.workDir = value;
      continue;
    }
    if (token === "--no-api") {
      options.noApi = true;
      continue;
    }
    if (token === "--from-enriched") {
      options.fromEnriched = true;
      continue;
    }
    if (token === "--skip-connect") {
      options.skipConnect = true;
      continue;
    }
    console.error(
      `未知のオプションです: ${token}\n使い方は node pipeline.js --help を参照してください。`
    );
    process.exit(1);
  }

  return options;
}

function logProgress(message) {
  process.stderr.write(`${message}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.dailyManifest && !options.dailyOutput) {
    console.error("--daily-manifest 指定時は --daily-output が必要です。");
    process.exit(1);
  }

  const rootDir = process.cwd();
  const workDir = options.workDir
    ? path.resolve(rootDir, options.workDir)
    : path.join(rootDir, ".pipeline-work");

  logProgress("[pipeline] Pipeline Runner v1");
  logProgress(`[pipeline] days=${options.days} baseDir=${options.baseDir}`);
  if (options.noApi || options.fromEnriched) {
    logProgress("[pipeline] mode=no-api (reuse timeline_enriched.json)");
  }

  const result = runPipeline(
    {
      rootDir,
      days: options.days,
      baseDir: options.baseDir,
      planTitle: options.planTitle,
      purpose: options.purpose,
      audience: options.audience,
      length: options.length,
      noApi: options.noApi,
      fromEnriched: options.fromEnriched,
      skipConnect: options.skipConnect,
      workDir,
      reportOutput: options.reportOutput,
      confidenceThreshold: options.confidenceThreshold,
      dailyManifest: options.dailyManifest,
      dailyOutput: options.dailyOutput,
      dailyReportOutput: options.dailyReportOutput,
    },
    {
      log: logProgress,
    }
  );

  if (!result.ok) {
    logProgress("[pipeline] FAILED");
    logProgress(
      `[pipeline] completed: ${
        result.completedSteps.length
          ? result.completedSteps.join(" → ")
          : "(none)"
      }`
    );
    if (result.failedStep) {
      logProgress(`[pipeline] failed at: ${result.failedStep}`);
    }
    if (result.error) {
      process.stderr.write(`${result.error.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  logProgress(`[pipeline] completed: ${result.completedSteps.join(" → ")}`);
  logProgress(`[pipeline] knowledge: ${result.knowledgeIds.join(", ")}`);
  if (result.report && result.report.reviewSummary) {
    logProgress(
      `[pipeline] report: status=${result.report.reviewSummary.status} readyForAiRewrite=${result.report.reviewSummary.readyForAiRewrite}`
    );
  }
  if (options.reportOutput) {
    logProgress(
      `[pipeline] report wrote: ${path.resolve(rootDir, options.reportOutput)}`
    );
  }
  if (result.dailyOutputPath) {
    logProgress(`[pipeline] daily edition wrote: ${result.dailyOutputPath}`);
  }
  if (options.dailyReportOutput && result.dailyReportPath) {
    logProgress(
      `[pipeline] daily report wrote: ${result.dailyReportPath}`
    );
  }

  if (options.output) {
    const outPath = path.resolve(rootDir, options.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.markdown, "utf8");
    logProgress(`[pipeline] markdown wrote: ${outPath}`);
  }

  // stdout: single-article Markdown only (never Daily Edition)
  process.stdout.write(result.markdown);
}

if (require.main === module) {
  main();
}

module.exports = {
  printHelp,
  parseArgs,
};
