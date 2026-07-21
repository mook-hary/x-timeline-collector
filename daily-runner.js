const path = require("path");
const fs = require("fs");
const { planDailyRun, runDailyRun } = require("./lib/daily-runner");
const { validateDailyRunReport } = require("./lib/daily-runner-core");

const EXIT = {
  OK: 0,
  EXECUTION: 1,
  VALIDATION: 2,
  LOCK: 3,
  COMPLETED: 4,
  REPORT: 5,
};

function printHelp() {
  console.log(`x-timeline-collector Daily Runner v1

使い方:
  node daily-runner.js run [options]
  node daily-runner.js plan [options]
  node daily-runner.js validate --input <run-report.json>
  node daily-runner.js --help

役割:
  1日分の Pipeline + Daily Edition を安全に実行する運用オーケストレーション層。
  記事生成・編集ロジックは持たない。OS スケジューラ登録は行わない。

主なオプション:
  --date <YYYY-MM-DD>           実行日（省略時は timezone のローカル日付）
  --timezone <IANA>             例: Asia/Tokyo
  --runs-dir <path>             成果物ルート（既定: ./runs）
  --run-id <id>                 Run ID（任意）
  --days <N>                    Pipeline 対象日数（既定: 1）
  --base-dir <path>             Knowledge Base
  --plan-title / --purpose / --audience / --length
  --category <category>         Daily Edition カテゴリ（既定: other。推測しない）
  --confidence-threshold <N>
  --no-api / --from-enriched
  --retry                       failed 同日 run の再実行
  --recover-stale-lock          stale lock 回収
  --stale-lock-minutes <N>      既定: 180
  --dry-run                     実行せず計画のみ

例:
  node daily-runner.js plan --date 2026-07-21 --timezone Asia/Tokyo --no-api
  node daily-runner.js run --date 2026-07-21 --timezone Asia/Tokyo --days 1 --category other --no-api

stdout は JSON のみ。進捗は stderr。Markdown は混在させません。
exit: 0成功 / 1実行失敗 / 2CLI検証 / 3lock / 4completed済 / 5Report検証
`);
}

function parseArgs(argv) {
  const options = {
    help: false,
    date: null,
    timezone: null,
    runsDir: "runs",
    runId: null,
    days: 1,
    baseDir: "knowledge-base",
    planTitle: null,
    purpose: null,
    audience: null,
    length: null,
    category: "other",
    confidenceThreshold: 50,
    noApi: false,
    fromEnriched: false,
    retry: false,
    recoverStaleLock: false,
    staleLockMinutes: 180,
    dryRun: false,
    input: null,
  };

  const needValue = new Set([
    "--date",
    "--timezone",
    "--runs-dir",
    "--run-id",
    "--days",
    "--base-dir",
    "--plan-title",
    "--purpose",
    "--audience",
    "--length",
    "--category",
    "--confidence-threshold",
    "--stale-lock-minutes",
    "--input",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (needValue.has(token)) {
      const value = argv[i + 1];
      if (value == null || value.startsWith("-")) {
        const err = new Error(`${token} には値が必要です。`);
        err.exitCode = EXIT.VALIDATION;
        throw err;
      }
      i += 1;
      if (token === "--date") options.date = value;
      else if (token === "--timezone") options.timezone = value;
      else if (token === "--runs-dir") options.runsDir = value;
      else if (token === "--run-id") options.runId = value;
      else if (token === "--days") {
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          const err = new Error("--days は 1 以上の整数である必要があります。");
          err.exitCode = EXIT.VALIDATION;
          throw err;
        }
        options.days = Number(value);
      } else if (token === "--base-dir") options.baseDir = value;
      else if (token === "--plan-title") options.planTitle = value;
      else if (token === "--purpose") options.purpose = value;
      else if (token === "--audience") options.audience = value;
      else if (token === "--length") {
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          const err = new Error("--length は 1 以上の整数である必要があります。");
          err.exitCode = EXIT.VALIDATION;
          throw err;
        }
        options.length = Number(value);
      } else if (token === "--category") options.category = value;
      else if (token === "--confidence-threshold") {
        if (!/^\d+$/.test(value)) {
          const err = new Error(
            "--confidence-threshold は整数である必要があります。"
          );
          err.exitCode = EXIT.VALIDATION;
          throw err;
        }
        options.confidenceThreshold = Number(value);
      } else if (token === "--stale-lock-minutes") {
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          const err = new Error(
            "--stale-lock-minutes は 1 以上の整数である必要があります。"
          );
          err.exitCode = EXIT.VALIDATION;
          throw err;
        }
        options.staleLockMinutes = Number(value);
      } else if (token === "--input") options.input = value;
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
    if (token === "--retry") {
      options.retry = true;
      continue;
    }
    if (token === "--recover-stale-lock") {
      options.recoverStaleLock = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const err = new Error(
      `未知のオプションです: ${token}\n使い方は node daily-runner.js --help を参照してください。`
    );
    err.exitCode = EXIT.VALIDATION;
    throw err;
  }

  return options;
}

function writeStdoutJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function cmdPlan(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return EXIT.OK;
  }
  const result = planDailyRun(options, {
    rootDir: process.cwd(),
    now: new Date(),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  if (!result.ok) {
    process.stderr.write(`${result.errors.join("\n")}\n`);
    return EXIT.VALIDATION;
  }
  writeStdoutJson(result.plan);
  return EXIT.OK;
}

async function cmdRun(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return EXIT.OK;
  }

  try {
    const result = await runDailyRun(options, {
      rootDir: process.cwd(),
      now: new Date(),
      log: (m) => process.stderr.write(`${m}\n`),
    });

    if (result.dryRun) {
      writeStdoutJson(result.plan);
      return EXIT.OK;
    }

    writeStdoutJson({
      success: true,
      status: result.status,
      runId: result.runId,
      runDate: result.runDate,
      runReport: result.runReport,
      dailyEdition: result.dailyEdition,
      attempt: result.attempt,
    });
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error.runReportPath) {
      process.stderr.write(`run-report: ${error.runReportPath}\n`);
    }
    if (error.skipped || error.reason === "already_completed") {
      writeStdoutJson({
        success: false,
        status: "skipped",
        reason: error.reason || "already_completed",
        message: error.message,
      });
      return EXIT.COMPLETED;
    }
    return error.exitCode || EXIT.EXECUTION;
  }
}

function cmdValidate(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return EXIT.OK;
  }
  if (!options.input) {
    process.stderr.write("--input <path> が必要です。\n");
    return EXIT.VALIDATION;
  }
  const inputPath = path.resolve(options.input);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (error) {
    process.stderr.write(`読み込み失敗: ${error.message}\n`);
    return EXIT.VALIDATION;
  }
  const result = validateDailyRunReport(data);
  writeStdoutJson({ valid: result.ok, errors: result.errors });
  if (!result.ok) {
    for (const err of result.errors) {
      process.stderr.write(`${err}\n`);
    }
    return EXIT.REPORT;
  }
  return EXIT.OK;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return;
  }

  const command = argv[0];
  const rest = argv.slice(1);

  try {
    let code = EXIT.OK;
    if (command === "run") code = await cmdRun(rest);
    else if (command === "plan") code = cmdPlan(rest);
    else if (command === "validate") code = cmdValidate(rest);
    else {
      process.stderr.write(
        `未知のコマンドです: ${command}\n使い方は node daily-runner.js --help を参照してください。\n`
      );
      code = EXIT.VALIDATION;
    }
    if (code !== EXIT.OK) process.exitCode = code;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode || EXIT.VALIDATION;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  printHelp,
  parseArgs,
  EXIT,
};
