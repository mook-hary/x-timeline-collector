/**
 * EP-033 — Morning API usage history (persist + pure aggregation).
 * Reader display is out of scope. Pricing via lib/api-usage.js estimates.
 */
const fs = require("fs");
const path = require("path");
const {
  emptyUsage,
  addUsage,
  resolveUsageModel,
  resolveModelPricing,
  estimateApiCost,
} = require("./api-usage");

const HISTORY_VERSION = 1;
const HISTORY_REL = path.join("data", "api-usage-history.json");

function toNonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function toNonNegNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function createEmptyHistory() {
  return {
    version: HISTORY_VERSION,
    entries: [],
  };
}

function emptyUsageBucket() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function emptyCost() {
  return { input: 0, output: 0, total: 0 };
}

function cloneEntry(e) {
  return {
    ...e,
    analyze: { ...e.analyze },
    enrich: { ...e.enrich },
    total: { ...e.total },
    estimatedCostUsd: { ...e.estimatedCostUsd },
    runOptions: { ...e.runOptions },
  };
}

/**
 * Normalize a usage bucket (camelCase history shape or snake_case EP-030 usage).
 */
function normalizeUsageBucket(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const inputTokens = toNonNegInt(
    src.inputTokens != null ? src.inputTokens : src.input_tokens
  );
  const outputTokens = toNonNegInt(
    src.outputTokens != null ? src.outputTokens : src.output_tokens
  );
  let totalTokens = toNonNegInt(
    src.totalTokens != null ? src.totalTokens : src.total_tokens
  );
  if (totalTokens === 0 && (inputTokens > 0 || outputTokens > 0)) {
    totalTokens = inputTokens + outputTokens;
  }
  return {
    requests: toNonNegInt(src.requests),
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function normalizeEstimatedCost(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const input = toNonNegNumber(src.input != null ? src.input : src.inputCostUsd);
  const output = toNonNegNumber(
    src.output != null ? src.output : src.outputCostUsd
  );
  let total = toNonNegNumber(src.total != null ? src.total : src.totalCostUsd);
  if (total === 0 && (input > 0 || output > 0)) {
    total = input + output;
  }
  return { input, output, total };
}

function normalizeRunOptions(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    skipCollect: src.skipCollect === true,
    skipAi: src.skipAi === true,
    fromEnriched: src.fromEnriched === true,
  };
}

/**
 * @param {object} raw
 * @returns {object} normalized entry
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const err = new Error("usage history entry must be an object");
    err.code = "usage-history-invalid";
    throw err;
  }
  const finishedAt = String(raw.finishedAt || raw.id || "").trim();
  if (!finishedAt) {
    const err = new Error("usage history entry missing finishedAt/id");
    err.code = "usage-history-invalid";
    throw err;
  }
  const startedAt = String(raw.startedAt || finishedAt).trim();
  const id = String(raw.id || finishedAt).trim();
  const analyze = normalizeUsageBucket(raw.analyze);
  const enrich = normalizeUsageBucket(raw.enrich);
  let total = normalizeUsageBucket(raw.total);
  if (
    total.requests === 0 &&
    total.inputTokens === 0 &&
    total.outputTokens === 0 &&
    (analyze.requests > 0 || enrich.requests > 0)
  ) {
    total = normalizeUsageBucket(
      addUsage(
        {
          requests: analyze.requests,
          input_tokens: analyze.inputTokens,
          output_tokens: analyze.outputTokens,
          total_tokens: analyze.totalTokens,
        },
        {
          requests: enrich.requests,
          input_tokens: enrich.inputTokens,
          output_tokens: enrich.outputTokens,
          total_tokens: enrich.totalTokens,
        }
      )
    );
  }

  return {
    id,
    startedAt,
    finishedAt,
    model: String(raw.model || "").trim() || resolveUsageModel(),
    analyze,
    enrich,
    total,
    estimatedCostUsd: normalizeEstimatedCost(raw.estimatedCostUsd),
    status: "success",
    runOptions: normalizeRunOptions(raw.runOptions),
  };
}

/**
 * @param {object} raw
 */
function normalizeHistory(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const err = new Error("usage history root must be an object");
    err.code = "usage-history-invalid";
    throw err;
  }
  if (!Array.isArray(raw.entries)) {
    const err = new Error("usage history.entries must be an array");
    err.code = "usage-history-invalid";
    throw err;
  }
  const version = toNonNegInt(raw.version) || HISTORY_VERSION;
  const entries = raw.entries.map((entry) => normalizeEntry(entry));
  return { version, entries };
}

/**
 * Append entry if id is new. Does not mutate input. Does not modify duplicates.
 * @param {{ version: number, entries: object[] }} history
 * @param {object} entry
 * @returns {{ history: object, added: boolean }}
 */
function appendEntry(history, entry) {
  const base = normalizeHistory(history || createEmptyHistory());
  const nextEntry = normalizeEntry(entry);
  if (base.entries.some((e) => e.id === nextEntry.id)) {
    return {
      history: {
        version: base.version,
        entries: base.entries.map(cloneEntry),
      },
      added: false,
    };
  }
  return {
    history: {
      version: base.version,
      entries: [...base.entries.map(cloneEntry), nextEntry],
    },
    added: true,
  };
}

/**
 * Entries with finishedAt >= sinceIso (inclusive). Does not mutate input.
 */
function filterEntriesSince(entries, sinceIso) {
  const list = Array.isArray(entries) ? entries : [];
  const since = String(sinceIso || "");
  return list
    .filter((e) => e && String(e.finishedAt || "") >= since)
    .map((e) => normalizeEntry(e));
}

/**
 * Entries with fromIso <= finishedAt <= toIso (inclusive). Does not mutate input.
 */
function filterEntriesInRange(entries, fromIso, toIso) {
  const list = Array.isArray(entries) ? entries : [];
  const from = String(fromIso || "");
  const to = String(toIso || "");
  return list
    .filter((e) => {
      const t = String((e && e.finishedAt) || "");
      return t >= from && t <= to;
    })
    .map((e) => normalizeEntry(e));
}

/**
 * Aggregate usage/cost across entries. Pure; does not mutate input.
 */
function summarizeUsageEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costInput = 0;
  let costOutput = 0;
  let costTotal = 0;

  for (const raw of list) {
    const e = normalizeEntry(raw);
    requests += e.total.requests;
    inputTokens += e.total.inputTokens;
    outputTokens += e.total.outputTokens;
    totalTokens += e.total.totalTokens;
    costInput += e.estimatedCostUsd.input;
    costOutput += e.estimatedCostUsd.output;
    costTotal += e.estimatedCostUsd.total;
  }

  return {
    runs: list.length,
    requests,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: {
      input: costInput,
      output: costOutput,
      total: costTotal,
    },
  };
}

/**
 * Build a success history entry from Morning usage buckets.
 */
function buildMorningHistoryEntry({
  startedAt,
  finishedAt,
  model,
  analyze,
  enrich,
  runOptions,
} = {}) {
  const finished = String(finishedAt || new Date().toISOString());
  const started = String(startedAt || finished);
  const analyzeBucket = normalizeUsageBucket(analyze || emptyUsage());
  const enrichBucket = normalizeUsageBucket(enrich || emptyUsage());
  const totalBucket = normalizeUsageBucket(
    addUsage(
      {
        requests: analyzeBucket.requests,
        input_tokens: analyzeBucket.inputTokens,
        output_tokens: analyzeBucket.outputTokens,
        total_tokens: analyzeBucket.totalTokens,
      },
      {
        requests: enrichBucket.requests,
        input_tokens: enrichBucket.inputTokens,
        output_tokens: enrichBucket.outputTokens,
        total_tokens: enrichBucket.totalTokens,
      }
    )
  );

  const resolvedModel = resolveUsageModel(model);
  const pricing = resolveModelPricing(resolvedModel);
  let estimatedCostUsd = emptyCost();
  if (pricing) {
    const cost = estimateApiCost({
      inputTokens: totalBucket.inputTokens,
      outputTokens: totalBucket.outputTokens,
      inputPricePerMillion: pricing.inputPerMillion,
      outputPricePerMillion: pricing.outputPerMillion,
    });
    estimatedCostUsd = {
      input: cost.inputCostUsd,
      output: cost.outputCostUsd,
      total: cost.totalCostUsd,
    };
  }

  return normalizeEntry({
    id: finished,
    startedAt: started,
    finishedAt: finished,
    model: resolvedModel,
    analyze: analyzeBucket,
    enrich: enrichBucket,
    total: totalBucket,
    estimatedCostUsd,
    status: "success",
    runOptions: normalizeRunOptions(runOptions),
  });
}

function resolveHistoryPath(rootDir, explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  return path.join(path.resolve(rootDir || process.cwd()), HISTORY_REL);
}

/**
 * Load history. Missing file → empty. Corrupt / invalid → throw (no overwrite).
 */
function loadHistory(filePath) {
  if (!fs.existsSync(filePath)) {
    return createEmptyHistory();
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const err = new Error(`failed to read usage history: ${error.message}`);
    err.code = "usage-history-io";
    throw err;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    const err = new Error(
      `usage history JSON is corrupt; refusing to overwrite (${error.message})`
    );
    err.code = "usage-history-corrupt";
    throw err;
  }

  try {
    return normalizeHistory(data);
  } catch (error) {
    const err = new Error(
      `usage history JSON is invalid; refusing to overwrite (${error.message})`
    );
    err.code = "usage-history-corrupt";
    throw err;
  }
}

/**
 * Atomic pretty JSON write. Throws on failure (does not process.exit).
 */
function saveHistory(filePath, history) {
  const normalized = normalizeHistory(history);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(
      tmpPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      "utf8"
    );
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_cleanup) {
      // best-effort
    }
    const err = new Error(`failed to write usage history: ${error.message}`);
    err.code = "usage-history-io";
    throw err;
  }
  return normalized;
}

/**
 * Load → append → save. Duplicate id → no change, added=false.
 * @returns {{ ok: true, added: boolean, path: string, entry: object, history: object }}
 */
function recordMorningUsage(filePath, entry) {
  const current = loadHistory(filePath);
  const { history, added } = appendEntry(current, entry);
  if (added) {
    saveHistory(filePath, history);
  }
  return {
    ok: true,
    added,
    path: filePath,
    entry: normalizeEntry(entry),
    history,
  };
}

module.exports = {
  HISTORY_VERSION,
  HISTORY_REL,
  createEmptyHistory,
  emptyUsageBucket,
  normalizeUsageBucket,
  normalizeEntry,
  normalizeHistory,
  appendEntry,
  filterEntriesSince,
  filterEntriesInRange,
  summarizeUsageEntries,
  buildMorningHistoryEntry,
  resolveHistoryPath,
  loadHistory,
  saveHistory,
  recordMorningUsage,
};
