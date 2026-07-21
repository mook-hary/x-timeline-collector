const fs = require("fs");
const path = require("path");
const {
  EXIT,
  planLaunchd,
  generatePlist,
  validatePlistFile,
  installLaunchd,
  uninstallLaunchd,
  statusLaunchd,
  printInstalledPlist,
} = require("./lib/launchd-adapter");
const { DEFAULT_LABEL } = require("./lib/launchd-core");

function printHelp() {
  console.log(`x-timeline-collector Launchd Adapter v1

使い方:
  node launchd.js plan --hour <H> --minute <M> --timezone <TZ> [options]
  node launchd.js generate --hour <H> --minute <M> --timezone <TZ> [options]
  node launchd.js validate-plist --input <path>
  node launchd.js install --hour <H> --minute <M> --timezone <TZ> [options]
  node launchd.js uninstall [--label <label>]
  node launchd.js status [--label <label>]
  node launchd.js print-plist [--label <label>]
  node launchd.js --help

役割:
  Daily Runner 用の macOS ユーザー LaunchAgent plist を生成・検証・登録する。
  記事生成ロジックは持たない。system daemon / root は対象外。

必須（plan / generate / install）:
  --hour <0-23> --minute <0-59> --timezone <IANA>

主なオプション:
  --label <label>                 既定: ${DEFAULT_LABEL}
  --weekdays <csv>                例: 1,2,3,4,5（1=Sun … 7=Sat。省略時は毎日）
  --node <absolute-path>          Node.js（省略時は process.execPath）
  --project-dir <path>
  --runs-dir / --base-dir / --log-dir
  --days / --plan-title / --purpose / --audience / --length
  --category / --confidence-threshold / --stale-lock-minutes
  --no-api / --from-enriched
  --run-at-load
  --replace                       既存異なる plist を置換（backup 付き）
  --output <path>                 generate 時のみ保存

例（登録なし・検証のみ）:
  node launchd.js plan --hour 9 --minute 30 --timezone Asia/Tokyo --no-api
  node launchd.js generate --hour 9 --minute 30 --timezone Asia/Tokyo --no-api --output /tmp/daily-runner.plist

注意:
  実登録は install の明示実行時のみ。通常テストでは launchctl を呼びません。
  Chrome は自動起動しません。APIキーを plist へ保存しません。
`);
}

function parseArgs(argv) {
  const options = {
    help: false,
    label: null,
    hour: null,
    minute: null,
    weekdays: null,
    timezone: null,
    node: null,
    projectDir: null,
    runsDir: null,
    baseDir: null,
    logDir: null,
    days: null,
    planTitle: null,
    purpose: null,
    audience: null,
    length: null,
    category: null,
    confidenceThreshold: null,
    staleLockMinutes: null,
    noApi: false,
    fromEnriched: false,
    runAtLoad: false,
    replace: false,
    output: null,
    input: null,
  };

  const needValue = new Set([
    "--label",
    "--hour",
    "--minute",
    "--weekdays",
    "--timezone",
    "--node",
    "--project-dir",
    "--runs-dir",
    "--base-dir",
    "--log-dir",
    "--days",
    "--plan-title",
    "--purpose",
    "--audience",
    "--length",
    "--category",
    "--confidence-threshold",
    "--stale-lock-minutes",
    "--output",
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
      if (token === "--label") options.label = value;
      else if (token === "--hour") {
        if (!/^\d+$/.test(value)) {
          const err = new Error("--hour は整数である必要があります。");
          err.exitCode = EXIT.VALIDATION;
          throw err;
        }
        options.hour = Number(value);
      } else if (token === "--minute") {
        if (!/^\d+$/.test(value)) {
          const err = new Error("--minute は整数である必要があります。");
          err.exitCode = EXIT.VALIDATION;
          throw err;
        }
        options.minute = Number(value);
      } else if (token === "--weekdays") options.weekdays = value;
      else if (token === "--timezone") options.timezone = value;
      else if (token === "--node") options.node = value;
      else if (token === "--project-dir") options.projectDir = value;
      else if (token === "--runs-dir") options.runsDir = value;
      else if (token === "--base-dir") options.baseDir = value;
      else if (token === "--log-dir") options.logDir = value;
      else if (token === "--days") {
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          const err = new Error("--days は 1 以上の整数である必要があります。");
          err.exitCode = EXIT.VALIDATION;
          throw err;
        }
        options.days = Number(value);
      } else if (token === "--plan-title") options.planTitle = value;
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
      } else if (token === "--output") options.output = value;
      else if (token === "--input") options.input = value;
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
    if (token === "--run-at-load") {
      options.runAtLoad = true;
      continue;
    }
    if (token === "--replace") {
      options.replace = true;
      continue;
    }
    const err = new Error(
      `未知のオプションです: ${token}\n使い方は node launchd.js --help を参照してください。`
    );
    err.exitCode = EXIT.VALIDATION;
    throw err;
  }

  return options;
}

function toRawOptions(options) {
  return {
    label: options.label,
    hour: options.hour,
    minute: options.minute,
    weekdays: options.weekdays,
    timezone: options.timezone,
    node: options.node,
    nodePath: options.node,
    projectDir: options.projectDir,
    runsDir: options.runsDir,
    baseDir: options.baseDir,
    logDir: options.logDir,
    days: options.days,
    planTitle: options.planTitle,
    purpose: options.purpose,
    audience: options.audience,
    length: options.length,
    category: options.category,
    confidenceThreshold: options.confidenceThreshold,
    staleLockMinutes: options.staleLockMinutes,
    noApi: options.noApi,
    fromEnriched: options.fromEnriched,
    runAtLoad: options.runAtLoad,
    replace: options.replace,
  };
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeAtomicFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function requireSchedule(options) {
  if (options.hour == null || options.minute == null || !options.timezone) {
    const err = new Error(
      "--hour / --minute / --timezone は必須です。"
    );
    err.exitCode = EXIT.VALIDATION;
    throw err;
  }
}

function cmdPlan(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return EXIT.OK;
  }
  requireSchedule(options);
  const plan = planLaunchd(toRawOptions(options), {}, path.resolve(__dirname));
  // omit plistXml from stdout plan for brevity — include hash only
  const { ...rest } = plan;
  writeJson(rest);
  return EXIT.OK;
}

function cmdGenerate(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return EXIT.OK;
  }
  requireSchedule(options);
  const generated = generatePlist(
    toRawOptions(options),
    {},
    path.resolve(__dirname)
  );
  process.stderr.write(
    `[launchd] plistHash=${generated.plistHash} label=${generated.plan.label}\n`
  );
  if (options.output) {
    writeAtomicFile(path.resolve(options.output), generated.plistXml);
    process.stderr.write(`[launchd] wrote ${path.resolve(options.output)}\n`);
  }
  process.stdout.write(generated.plistXml);
  if (!generated.plistXml.endsWith("\n")) process.stdout.write("\n");
  return EXIT.OK;
}

function cmdValidatePlist(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return EXIT.OK;
  }
  if (!options.input) {
    process.stderr.write("--input <path> が必要です。\n");
    return EXIT.VALIDATION;
  }
  const result = validatePlistFile(options.input);
  writeJson({
    valid: result.ok,
    errors: result.errors,
    extracted: result.extracted,
    plutil: result.plutil,
  });
  return result.ok ? EXIT.OK : EXIT.PLIST_INVALID;
}

function cmdInstall(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return EXIT.OK;
  }
  requireSchedule(options);
  try {
    const result = installLaunchd(
      toRawOptions(options),
      {},
      path.resolve(__dirname)
    );
    writeJson(result);
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return error.exitCode || EXIT.FAILURE;
  }
}

function cmdUninstall(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return EXIT.OK;
  }
  try {
    const result = uninstallLaunchd(
      toRawOptions(options),
      {},
      path.resolve(__dirname)
    );
    writeJson(result);
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return error.exitCode || EXIT.FAILURE;
  }
}

function cmdStatus(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return EXIT.OK;
  }
  try {
    const result = statusLaunchd(
      toRawOptions(options),
      {},
      path.resolve(__dirname)
    );
    writeJson(result);
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return error.exitCode || EXIT.FAILURE;
  }
}

function cmdPrintPlist(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return EXIT.OK;
  }
  try {
    const xml = printInstalledPlist(
      toRawOptions(options),
      {},
      path.resolve(__dirname)
    );
    process.stdout.write(xml);
    if (!xml.endsWith("\n")) process.stdout.write("\n");
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return error.exitCode || EXIT.FAILURE;
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
  let code = EXIT.OK;

  try {
    if (command === "plan") code = cmdPlan(rest);
    else if (command === "generate") code = cmdGenerate(rest);
    else if (command === "validate-plist") code = cmdValidatePlist(rest);
    else if (command === "install") code = cmdInstall(rest);
    else if (command === "uninstall") code = cmdUninstall(rest);
    else if (command === "status") code = cmdStatus(rest);
    else if (command === "print-plist") code = cmdPrintPlist(rest);
    else {
      process.stderr.write(
        `未知のコマンドです: ${command}\n使い方は node launchd.js --help を参照してください。\n`
      );
      code = EXIT.VALIDATION;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    code = error.exitCode || EXIT.VALIDATION;
  }

  if (code !== EXIT.OK) process.exitCode = code;
}

if (require.main === module) {
  main();
}

module.exports = {
  printHelp,
  parseArgs,
  EXIT,
};
