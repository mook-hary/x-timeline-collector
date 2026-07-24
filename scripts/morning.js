#!/usr/bin/env node
/**
 * EP-026 — Safe Morning Runner.
 * Orchestrates Collect → Analyze → AI Analyze → Enrich → Digest Reader only.
 * Does not call pipeline.js, site/, Writer, Knowledge, or git.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  emptyUsage,
  parseUsageFromOutput,
  formatMorningUsageSummary,
} = require("../lib/api-usage");
const {
  HISTORY_REL,
  buildMorningHistoryEntry,
  resolveHistoryPath,
  recordMorningUsage,
} = require("../lib/api-usage-history");
const { parseStageItemCount } = require("../lib/morning-health");

const AI_LIMIT = "50";
const ENRICHED_REL = path.join("output", "timeline_enriched.json");
const READER_HTML_REL = path.join("output", "digest-reader", "index.html");

const READER_FLAGS_WITH_VALUE = new Set([
  "--from",
  "--to",
  "--category",
  "--min-importance",
  "--top",
]);
const READER_FLAGS_BOOLEAN = new Set(["--today", "--full"]);

function printHelp() {
  process.stdout.write(`x-timeline-collector Morning Runner

Usage:
  npm run morning -- [options]
  node scripts/morning.js [options]

Default steps:
  1. node connect.js --once
  2. node analyze.js
  3. node analyze_ai.js --limit ${AI_LIMIT}
  4. node enrich_ai.js --limit ${AI_LIMIT}
  5. node scripts/build-digest-reader.js [reader options]

Options:
  --skip-collect     Skip Collect
  --skip-ai          Collect (unless skipped) → Analyze → Reader
                     (uses existing timeline_enriched.json)
  --skip-reader      Stop after Enrich (no Digest Reader step)
  --from-enriched    Reader only (uses existing timeline_enriched.json)
  --open             open output/digest-reader/index.html after success
  --help, -h         Show this help (does nothing else)

Reader options (passed through):
  --today
  --from <YYYY-MM-DD>
  --to <YYYY-MM-DD>
  --category <name>
  --min-importance <1-5>
  --top <N>
  --full

Input / Output:
  Private files under output/ only. Does not write site/.

API:
  analyze_ai / enrich need OPENAI_API_KEY when those steps run.

Chrome:
  Required for Collect (CDP port 9222, logged in to x.com/home).

Notes:
  Does not call pipeline.js.
  AI steps run at most once each per morning invocation.
`);
}

function failParse(message) {
  const err = new Error(message);
  err.code = "morning-parse";
  throw err;
}

/**
 * @param {string[]} argv
 */
function parseMorningArgs(argv) {
  const options = {
    help: false,
    skipCollect: false,
    skipAi: false,
    skipReader: false,
    fromEnriched: false,
    open: false,
    readerArgs: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--skip-collect") {
      options.skipCollect = true;
      continue;
    }
    if (token === "--skip-ai") {
      options.skipAi = true;
      continue;
    }
    if (token === "--skip-reader") {
      options.skipReader = true;
      continue;
    }
    if (token === "--from-enriched") {
      options.fromEnriched = true;
      continue;
    }
    if (token === "--open") {
      options.open = true;
      continue;
    }
    if (READER_FLAGS_BOOLEAN.has(token)) {
      options.readerArgs.push(token);
      continue;
    }
    if (READER_FLAGS_WITH_VALUE.has(token)) {
      const value = argv[i + 1];
      if (value == null || value.startsWith("-")) {
        failParse(`${token} には値が必要です。`);
      }
      options.readerArgs.push(token, value);
      i += 1;
      continue;
    }
    failParse(`不明なオプション: ${token}`);
  }

  if (options.fromEnriched && options.skipAi) {
    // from-enriched is stricter; keep both flags but plan uses from-enriched only.
  }

  return options;
}

/**
 * @param {ReturnType<typeof parseMorningArgs>} options
 */
function buildMorningPlan(options) {
  /** @type {{ id: string, label: string, script: string, args: string[] }[]} */
  const steps = [];

  if (options.fromEnriched) {
    steps.push({
      id: "reader",
      label: "Digest Reader",
      script: path.join("scripts", "build-digest-reader.js"),
      args: [...options.readerArgs],
    });
    return {
      steps,
      warnStaleEnriched: true,
      requireEnriched: true,
    };
  }

  if (!options.skipCollect) {
    steps.push({
      id: "collect",
      label: "Collect",
      script: "connect.js",
      args: ["--once"],
    });
  }

  steps.push({
    id: "analyze",
    label: "Analyze",
    script: "analyze.js",
    args: [],
  });

  if (!options.skipAi) {
    steps.push({
      id: "analyze-ai",
      label: "AI Analyze",
      script: "analyze_ai.js",
      args: ["--limit", AI_LIMIT],
    });
    steps.push({
      id: "enrich",
      label: "AI Enrich",
      script: "enrich_ai.js",
      args: ["--limit", AI_LIMIT],
    });
  }

  if (!options.skipReader) {
    steps.push({
      id: "reader",
      label: "Digest Reader",
      script: path.join("scripts", "build-digest-reader.js"),
      args: [...options.readerArgs],
    });
  }

  return {
    steps,
    warnStaleEnriched: options.skipAi === true,
    requireEnriched: options.skipAi === true,
  };
}

function formatCommand(script, args) {
  return ["node", script, ...args].join(" ");
}

/**
 * @param {object} options
 * @param {object} [deps]
 */
function runMorning(options, deps = {}) {
  const rootDir = path.resolve(deps.rootDir || process.cwd());
  const log = deps.log || ((line) => process.stderr.write(`${line}\n`));
  const spawn =
    deps.spawn ||
    ((command, args, spawnOpts) => spawnSync(command, args, spawnOpts));
  const openFn =
    deps.openFn ||
    ((filePath) =>
      spawnSync("open", [filePath], {
        cwd: rootDir,
        encoding: "utf8",
      }));
  const existsSync = deps.existsSync || ((p) => fs.existsSync(p));

  if (options.help) {
    printHelp();
    return { ok: true, stepsRun: [], opened: false };
  }

  const now =
    typeof deps.now === "function"
      ? deps.now
      : () => new Date().toISOString();
  const startedAt = now();

  const plan = buildMorningPlan(options);
  const enrichedPath = path.join(rootDir, ENRICHED_REL);

  if (plan.requireEnriched && !existsSync(enrichedPath)) {
    log("[Morning] ERROR: timeline_enriched.json が見つかりません。");
    log(`[Morning] 期待パス: ${ENRICHED_REL}`);
    const err = new Error("timeline_enriched.json missing");
    err.code = "morning-missing-enriched";
    err.exitCode = 1;
    throw err;
  }

  if (plan.warnStaleEnriched) {
    log("既存の timeline_enriched.json を使用します。");
    log("最新データではない可能性があります。");
  }

  const forbidden = ["pipeline.js", path.join("lib", "pipeline-runner.js")];
  for (const step of plan.steps) {
    for (const bad of forbidden) {
      if (step.script === bad || step.script.endsWith(bad)) {
        const err = new Error("Morning must not invoke pipeline");
        err.code = "morning-forbidden";
        throw err;
      }
    }
  }

  const total = plan.steps.length;
  const stepsRun = [];
  /** @type {object[]} */
  const stages = [];
  const usageByStep = {
    analyze: emptyUsage(),
    enrich: emptyUsage(),
  };

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const index = i + 1;
    log(`[Morning] ${index}/${total} ${step.label}`);
    const stageStartedAt = now();

    const scriptPath = path.join(rootDir, step.script);
    const result = spawn(process.execPath, [scriptPath, ...step.args], {
      cwd: rootDir,
      encoding: "utf8",
      env: deps.env || process.env,
      stdio: deps.stdio || ["ignore", "pipe", "pipe"],
    });

    const stageFinishedAt = now();
    const combinedOut = `${result.stdout || ""}\n${result.stderr || ""}`;
    const itemCount = parseStageItemCount(step.id, combinedOut);
    const stageRecord = {
      id: step.id,
      label: step.label,
      startedAt: stageStartedAt,
      finishedAt: stageFinishedAt,
      durationMs: Math.max(
        0,
        Date.parse(stageFinishedAt) - Date.parse(stageStartedAt) || 0
      ),
      ok: true,
      itemCount,
    };

    const status = result.status;
    if (status !== 0 || result.error) {
      const code = result.error ? 1 : status == null ? 1 : status;
      log(`[Morning] ERROR step=${step.label}`);
      log(`[Morning] command=${formatCommand(step.script, step.args)}`);
      log(`[Morning] exit code=${code}`);
      if (result.error) {
        log(`[Morning] spawn error=${result.error.message}`);
      }
      stageRecord.ok = false;
      stages.push(stageRecord);
      const err = new Error(
        `${step.label} failed (exit ${code}): ${formatCommand(
          step.script,
          step.args
        )}`
      );
      err.code = "morning-step";
      err.step = step;
      err.exitCode = code;
      err.result = result;
      err.stages = stages.slice();
      throw err;
    }

    const parsedUsage = parseUsageFromOutput(combinedOut);
    if (parsedUsage) {
      if (step.id === "analyze-ai") {
        usageByStep.analyze = parsedUsage;
      } else if (step.id === "enrich") {
        usageByStep.enrich = parsedUsage;
      }
    }

    stages.push(stageRecord);
    log(`[Morning] ${step.label} complete`);
    stepsRun.push(step.id);
  }

  let opened = false;
  if (options.open) {
    const htmlPath = path.join(rootDir, READER_HTML_REL);
    if (!existsSync(htmlPath)) {
      log(`[Morning] ERROR: Reader HTML がありません: ${READER_HTML_REL}`);
      const err = new Error("reader html missing for --open");
      err.code = "morning-open";
      err.exitCode = 1;
      throw err;
    }
    const openResult = openFn(htmlPath);
    if (openResult && openResult.status != null && openResult.status !== 0) {
      log(`[Morning] ERROR: open failed (exit ${openResult.status})`);
      const err = new Error(`open failed (exit ${openResult.status})`);
      err.code = "morning-open";
      err.exitCode = openResult.status;
      throw err;
    }
    opened = true;
    log("[Morning] Opened Digest Reader");
  }

  // Always print Morning Summary at successful end (zeros when AI skipped).
  const env = deps.env || process.env;
  log(
    formatMorningUsageSummary(
      {
        analyze: usageByStep.analyze,
        enrich: usageByStep.enrich,
      },
      { model: env.OPENAI_MODEL }
    )
  );

  // EP-033: persist usage history once on success only (never fail Morning).
  const finishedAt = now();
  let historySaved = false;
  try {
    const recordFn =
      typeof deps.recordUsageHistory === "function"
        ? deps.recordUsageHistory
        : recordMorningUsage;
    const historyPath = deps.historyPath || resolveHistoryPath(rootDir);
    const entry = buildMorningHistoryEntry({
      startedAt,
      finishedAt,
      model: env.OPENAI_MODEL,
      analyze: usageByStep.analyze,
      enrich: usageByStep.enrich,
      runOptions: {
        skipCollect: options.skipCollect === true,
        skipAi: options.skipAi === true,
        fromEnriched: options.fromEnriched === true,
      },
    });
    const result = recordFn(historyPath, entry);
    historySaved = !!(result && result.ok !== false);
    const displayPath = (result && result.path) || historyPath;
    const rel =
      path.isAbsolute(displayPath) &&
      displayPath.startsWith(rootDir + path.sep)
        ? path.relative(rootDir, displayPath)
        : displayPath;
    log(`[Morning] Usage history saved: ${rel || HISTORY_REL}`);
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    log(`[Morning] WARNING: failed to save usage history: ${reason}`);
  }

  log("[Morning] Done");
  return {
    ok: true,
    stepsRun,
    stages,
    opened,
    plan,
    usage: usageByStep,
    historySaved,
    startedAt,
    finishedAt,
  };
}

function main() {
  let options;
  try {
    options = parseMorningArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[Morning] ${error.message}\n`);
    process.exit(1);
  }

  try {
    runMorning(options);
  } catch (error) {
    const code = Number.isInteger(error.exitCode) ? error.exitCode : 1;
    process.exit(code);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  AI_LIMIT,
  ENRICHED_REL,
  READER_HTML_REL,
  HISTORY_REL,
  parseMorningArgs,
  buildMorningPlan,
  runMorning,
  printHelp,
  formatCommand,
};
