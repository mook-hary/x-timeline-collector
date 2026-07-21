const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_DAYS = 7;
const DEFAULT_PURPOSE = "explain";
const DEFAULT_AUDIENCE = "一般読者";
const DEFAULT_LENGTH = 1200;
const DEFAULT_BASE_DIR = "knowledge-base";

/**
 * Format local date as YYYY-MM-DD.
 */
function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Resolve --days into --from / --to (inclusive local dates).
 */
function resolveDateRangeFromDays(days, now = new Date()) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("--days は 1 以上の整数である必要があります。");
  }
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = new Date(to);
  from.setDate(from.getDate() - (n - 1));
  return {
    from: formatLocalDate(from),
    to: formatLocalDate(to),
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Run a project CLI script. Does not implement business logic.
 */
function runCli(rootDir, scriptName, args, options = {}) {
  const scriptPath = path.join(rootDir, scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`CLI が見つかりません: ${scriptName}`);
  }

  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: rootDir,
    encoding: "utf8",
    env: options.env || process.env,
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
  });

  return {
    script: scriptName,
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
  };
}

function assertCliOk(stepName, result) {
  if (result.error) {
    const err = new Error(
      `${stepName} の起動に失敗しました: ${result.error.message}`
    );
    err.step = stepName;
    err.result = result;
    throw err;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    const err = new Error(
      `${stepName} が失敗しました (exit ${result.status})${
        detail ? `\n${detail}` : ""
      }`
    );
    err.step = stepName;
    err.result = result;
    throw err;
  }
}

function writeTempJson(workDir, name, data) {
  const filePath = path.join(workDir, name);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return filePath;
}

function parseJsonStdout(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} の JSON 解析に失敗しました: ${error.message}`);
  }
}

function extractBriefFromCliOutput(stdout) {
  const data = parseJsonStdout(stdout, "brief");
  if (data && data.brief && typeof data.brief === "object") {
    return data.brief;
  }
  if (data && typeof data.id === "string" && Array.isArray(data.knowledge)) {
    return data;
  }
  throw new Error("brief 出力形式が不正です。");
}

function knowledgeExists(rootDir, baseDir, id) {
  const result = runCli(rootDir, "knowledge-base.js", [
    "show",
    "--id",
    id,
    "--base-dir",
    baseDir,
  ]);
  return result.status === 0;
}

/**
 * Pick Story objects from stories.js --json output for Knowledge seeding.
 * Orchestration only: uses Story id / label / description as-is.
 */
function selectStoriesForKnowledge(storiesPayload, limit = 3) {
  const stories = Array.isArray(storiesPayload?.stories)
    ? storiesPayload.stories
    : [];
  return stories.slice(0, limit);
}

/**
 * Run the end-to-end pipeline by invoking existing CLIs in order.
 *
 * @param {object} options
 * @param {object} [hooks] - { log(message), now }
 */
function runPipeline(options = {}, hooks = {}) {
  const rootDir = options.rootDir || process.cwd();
  const log = typeof hooks.log === "function" ? hooks.log : () => {};
  const now = hooks.now instanceof Date ? hooks.now : new Date();

  const days = options.days != null ? Number(options.days) : DEFAULT_DAYS;
  const range = resolveDateRangeFromDays(days, now);
  const baseDir = path.resolve(
    rootDir,
    options.baseDir || DEFAULT_BASE_DIR
  );
  const purpose = options.purpose || DEFAULT_PURPOSE;
  const audience = options.audience || DEFAULT_AUDIENCE;
  const length = options.length != null ? Number(options.length) : DEFAULT_LENGTH;
  const planTitle = options.planTitle || null;
  const noApi = options.noApi === true;
  const skipConnect = options.skipConnect === true || noApi;
  const skipAi = options.skipAi === true || noApi;
  const fromEnriched = options.fromEnriched === true || noApi;
  const knowledgeLimit =
    options.knowledgeLimit != null ? Number(options.knowledgeLimit) : 3;

  const workDir = options.workDir || path.join(rootDir, ".pipeline-work");
  ensureDir(workDir);

  const completedSteps = [];
  const dateArgs = ["--from", range.from, "--to", range.to];

  const mark = (name) => {
    completedSteps.push(name);
    log(`[pipeline] done: ${name}`);
  };

  const start = (name) => {
    log(`[pipeline] start: ${name}`);
  };

  try {
    // 1) connect
    if (!skipConnect && !fromEnriched) {
      start("connect");
      const result = runCli(rootDir, "connect.js", []);
      assertCliOk("connect", result);
      mark("connect");
    } else {
      log("[pipeline] skip: connect");
    }

    // 2) analyze
    if (!fromEnriched) {
      start("analyze");
      const result = runCli(rootDir, "analyze.js", []);
      assertCliOk("analyze", result);
      mark("analyze");
    } else {
      log("[pipeline] skip: analyze");
    }

    // 3) analyze-ai (needed before enrich_ai; skipped in --no-api)
    if (!fromEnriched && !skipAi) {
      start("analyze-ai");
      const result = runCli(rootDir, "analyze_ai.js", ["--limit", "10"]);
      assertCliOk("analyze-ai", result);
      mark("analyze-ai");
    } else {
      log("[pipeline] skip: analyze-ai");
    }

    // 4) enrich
    if (!fromEnriched && !skipAi) {
      start("enrich");
      const result = runCli(rootDir, "enrich_ai.js", ["--limit", "10"]);
      assertCliOk("enrich", result);
      mark("enrich");
    } else {
      log("[pipeline] skip: enrich");
      const enrichedPath = path.join(rootDir, "output", "timeline_enriched.json");
      if (!fs.existsSync(enrichedPath)) {
        throw new Error(
          "timeline_enriched.json がありません。--no-api を外すか、先に enrich まで実行してください。"
        );
      }
    }

    // 5) editor (stdout discarded; validates enriched readability)
    start("editor");
    {
      const result = runCli(rootDir, "editor.js", [...dateArgs, "--json"]);
      assertCliOk("editor", result);
      writeTempJson(workDir, "editor.json", parseJsonStdout(result.stdout, "editor"));
      mark("editor");
    }

    // 6) concept
    start("concept");
    {
      const result = runCli(rootDir, "concepts.js", [...dateArgs, "--json"]);
      assertCliOk("concept", result);
      writeTempJson(
        workDir,
        "concepts.json",
        parseJsonStdout(result.stdout, "concepts")
      );
      mark("concept");
    }

    // 7) story
    start("story");
    let storiesPayload;
    {
      const result = runCli(rootDir, "stories.js", [...dateArgs, "--json"]);
      assertCliOk("story", result);
      storiesPayload = parseJsonStdout(result.stdout, "stories");
      writeTempJson(workDir, "stories.json", storiesPayload);
      mark("story");
    }

    const selectedStories = selectStoriesForKnowledge(
      storiesPayload,
      knowledgeLimit
    );
    if (selectedStories.length === 0) {
      const err = new Error(
        `期間 ${range.from} 〜 ${range.to} に Story がありません。Knowledge を作成できません。`
      );
      err.step = "knowledge";
      throw err;
    }

    // 8) knowledge-base init
    start("knowledge-base-init");
    {
      const result = runCli(rootDir, "knowledge-base.js", [
        "init",
        "--base-dir",
        baseDir,
      ]);
      assertCliOk("knowledge-base-init", result);
      mark("knowledge-base-init");
    }

    // 9) knowledge create/transition + save (or reuse existing)
    start("knowledge");
    const knowledgeIds = [];
    for (const story of selectedStories) {
      const id = story.id;
      if (!id) continue;

      if (knowledgeExists(rootDir, baseDir, id)) {
        log(`[pipeline] knowledge exists, reuse: ${id}`);
        knowledgeIds.push(id);
        continue;
      }

      const title = story.label || id;
      const summary =
        (typeof story.description === "string" && story.description.trim()) ||
        title;

      const createArgs = [
        "create",
        "--id",
        id,
        "--title",
        title,
        "--summary",
        summary,
        "--story",
        id,
        "--confidence",
        "60",
      ];
      const created = runCli(rootDir, "knowledge.js", createArgs);
      assertCliOk(`knowledge create (${id})`, created);
      const draftPath = path.join(workDir, `knowledge-${id}-v1.json`);
      fs.writeFileSync(draftPath, created.stdout, "utf8");

      // New Knowledge Base entries must be version 1 first.
      const savedV1 = runCli(rootDir, "knowledge-base.js", [
        "save",
        "--input",
        draftPath,
        "--base-dir",
        baseDir,
      ]);
      assertCliOk(`knowledge-base save v1 (${id})`, savedV1);

      const review = runCli(rootDir, "knowledge.js", [
        "transition",
        "--input",
        draftPath,
        "--to",
        "review",
      ]);
      assertCliOk(`knowledge transition review (${id})`, review);
      const reviewPath = path.join(workDir, `knowledge-${id}-v2.json`);
      fs.writeFileSync(reviewPath, review.stdout, "utf8");

      const savedV2 = runCli(rootDir, "knowledge-base.js", [
        "save",
        "--input",
        reviewPath,
        "--base-dir",
        baseDir,
      ]);
      assertCliOk(`knowledge-base save v2 (${id})`, savedV2);

      const published = runCli(rootDir, "knowledge.js", [
        "transition",
        "--input",
        reviewPath,
        "--to",
        "published",
      ]);
      assertCliOk(`knowledge transition published (${id})`, published);
      const publishedPath = path.join(workDir, `knowledge-${id}-v3.json`);
      fs.writeFileSync(publishedPath, published.stdout, "utf8");

      const savedV3 = runCli(rootDir, "knowledge-base.js", [
        "save",
        "--input",
        publishedPath,
        "--base-dir",
        baseDir,
      ]);
      assertCliOk(`knowledge-base save v3 (${id})`, savedV3);
      knowledgeIds.push(id);
    }
    if (knowledgeIds.length === 0) {
      throw new Error("保存可能な Knowledge がありません。");
    }
    mark("knowledge");
    mark("knowledge-base");

    // 10) brief
    start("brief");
    let briefPath;
    const storiesPathForBrief = path.join(workDir, "stories.json");
    {
      const briefArgs = ["build", "--base-dir", baseDir, "--status", "published"];
      for (const id of knowledgeIds) {
        briefArgs.push("--knowledge", id);
      }
      if (planTitle) {
        briefArgs.push("--title", planTitle);
      }
      if (fs.existsSync(storiesPathForBrief)) {
        briefArgs.push("--stories", storiesPathForBrief);
      }
      const result = runCli(rootDir, "brief.js", briefArgs);
      assertCliOk("brief", result);
      const brief = extractBriefFromCliOutput(result.stdout);
      briefPath = writeTempJson(workDir, "brief.json", brief);
      // also keep wrapper output
      fs.writeFileSync(path.join(workDir, "brief-cli.json"), result.stdout, "utf8");
      mark("brief");
    }

    // 10b) editor decide — merge accept|hold|reject into editor.json (keep topics)
    start("editor-decide");
    {
      const editorPath = path.join(workDir, "editor.json");
      const decideArgs = [
        "decide",
        "--stories",
        path.join(workDir, "stories.json"),
        "--brief",
        briefPath,
        "--editor",
        editorPath,
        "--output",
        editorPath,
      ];
      const result = runCli(rootDir, "editor.js", decideArgs);
      assertCliOk("editor-decide", result);
      mark("editor-decide");
    }

    // 10c) editor rank — accept only; keep topics + decisions
    start("editor-rank");
    {
      const editorPath = path.join(workDir, "editor.json");
      const rankArgs = [
        "rank",
        "--stories",
        path.join(workDir, "stories.json"),
        "--brief",
        briefPath,
        "--editor",
        editorPath,
        "--output",
        editorPath,
      ];
      const result = runCli(rootDir, "editor.js", rankArgs);
      assertCliOk("editor-rank", result);
      mark("editor-rank");
    }

    // 10d) editor edition — layout from ranking; keep topics/decisions/ranking
    start("editor-edition");
    {
      const editorPath = path.join(workDir, "editor.json");
      const editionArgs = [
        "edition",
        "--stories",
        path.join(workDir, "stories.json"),
        "--editor",
        editorPath,
        "--output",
        editorPath,
      ];
      const result = runCli(rootDir, "editor.js", editionArgs);
      assertCliOk("editor-edition", result);
      mark("editor-edition");
    }

    // 11) editorial-plan
    start("editorial-plan");
    let planPath;
    const storiesPath = path.join(workDir, "stories.json");
    {
      const planArgs = [
        "build",
        "--brief",
        briefPath,
        "--purpose",
        purpose,
        "--audience",
        audience,
        "--length",
        String(length),
      ];
      let resolvedTitle = planTitle;
      if (!resolvedTitle) {
        try {
          const briefForTitle = JSON.parse(fs.readFileSync(briefPath, "utf8"));
          const briefTitle =
            typeof briefForTitle.title === "string"
              ? briefForTitle.title.trim()
              : "";
          // Prefer Editorial Brief title/headline when concrete.
          const looksGeneric =
            !briefTitle ||
            /^Daily\s+\d{4}-\d{2}-\d{2}$/i.test(briefTitle) ||
            /^(制作・クリエイティブ技術|アニメ・漫画|ゲーム・ゲーム開発|注目の話題|その他)$/.test(
              briefTitle
            );
          if (!looksGeneric) {
            resolvedTitle = briefTitle;
          } else if (fs.existsSync(storiesPath)) {
            const { resolveContentTitle } = require("./writer-core");
            const storiesForTitle = JSON.parse(
              fs.readFileSync(storiesPath, "utf8")
            );
            resolvedTitle = resolveContentTitle(
              storiesForTitle,
              briefForTitle,
              null
            );
          }
        } catch {
          resolvedTitle = null;
        }
      }
      if (resolvedTitle) {
        planArgs.push("--title", resolvedTitle);
      }
      const result = runCli(rootDir, "editorial-plan.js", planArgs);
      assertCliOk("editorial-plan", result);
      planPath = path.join(workDir, "plan.json");
      fs.writeFileSync(planPath, result.stdout, "utf8");
      mark("editorial-plan");
    }

    // 11b) writer-selection — restrict Writer input to edition.selected[]
    start("writer-selection");
    let writerStoriesPath = null;
    let writerSelectionResult = null;
    {
      const {
        selectStoriesForWriter,
        toWriterStoriesInput,
      } = require("./writer-selection");
      const editorPath = path.join(workDir, "editor.json");
      const editorPayload = JSON.parse(fs.readFileSync(editorPath, "utf8"));
      const storiesPayload = fs.existsSync(storiesPath)
        ? JSON.parse(fs.readFileSync(storiesPath, "utf8"))
        : { stories: [] };

      writerSelectionResult = selectStoriesForWriter({
        editor: editorPayload,
        stories: storiesPayload,
        requireEdition: true,
      });

      if (!writerSelectionResult.ok) {
        const err = new Error(
          writerSelectionResult.warnings?.[0]?.message ||
            "writer-selection failed: editor.edition.selected[] is required"
        );
        err.step = "writer-selection";
        throw err;
      }

      const writerStoriesInput = toWriterStoriesInput(
        writerSelectionResult,
        storiesPayload
      );
      writerStoriesPath = writeTempJson(
        workDir,
        "stories-selected.json",
        writerStoriesInput
      );
      writeTempJson(workDir, "writer-selection.json", {
        mode: writerSelectionResult.mode,
        summary: writerSelectionResult.summary,
        warnings: writerSelectionResult.warnings,
        selectedStoryIds: writerSelectionResult.selectedStories.map(
          (s) => s.storyId
        ),
      });
      mark("writer-selection");
    }

    // 12) writer
    start("writer");
    let markdown;
    const articlePath = path.join(workDir, "article.md");
    {
      if (
        writerSelectionResult &&
        writerSelectionResult.summary.resolvedCount === 0
      ) {
        log("[pipeline] writer: skipped (edition selected 0 stories)");
        markdown = "";
        fs.writeFileSync(articlePath, markdown, "utf8");
        mark("writer");
      } else {
        const writerArgs = [
          "build",
          "--brief",
          briefPath,
          "--plan",
          planPath,
        ];
        if (writerStoriesPath && fs.existsSync(writerStoriesPath)) {
          writerArgs.push("--stories", writerStoriesPath);
        }
        const result = runCli(rootDir, "writer.js", writerArgs);
        assertCliOk("writer", result);
        markdown = result.stdout;
        fs.writeFileSync(articlePath, markdown, "utf8");
        mark("writer");
      }
    }

    // 13) article-report (always generate + validate; save only if reportOutput set)
    start("article-report");
    let report = null;
    let reportPath = null;
    {
      if (!markdown) {
        log("[pipeline] article-report: skipped (empty writer output)");
        report = {
          reviewSummary: {
            status: "warning",
            errorCount: 0,
            warningCount: 1,
            passCount: 0,
            readyForAiRewrite: false,
            reasons: ["writer skipped: edition selected 0 stories"],
          },
        };
        fs.writeFileSync(
          path.join(workDir, "article-report.json"),
          `${JSON.stringify(report, null, 2)}\n`,
          "utf8"
        );
        mark("article-report");
      } else {
      const reportArgs = [
        "build",
        "--brief",
        briefPath,
        "--plan",
        planPath,
        "--article",
        articlePath,
        "--confidence-threshold",
        String(
          options.confidenceThreshold != null
            ? options.confidenceThreshold
            : 50
        ),
      ];
      if (options.reportOutput) {
        reportPath = path.resolve(rootDir, options.reportOutput);
        reportArgs.push("--output", reportPath);
      }
      const result = runCli(rootDir, "article-report.js", reportArgs);
      assertCliOk("article-report", result);
      try {
        report = JSON.parse(result.stdout);
      } catch (error) {
        const err = new Error(
          `article-report 出力の JSON 解析に失敗しました: ${error.message}`
        );
        err.step = "article-report";
        throw err;
      }
      if (report.reviewSummary && report.reviewSummary.status === "fail") {
        const err = new Error(
          `Article Report reviewSummary.status=fail（errorCount=${report.reviewSummary.errorCount}）`
        );
        err.step = "article-report";
        err.report = report;
        throw err;
      }
      fs.writeFileSync(
        path.join(workDir, "article-report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8"
      );
      mark("article-report");
      }
    }

    // 14) daily-edition (optional: only when --daily-manifest is set)
    let dailyEdition = null;
    let dailyOutputPath = null;
    let dailyReportPath = null;
    if (options.dailyManifest) {
      start("daily-edition");
      if (!options.dailyOutput) {
        const err = new Error(
          "--daily-manifest 指定時は --daily-output が必要です。"
        );
        err.step = "daily-edition";
        throw err;
      }
      const manifestPath = path.resolve(rootDir, options.dailyManifest);
      dailyOutputPath = path.resolve(rootDir, options.dailyOutput);
      dailyReportPath = options.dailyReportOutput
        ? path.resolve(rootDir, options.dailyReportOutput)
        : path.join(workDir, "daily-edition-report.json");
      const dailyArgs = [
        "build",
        "--manifest",
        manifestPath,
        "--output",
        dailyOutputPath,
        "--report-output",
        dailyReportPath,
      ];
      if (options.dailyExcludeWarnings === true) {
        dailyArgs.push("--exclude-warnings");
      }
      if (options.dailyEditionId) {
        dailyArgs.push("--edition-id", String(options.dailyEditionId));
      }
      const result = runCli(rootDir, "daily-edition.js", dailyArgs);
      assertCliOk("daily-edition", result);
      try {
        dailyEdition = JSON.parse(fs.readFileSync(dailyReportPath, "utf8"));
      } catch (error) {
        const err = new Error(
          `Daily Edition Report の JSON 解析に失敗しました: ${error.message}`
        );
        err.step = "daily-edition";
        throw err;
      }
      if (
        dailyEdition.reviewSummary &&
        dailyEdition.reviewSummary.status === "fail"
      ) {
        const err = new Error(
          `Daily Edition reviewSummary.status=fail（errorCount=${dailyEdition.reviewSummary.errorCount}）`
        );
        err.step = "daily-edition";
        err.dailyEdition = dailyEdition;
        throw err;
      }
      mark("daily-edition");
    }

    return {
      ok: true,
      markdown,
      report,
      reportPath,
      dailyEdition,
      dailyOutputPath,
      dailyReportPath,
      completedSteps,
      failedStep: null,
      knowledgeIds,
      range,
      baseDir,
      workDir,
      briefPath,
      planPath,
      articlePath,
    };
  } catch (error) {
    return {
      ok: false,
      markdown: null,
      completedSteps,
      failedStep: error.step || completedSteps[completedSteps.length - 1] || null,
      error,
      range,
      baseDir,
      workDir,
    };
  }
}

module.exports = {
  DEFAULT_DAYS,
  DEFAULT_PURPOSE,
  DEFAULT_AUDIENCE,
  DEFAULT_LENGTH,
  DEFAULT_BASE_DIR,
  formatLocalDate,
  resolveDateRangeFromDays,
  runCli,
  runPipeline,
  selectStoriesForKnowledge,
};
