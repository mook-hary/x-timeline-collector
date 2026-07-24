/**
 * EA-003 — Aikido Morning Pipeline.
 * Orchestrates Collect → Analyze → Candidate via existing libraries (no CLI spawn).
 */
const fs = require("fs");
const path = require("path");
const { createAikidoWebCollector } = require("./aikido-web-collector");
const { createAikidoSourceIntake } = require("./aikido-source-intake");
const { createAikidoKnowledgeExtractor } = require("./aikido-knowledge-extractor");
const { createAikidoCandidateReview } = require("./aikido-candidate-review");
const {
  createAikidoAiKnowledgeProvider,
  createPassthroughKnowledgeProvider,
} = require("./aikido-ai-knowledge-provider");

const PIPELINE_VERSION = "1";
const PIPELINE_NAME = "aikido-morning";
const LOG_DIR_REL = path.join(".pipeline-work", "logs", "morning");
const LOCK_REL = path.join(".pipeline-work", "aikido-morning.lock");

const STEP_NAMES = Object.freeze(["Collect", "Analyze", "Candidate"]);

const ERROR_CODES = Object.freeze({
  PIPELINE_ALREADY_RUNNING: "PIPELINE_ALREADY_RUNNING",
  COLLECT_FAILED: "COLLECT_FAILED",
  ANALYZE_FAILED: "ANALYZE_FAILED",
  CANDIDATE_FAILED: "CANDIDATE_FAILED",
  INVALID_REQUEST: "INVALID_REQUEST",
  PIPELINE_LOG_FAILED: "PIPELINE_LOG_FAILED",
});

function resolveRoot(rootDir) {
  return path.resolve(rootDir || process.cwd());
}

function resolveNow(nowFn) {
  if (typeof nowFn === "function") {
    const v = nowFn();
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }
  if (nowFn != null) {
    if (nowFn instanceof Date) return nowFn.toISOString();
    return String(nowFn);
  }
  return new Date().toISOString();
}

function formatLogStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return String(iso).replace(/[^0-9]/g, "").slice(0, 14) || "00000000000000";
  }
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

function emptyStep(name, startedAt) {
  return {
    name,
    status: "pending",
    startedAt: startedAt || null,
    finishedAt: null,
    durationMs: null,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    warnings: [],
    errors: [],
  };
}

function finishStep(step, status, finishedAt) {
  step.status = status;
  step.finishedAt = finishedAt;
  if (step.startedAt) {
    const a = Date.parse(step.startedAt);
    const b = Date.parse(finishedAt);
    step.durationMs =
      Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : 0;
  } else {
    step.durationMs = 0;
  }
  return step;
}

function safeErrorMessage(error) {
  return String(error && error.message ? error.message : error)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/OPENAI_API_KEY[=:\s]+\S+/gi, "OPENAI_API_KEY=[REDACTED]")
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, "[REDACTED_API_KEY]")
    .replace(/\/Users\/[^\s:]+/g, "[path]")
    .replace(/\/home\/[^\s:]+/g, "[path]");
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function acquireLock(rootDir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const file = path.join(resolveRoot(rootDir), LOCK_REL);
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(file)) {
    let existingPid = null;
    try {
      const raw = JSON.parse(String(readFileSync(file, "utf8")));
      existingPid = Number(raw && raw.pid);
    } catch (_error) {
      existingPid = null;
    }
    if (isPidAlive(existingPid)) {
      const err = new Error("Morning Pipeline is already running.");
      err.code = ERROR_CODES.PIPELINE_ALREADY_RUNNING;
      throw err;
    }
  }

  writeFileSync(
    file,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
  return file;
}

function releaseLock(rootDir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const unlinkSync = deps.unlinkSync || fs.unlinkSync;
  const file = path.join(resolveRoot(rootDir), LOCK_REL);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch (_error) {
    // ignore
  }
}

function listPipelineLogs(rootDir, deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const existsSync = deps.existsSync || fs.existsSync;
  const dir = path.join(resolveRoot(rootDir), LOG_DIR_REL);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((n) => /^pipeline-\d{8}-\d{6}\.json$/.test(n))
    .sort()
    .reverse();
  const out = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(
        String(readFileSync(path.join(dir, name), "utf8"))
      );
      out.push({ ...raw, _fileName: name });
    } catch (_error) {
      // skip corrupt
    }
  }
  return out;
}

function writePipelineLog(rootDir, record, deps = {}) {
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const renameSync = deps.renameSync || fs.renameSync;
  const dir = path.join(resolveRoot(rootDir), LOG_DIR_REL);
  mkdirSync(dir, { recursive: true });
  const stamp = formatLogStamp(record.startedAt || new Date().toISOString());
  const fileName = `pipeline-${stamp}.json`;
  const filePath = path.join(dir, fileName);
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      if ((deps.existsSync || fs.existsSync)(tmp)) {
        (deps.unlinkSync || fs.unlinkSync)(tmp);
      }
    } catch (_e) {
      // ignore
    }
    const err = new Error("Failed to write pipeline log.");
    err.code = ERROR_CODES.PIPELINE_LOG_FAILED;
    err.cause = error;
    throw err;
  }
  return { fileName, filePath };
}

function summarizeHistoryEntry(record) {
  const steps = Array.isArray(record.steps) ? record.steps : [];
  const collect = steps.find((s) => s.name === "Collect") || {};
  const candidate = steps.find((s) => s.name === "Candidate") || {};
  return {
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || null,
    durationMs:
      record.durationMs != null
        ? record.durationMs
        : record.duration != null
          ? record.duration
          : null,
    success: record.success === true,
    status: record.dryRun
      ? "Dry Run"
      : record.success
        ? "Success"
        : "Failed",
    dryRun: record.dryRun === true,
    collected: Number(collect.created || 0),
    candidates: Number(candidate.created || 0),
    version: record.version || null,
  };
}

/**
 * Default analyzer: AI extract per source → Knowledge Extractor normalization.
 */
function createDefaultAnalyzer(options = {}) {
  let aiProvider = options.aiProvider || null;
  const nowFn = options.now;

  function resolveProvider() {
    if (aiProvider) return aiProvider;
    aiProvider = createAikidoAiKnowledgeProvider({
      aiClient: options.aiClient,
      aiOptions: options.aiOptions,
    });
    return aiProvider;
  }

  async function analyzeSources(sources, callOptions = {}) {
    const list = Array.isArray(sources) ? sources : [];
    const extractions = [];
    const warnings = [];
    const errors = [];
    let processed = 0;
    let created = 0;
    let skipped = 0;

    let provider;
    try {
      provider = resolveProvider();
    } catch (error) {
      return {
        extractions: [],
        processed: 0,
        created: 0,
        skipped: 0,
        warnings: [],
        errors: [safeErrorMessage(error)],
        fatal: true,
        fatalCode: error && error.code ? error.code : "ANALYZE_FAILED",
      };
    }

    for (const source of list) {
      if (!source || !source.id) continue;
      if (
        typeof callOptions.shouldSkipSource === "function" &&
        callOptions.shouldSkipSource(source)
      ) {
        skipped += 1;
        warnings.push(`skipped source with existing candidates: ${source.id}`);
        continue;
      }
      processed += 1;
      try {
        let payload;
        if (typeof provider.extractKnowledgeAsync === "function") {
          const { text, textField } = resolveText(source);
          payload = await provider.extractKnowledgeAsync({
            text,
            textField,
            source: {
              id: source.id,
              sourceType: source.sourceType || "",
              title: source.title || "",
              author: source.author || "",
              publisher: source.publisher || "",
              url: source.url || "",
              publishedAt: source.publishedAt || "",
              language: source.language || "",
            },
          });
        } else {
          payload = provider.extractKnowledge({
            text: String(source.rawText || source.summary || source.notes || ""),
            source,
          });
        }
        const extractor = createAikidoKnowledgeExtractor({
          provider: createPassthroughKnowledgeProvider(
            payload,
            provider.name || "ai"
          ),
        });
        const extraction = extractor.extractFromSource(source, {
          now: callOptions.now != null ? callOptions.now : nowFn,
        });
        extractions.push(extraction);
        created += extraction.candidates.length;
        for (const w of extraction.warnings || []) {
          warnings.push(
            typeof w === "string" ? w : w.message || JSON.stringify(w)
          );
        }
        for (const e of extraction.errors || []) {
          errors.push(
            typeof e === "string" ? e : e.message || JSON.stringify(e)
          );
        }
      } catch (error) {
        errors.push(safeErrorMessage(error));
        extractions.push({
          sourceId: String(source.id),
          candidates: [],
          errors: [{ message: safeErrorMessage(error) }],
          warnings: [],
          metadata: { failed: true },
        });
      }
    }

    return {
      extractions,
      processed,
      created,
      skipped,
      warnings,
      errors,
    };
  }

  return { analyzeSources };
}

function resolveText(source) {
  if (source.rawText != null && String(source.rawText).trim()) {
    return { text: String(source.rawText), textField: "rawText" };
  }
  if (source.summary != null && String(source.summary).trim()) {
    return { text: String(source.summary), textField: "summary" };
  }
  if (source.notes != null && String(source.notes).trim()) {
    return { text: String(source.notes), textField: "notes" };
  }
  const err = new Error("extraction text is empty");
  err.code = "aikido-extractor-text";
  throw err;
}

/**
 * Default candidate creator with source-level duplicate skip.
 */
function createDefaultCandidateCreator(options = {}) {
  const review =
    options.candidateReview ||
    createAikidoCandidateReview({
      rootDir: options.rootDir,
      now: options.now,
      knowledgeStore: options.knowledgeStore,
    });

  function hasCandidatesForSource(sourceId) {
    const id = String(sourceId || "").trim();
    if (!id) return false;
    const items = review.listReviews({ sourceId: id });
    return Array.isArray(items) && items.length > 0;
  }

  function createCandidates(extractions, callOptions = {}) {
    const list = Array.isArray(extractions) ? extractions : [];
    let processed = 0;
    let created = 0;
    let skipped = 0;
    let updated = 0;
    const warnings = [];
    const errors = [];
    const reviews = [];

    for (const extraction of list) {
      if (!extraction || typeof extraction !== "object") continue;
      const sourceId = extraction.sourceId != null ? String(extraction.sourceId) : "";
      processed += 1;

      if (sourceId && hasCandidatesForSource(sourceId)) {
        skipped += 1;
        warnings.push(`skipped existing candidates for source: ${sourceId}`);
        continue;
      }

      if (extraction.metadata && extraction.metadata.failed) {
        errors.push(
          (extraction.errors &&
            extraction.errors[0] &&
            extraction.errors[0].message) ||
            `analyze failed for ${sourceId || "source"}`
        );
        continue;
      }

      if (callOptions.dryRun) {
        const n = Array.isArray(extraction.candidates)
          ? extraction.candidates.length
          : 0;
        created += n;
        continue;
      }

      const out = review.createReviews(extraction, callOptions);
      reviews.push(...out.reviews);
      created += out.summary.createdCount;
      skipped += out.summary.skippedCount;
      for (const e of out.errors || []) {
        if (e.skipped) {
          warnings.push(e.message || "duplicate candidate skipped");
        } else {
          errors.push(e.message || "candidate create failed");
        }
      }
    }

    return {
      reviews,
      processed,
      created,
      updated,
      skipped,
      warnings,
      errors,
    };
  }

  return {
    createCandidates,
    hasCandidatesForSource,
    candidateReview: review,
  };
}

/**
 * @param {object} [options]
 */
function createMorningPipeline(options = {}) {
  const rootDir = resolveRoot(options.rootDir);
  const nowFn = options.now;
  const logger =
    options.logger ||
    {
      info: (msg) => process.stdout.write(`${msg}\n`),
      error: (msg) => process.stderr.write(`${msg}\n`),
    };

  const sourceIntake =
    options.sourceIntake ||
    createAikidoSourceIntake({ rootDir, now: nowFn });

  const collector =
    options.collector ||
    createAikidoWebCollector({
      sourceIntake,
      fetcher: options.fetcher,
      now: nowFn,
    });

  const candidateCreator =
    options.candidateCreator ||
    createDefaultCandidateCreator({
      rootDir,
      now: nowFn,
      candidateReview: options.candidateReview,
      knowledgeStore: options.knowledgeStore,
    });

  const analyzer =
    options.analyzer ||
    createDefaultAnalyzer({
      now: nowFn,
      aiClient: options.aiClient,
      aiProvider: options.aiProvider,
      aiOptions: options.aiOptions,
    });

  const defaultUrls = Array.isArray(options.urls) ? options.urls.slice() : [];
  const fsDeps = options.fsDeps || {};

  let running = false;
  let currentStep = null;
  let lastResult = null;

  function getStatus() {
    if (running) {
      return {
        status: "Running",
        running: true,
        currentStep,
        lastRun: lastResult ? summarizeHistoryEntry(lastResult) : null,
      };
    }
    if (lastResult && lastResult.dryRun) {
      return {
        status: "Dry Run",
        running: false,
        currentStep: null,
        lastRun: summarizeHistoryEntry(lastResult),
      };
    }
    if (lastResult) {
      return {
        status: lastResult.success ? "Success" : "Failed",
        running: false,
        currentStep: null,
        lastRun: summarizeHistoryEntry(lastResult),
      };
    }
    const history = listPipelineLogs(rootDir, fsDeps).slice(0, 1);
    if (history[0]) {
      return {
        status: history[0].success ? "Success" : "Failed",
        running: false,
        currentStep: null,
        lastRun: summarizeHistoryEntry(history[0]),
      };
    }
    return {
      status: "Idle",
      running: false,
      currentStep: null,
      lastRun: null,
    };
  }

  function getHistory(limit = 20) {
    const n = Number(limit);
    const max = Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 20;
    return listPipelineLogs(rootDir, fsDeps)
      .slice(0, max)
      .map(summarizeHistoryEntry);
  }

  /**
   * @param {{ dryRun?: boolean, urls?: string[] }} [runOptions]
   */
  async function run(runOptions = {}) {
    if (running) {
      const err = new Error("Morning Pipeline is already running.");
      err.code = ERROR_CODES.PIPELINE_ALREADY_RUNNING;
      throw err;
    }

    const dryRun = runOptions.dryRun === true;
    let urls;
    if (Object.prototype.hasOwnProperty.call(runOptions, "urls")) {
      if (!Array.isArray(runOptions.urls)) {
        const err = new Error("urls must be an array of strings");
        err.code = ERROR_CODES.INVALID_REQUEST;
        throw err;
      }
      urls = runOptions.urls.slice();
    } else {
      urls = defaultUrls.slice();
    }

    running = true;
    currentStep = null;
    const startedAt = resolveNow(nowFn);
    const steps = [];
    let success = false;
    let lockAcquired = false;

    try {
      if (!dryRun) {
        acquireLock(rootDir, fsDeps);
        lockAcquired = true;
      }

      // --- Collect ---
      currentStep = "Collect";
      if (typeof logger.info === "function") logger.info("Collect...");
      const collectStep = emptyStep("Collect", resolveNow(nowFn));
      steps.push(collectStep);
      /** @type {object[]} */
      let collectedSources = [];

      if (dryRun) {
        collectStep.processed = urls.length;
        collectStep.skipped = urls.length;
        collectStep.warnings.push("dry-run: collect skipped");
        finishStep(collectStep, "success", resolveNow(nowFn));
      } else {
        try {
          if (typeof collector.collectUrls !== "function") {
            throw Object.assign(new Error("collector.collectUrls is required"), {
              code: ERROR_CODES.COLLECT_FAILED,
            });
          }
          const batch = await collector.collectUrls(urls, {
            continueOnError: true,
            now: nowFn,
          });
          const results = (batch && batch.results) || [];
          collectStep.processed = results.length;
          collectStep.created = Number(
            (batch.summary && batch.summary.createdCount) || 0
          );
          collectStep.skipped = Number(
            (batch.summary && batch.summary.skippedCount) || 0
          );
          for (const row of results) {
            if (row.ok && row.source) {
              collectedSources.push(row.source);
            } else if (row.skipped) {
              // already counted
            } else if (row.error) {
              collectStep.errors.push(
                safeErrorMessage(row.error.message || row.error)
              );
            }
            if (Array.isArray(row.warnings)) {
              for (const w of row.warnings) {
                collectStep.warnings.push(String(w));
              }
            }
          }

          const errorCount = Number(
            (batch.summary && batch.summary.errorCount) || 0
          );
          const hardFail =
            urls.length > 0 &&
            collectStep.created === 0 &&
            collectStep.skipped === 0 &&
            errorCount > 0;
          if (hardFail) {
            finishStep(collectStep, "failed", resolveNow(nowFn));
            const err = new Error("Collect failed.");
            err.code = ERROR_CODES.COLLECT_FAILED;
            throw err;
          }
          finishStep(collectStep, "success", resolveNow(nowFn));
        } catch (error) {
          if (collectStep.status === "pending") {
            collectStep.errors.push(safeErrorMessage(error));
            finishStep(collectStep, "failed", resolveNow(nowFn));
          }
          if (error && error.code === ERROR_CODES.COLLECT_FAILED) throw error;
          const err = new Error("Collect failed.");
          err.code = ERROR_CODES.COLLECT_FAILED;
          err.cause = error;
          throw err;
        }
      }

      // --- Analyze ---
      currentStep = "Analyze";
      if (typeof logger.info === "function") logger.info("Analyze...");
      const analyzeStep = emptyStep("Analyze", resolveNow(nowFn));
      steps.push(analyzeStep);
      /** @type {object[]} */
      let extractions = [];

      if (dryRun) {
        analyzeStep.warnings.push("dry-run: analyze skipped");
        finishStep(analyzeStep, "success", resolveNow(nowFn));
      } else {
        try {
          const pending = [];
          const seen = new Set();
          for (const s of collectedSources) {
            if (s && s.id && !seen.has(s.id)) {
              seen.add(s.id);
              pending.push(s);
            }
          }
          // Also consider existing collected sources without candidates.
          if (typeof sourceIntake.listSources === "function") {
            const existing = sourceIntake.listSources({ status: "collected" });
            for (const s of existing) {
              if (!s || !s.id || seen.has(s.id)) continue;
              if (
                candidateCreator.hasCandidatesForSource &&
                candidateCreator.hasCandidatesForSource(s.id)
              ) {
                continue;
              }
              seen.add(s.id);
              pending.push(s);
            }
          }

          if (typeof analyzer.analyzeSources !== "function") {
            throw Object.assign(
              new Error("analyzer.analyzeSources is required"),
              { code: ERROR_CODES.ANALYZE_FAILED }
            );
          }

          const analyzed = await analyzer.analyzeSources(pending, {
            now: nowFn,
            shouldSkipSource: (source) =>
              !!(
                candidateCreator.hasCandidatesForSource &&
                candidateCreator.hasCandidatesForSource(source.id)
              ),
          });
          if (analyzed && analyzed.fatal) {
            analyzeStep.errors.push(...(analyzed.errors || []).map(String));
            finishStep(analyzeStep, "failed", resolveNow(nowFn));
            const err = new Error("Analyze failed.");
            err.code = ERROR_CODES.ANALYZE_FAILED;
            throw err;
          }
          extractions = analyzed.extractions || [];
          analyzeStep.processed = Number(analyzed.processed || 0);
          analyzeStep.created = Number(analyzed.created || 0);
          analyzeStep.skipped = Number(analyzed.skipped || 0);
          analyzeStep.warnings.push(...(analyzed.warnings || []).map(String));
          analyzeStep.errors.push(...(analyzed.errors || []).map(String));

          const failedAll =
            pending.length > 0 &&
            analyzeStep.created === 0 &&
            analyzeStep.skipped === 0 &&
            (extractions.length === 0 ||
              extractions.every((e) => e.metadata && e.metadata.failed));
          if (failedAll) {
            finishStep(analyzeStep, "failed", resolveNow(nowFn));
            const err = new Error("Analyze failed.");
            err.code = ERROR_CODES.ANALYZE_FAILED;
            throw err;
          }
          finishStep(analyzeStep, "success", resolveNow(nowFn));
        } catch (error) {
          if (analyzeStep.status === "pending") {
            analyzeStep.errors.push(safeErrorMessage(error));
            finishStep(analyzeStep, "failed", resolveNow(nowFn));
          }
          if (error && error.code === ERROR_CODES.ANALYZE_FAILED) throw error;
          const err = new Error("Analyze failed.");
          err.code = ERROR_CODES.ANALYZE_FAILED;
          err.cause = error;
          throw err;
        }
      }

      // --- Candidate ---
      currentStep = "Candidate";
      if (typeof logger.info === "function") logger.info("Candidate...");
      const candidateStep = emptyStep("Candidate", resolveNow(nowFn));
      steps.push(candidateStep);

      if (dryRun) {
        candidateStep.warnings.push("dry-run: candidate save skipped");
        finishStep(candidateStep, "success", resolveNow(nowFn));
      } else {
        try {
          if (typeof candidateCreator.createCandidates !== "function") {
            throw Object.assign(
              new Error("candidateCreator.createCandidates is required"),
              { code: ERROR_CODES.CANDIDATE_FAILED }
            );
          }
          const created = candidateCreator.createCandidates(extractions, {
            now: nowFn,
            dryRun: false,
          });
          candidateStep.processed = Number(created.processed || 0);
          candidateStep.created = Number(created.created || 0);
          candidateStep.updated = Number(created.updated || 0);
          candidateStep.skipped = Number(created.skipped || 0);
          candidateStep.warnings.push(...(created.warnings || []).map(String));
          candidateStep.errors.push(...(created.errors || []).map(String));

          if (
            candidateStep.errors.length > 0 &&
            candidateStep.created === 0 &&
            candidateStep.skipped === 0 &&
            candidateStep.processed > 0
          ) {
            finishStep(candidateStep, "failed", resolveNow(nowFn));
            const err = new Error("Candidate failed.");
            err.code = ERROR_CODES.CANDIDATE_FAILED;
            throw err;
          }
          finishStep(candidateStep, "success", resolveNow(nowFn));
        } catch (error) {
          if (candidateStep.status === "pending") {
            candidateStep.errors.push(safeErrorMessage(error));
            finishStep(candidateStep, "failed", resolveNow(nowFn));
          }
          if (error && error.code === ERROR_CODES.CANDIDATE_FAILED) throw error;
          const err = new Error("Candidate failed.");
          err.code = ERROR_CODES.CANDIDATE_FAILED;
          err.cause = error;
          throw err;
        }
      }

      success = true;
    } catch (error) {
      success = false;
      // Ensure remaining steps are marked skipped if early fail
      for (const name of STEP_NAMES) {
        if (!steps.find((s) => s.name === name)) {
          const skipped = emptyStep(name, resolveNow(nowFn));
          skipped.warnings.push(
            `not run because previous step failed: ${
              error && error.code ? error.code : "error"
            }`
          );
          finishStep(skipped, "skipped", resolveNow(nowFn));
          steps.push(skipped);
        }
      }
      lastResult = buildResult({
        ok: false,
        success: false,
        dryRun,
        startedAt,
        finishedAt: resolveNow(nowFn),
        steps,
        error: {
          code: error && error.code ? error.code : "PIPELINE_FAILED",
          message: safeErrorMessage(error),
        },
      });
      if (typeof logger.error === "function") {
        logger.error(`Morning Pipeline failed: ${safeErrorMessage(error)}`);
      }
      if (!dryRun) {
        try {
          writePipelineLog(rootDir, lastResult, fsDeps);
        } catch (_logErr) {
          // keep pipeline error primary
        }
      }
      return lastResult;
    } finally {
      currentStep = null;
      running = false;
      if (lockAcquired) releaseLock(rootDir, fsDeps);
    }

    const finishedAt = resolveNow(nowFn);
    lastResult = buildResult({
      ok: true,
      success: true,
      dryRun,
      startedAt,
      finishedAt,
      steps,
      error: null,
    });

    if (!dryRun) {
      try {
        writePipelineLog(rootDir, lastResult, fsDeps);
      } catch (error) {
        lastResult.ok = false;
        lastResult.success = false;
        lastResult.error = {
          code: ERROR_CODES.PIPELINE_LOG_FAILED,
          message: safeErrorMessage(error),
        };
      }
    }

    if (typeof logger.info === "function") {
      logger.info(success ? "Completed" : "Failed");
      for (const step of steps) {
        const mark = step.status === "success" ? "✓" : step.status === "failed" ? "✗" : "–";
        logger.info(`${step.name} ${mark}`);
      }
    }

    return lastResult;
  }

  function buildResult({ ok, success, dryRun, startedAt, finishedAt, steps, error }) {
    const a = Date.parse(startedAt);
    const b = Date.parse(finishedAt);
    const durationMs =
      Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : 0;
    return {
      ok,
      success,
      dryRun: !!dryRun,
      version: PIPELINE_VERSION,
      name: PIPELINE_NAME,
      startedAt,
      finishedAt,
      durationMs,
      duration: durationMs,
      steps,
      error,
    };
  }

  return {
    PIPELINE_VERSION,
    run,
    getStatus,
    getHistory,
    isRunning: () => running,
    getLastResult: () => lastResult,
    rootDir,
    collector,
    analyzer,
    candidateCreator,
    sourceIntake,
  };
}

module.exports = {
  PIPELINE_VERSION,
  PIPELINE_NAME,
  LOG_DIR_REL,
  LOCK_REL,
  STEP_NAMES,
  ERROR_CODES,
  createMorningPipeline,
  createDefaultAnalyzer,
  createDefaultCandidateCreator,
  listPipelineLogs,
  writePipelineLog,
  summarizeHistoryEntry,
  acquireLock,
  releaseLock,
  formatLogStamp,
  resolveRoot,
};
