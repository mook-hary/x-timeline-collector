/**
 * KP-004 — Aikido Knowledge Extractor.
 * Extracts Knowledge candidates from Source Intake records.
 * Does not save to Knowledge Store; does not mutate Source status.
 * AI Provider is injected (no vendor lock-in in this module).
 */
const crypto = require("crypto");
const { CATEGORIES } = require("./aikido-knowledge");

const EXTRACTOR_VERSION = "1";
const CATEGORY_SET = new Set(CATEGORIES);

/**
 * @param {object} [options]
 * @param {object} [options.provider] { name?, extractKnowledge(input, options) }
 */
function createAikidoKnowledgeExtractor(options = {}) {
  const provider = options.provider;
  if (!provider || typeof provider.extractKnowledge !== "function") {
    const err = new Error(
      "provider with extractKnowledge(input, options) is required"
    );
    err.code = "aikido-extractor-provider";
    throw err;
  }
  const providerName =
    provider.name != null && String(provider.name).trim()
      ? String(provider.name).trim()
      : "custom";

  function extractFromSource(source, callOptions = {}) {
    if (!source || typeof source !== "object") {
      const err = new Error("source must be an object");
      err.code = "aikido-extractor-source";
      throw err;
    }
    const sourceId =
      source.id != null && String(source.id).trim()
        ? String(source.id).trim()
        : null;
    if (!sourceId) {
      const err = new Error("source.id is required");
      err.code = "aikido-extractor-source";
      throw err;
    }

    const { text, textField } = resolveExtractionText(source);
    const extractedAt = resolveNow(callOptions);
    const baseMeta = {
      provider: providerName,
      extractorVersion: EXTRACTOR_VERSION,
      extractedAt,
    };

    let providerResult;
    try {
      providerResult = provider.extractKnowledge(
        {
          text,
          textField,
          source: {
            id: sourceId,
            sourceType: source.sourceType || "",
            title: source.title || "",
            author: source.author || "",
            publisher: source.publisher || "",
            url: source.url || "",
            publishedAt: source.publishedAt || "",
            language: source.language || "",
          },
        },
        { ...callOptions, now: extractedAt }
      );
    } catch (error) {
      const err = new Error(
        `provider extractKnowledge failed: ${
          error && error.message ? error.message : String(error)
        }`
      );
      err.code = "aikido-extractor-provider-error";
      err.cause = error;
      throw err;
    }

    const rawCandidates = normalizeProviderCandidates(providerResult);
    const candidates = [];
    const errors = [];
    const warnings = [];

    rawCandidates.forEach((raw, index) => {
      const built = buildCandidate(raw, {
        sourceId,
        sourceText: text,
        providerName,
        extractedAt,
        index,
      });
      if (!built.ok) {
        errors.push({
          index,
          message: built.errors.join("; "),
          errors: built.errors,
        });
        return;
      }
      for (const w of built.warnings) {
        warnings.push({ index, message: w, candidateId: built.candidate.candidateId });
      }

      if (
        callOptions.minConfidence != null &&
        callOptions.minConfidence !== ""
      ) {
        const min = Number(callOptions.minConfidence);
        if (!Number.isFinite(min) || min < 0 || min > 1) {
          const err = new Error("minConfidence must be a number between 0 and 1");
          err.code = "aikido-extractor-options";
          throw err;
        }
        if (
          built.candidate.confidence == null ||
          built.candidate.confidence < min
        ) {
          return;
        }
      }

      candidates.push(built.candidate);
    });

    return {
      sourceId,
      candidates,
      errors,
      warnings,
      metadata: baseMeta,
    };
  }

  function extractFromSources(sources, callOptions = {}) {
    let list = Array.isArray(sources) ? sources.slice() : [];

    if (callOptions.sourceType != null && String(callOptions.sourceType).trim()) {
      const sourceType = String(callOptions.sourceType).trim();
      list = list.filter((s) => s && s.sourceType === sourceType);
    }
    if (callOptions.status != null && String(callOptions.status).trim()) {
      const status = String(callOptions.status).trim();
      list = list.filter((s) => s && s.status === status);
    }
    if (callOptions.language != null && String(callOptions.language).trim()) {
      const language = String(callOptions.language).trim();
      list = list.filter((s) => s && s.language === language);
    }

    // Preserve input order.
    const results = [];
    let candidateCount = 0;
    let errorCount = 0;

    for (const source of list) {
      try {
        const result = extractFromSource(source, callOptions);
        results.push(result);
        candidateCount += result.candidates.length;
        errorCount += result.errors.length;
      } catch (error) {
        errorCount += 1;
        results.push({
          sourceId:
            source && source.id != null ? String(source.id) : null,
          candidates: [],
          errors: [
            {
              message: error && error.message ? error.message : String(error),
              code: error && error.code ? error.code : "aikido-extractor-error",
            },
          ],
          warnings: [],
          metadata: {
            provider: providerName,
            extractorVersion: EXTRACTOR_VERSION,
            extractedAt: resolveNow(callOptions),
            failed: true,
          },
        });
      }
    }

    if (callOptions.limit != null) {
      const limit = Number(callOptions.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        const err = new Error("limit must be a non-negative integer");
        err.code = "aikido-extractor-options";
        throw err;
      }
      // limit applies to number of source results returned
      return {
        results: results.slice(0, limit),
        summary: {
          sourceCount: Math.min(results.length, limit),
          candidateCount: results
            .slice(0, limit)
            .reduce((n, r) => n + r.candidates.length, 0),
          errorCount: results
            .slice(0, limit)
            .reduce((n, r) => n + (r.errors ? r.errors.length : 0), 0),
        },
      };
    }

    return {
      results,
      summary: {
        sourceCount: results.length,
        candidateCount,
        errorCount,
      },
    };
  }

  return {
    providerName,
    extractFromSource,
    extractFromSources,
    validateCandidate,
  };
}

function resolveNow(options = {}) {
  if (options.now != null) {
    const v = typeof options.now === "function" ? options.now() : options.now;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "number") return new Date(v).toISOString();
    return String(v);
  }
  return new Date().toISOString();
}

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

/**
 * Priority: rawText → summary → notes
 */
function resolveExtractionText(source) {
  if (!isBlank(source.rawText)) {
    return { text: String(source.rawText), textField: "rawText" };
  }
  if (!isBlank(source.summary)) {
    return { text: String(source.summary), textField: "summary" };
  }
  if (!isBlank(source.notes)) {
    return { text: String(source.notes), textField: "notes" };
  }
  const err = new Error(
    "extraction text is empty (need rawText, summary, or notes)"
  );
  err.code = "aikido-extractor-text";
  throw err;
}

function normalizeProviderCandidates(providerResult) {
  if (providerResult == null) return [];
  if (Array.isArray(providerResult)) return providerResult;
  if (typeof providerResult === "object" && Array.isArray(providerResult.candidates)) {
    return providerResult.candidates;
  }
  const err = new Error(
    "provider must return { candidates: [] } or an array of candidates"
  );
  err.code = "aikido-extractor-provider-shape";
  throw err;
}

function buildCandidateId(parts) {
  const payload = JSON.stringify({
    sourceId: parts.sourceId,
    title: parts.title,
    category: parts.category,
    summary: parts.summary,
    content: parts.content,
    difficulty: parts.difficulty,
    extractedAt: parts.extractedAt,
    index: parts.index,
  });
  const hash = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  return `cand-${hash.slice(0, 16)}`;
}

function buildCandidate(raw, ctx) {
  const errors = [];
  const warnings = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["candidate must be an object"], warnings: [] };
  }

  const title = raw.title == null ? "" : String(raw.title).trim();
  if (!title) errors.push("title is required");

  const category = raw.category == null ? "" : String(raw.category).trim();
  if (!CATEGORY_SET.has(category)) {
    errors.push(
      `category must be one of: ${CATEGORIES.join(", ")} (got ${raw.category})`
    );
  }

  const summary = raw.summary == null ? "" : String(raw.summary);
  const content = raw.content == null ? "" : String(raw.content);
  if (isBlank(summary) && isBlank(content)) {
    errors.push("summary or content is required");
  }

  if (raw.tags != null && !Array.isArray(raw.tags)) {
    errors.push("tags must be an array");
  }
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)) : [];

  let difficulty = raw.difficulty;
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
    errors.push("difficulty must be an integer 1–5");
  }

  let confidence = null;
  if (raw.confidence != null && raw.confidence !== "") {
    const n = Number(raw.confidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      errors.push("confidence must be a number between 0 and 1");
    } else {
      confidence = n;
    }
  }

  if (raw.sourceReferences != null && !Array.isArray(raw.sourceReferences)) {
    errors.push("sourceReferences must be an array");
  }
  const sourceReferences = [];
  if (Array.isArray(raw.sourceReferences)) {
    for (const ref of raw.sourceReferences) {
      if (!ref || typeof ref !== "object") {
        errors.push("sourceReferences entries must be objects");
        continue;
      }
      const quote = ref.quote == null ? "" : String(ref.quote);
      const location = ref.location == null ? "" : String(ref.location);
      sourceReferences.push({
        sourceId: ctx.sourceId,
        quote,
        location,
      });
      if (quote && !ctx.sourceText.includes(quote)) {
        warnings.push(`quote not found in source text: ${quote.slice(0, 40)}`);
      }
    }
  } else {
    sourceReferences.push({
      sourceId: ctx.sourceId,
      quote: "",
      location: "",
    });
  }

  if (raw.warnings != null && !Array.isArray(raw.warnings)) {
    errors.push("warnings must be an array");
  }
  const candidateWarnings = Array.isArray(raw.warnings)
    ? raw.warnings.map((w) => String(w))
    : [];
  warnings.push(...candidateWarnings);

  if (errors.length) {
    return { ok: false, errors, warnings };
  }

  const candidateId = buildCandidateId({
    sourceId: ctx.sourceId,
    title,
    category,
    summary,
    content,
    difficulty,
    extractedAt: ctx.extractedAt,
    index: ctx.index,
  });

  return {
    ok: true,
    errors: [],
    warnings,
    candidate: {
      candidateId,
      title,
      category,
      summary,
      content,
      tags,
      difficulty,
      sourceReferences,
      confidence,
      warnings: warnings.slice(),
      metadata: {
        extractorVersion: EXTRACTOR_VERSION,
        provider: ctx.providerName,
        extractedAt: ctx.extractedAt,
      },
    },
  };
}

/**
 * Validate a candidate object (does not mutate).
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateCandidate(candidate) {
  const errors = [];
  const warnings = [];

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {
      valid: false,
      errors: ["candidate must be an object"],
      warnings: [],
    };
  }

  if (isBlank(candidate.title)) errors.push("title is required");
  if (!CATEGORY_SET.has(String(candidate.category || "").trim())) {
    errors.push(`invalid category: ${candidate.category}`);
  }
  if (isBlank(candidate.summary) && isBlank(candidate.content)) {
    errors.push("summary or content is required");
  }
  if (!Array.isArray(candidate.tags)) errors.push("tags must be an array");
  if (
    !Number.isInteger(candidate.difficulty) ||
    candidate.difficulty < 1 ||
    candidate.difficulty > 5
  ) {
    errors.push("difficulty must be an integer 1–5");
  }
  if (candidate.confidence != null) {
    const n = Number(candidate.confidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      errors.push("confidence must be between 0 and 1");
    }
  }
  if (!Array.isArray(candidate.sourceReferences)) {
    errors.push("sourceReferences must be an array");
  }
  if (!Array.isArray(candidate.warnings)) {
    errors.push("warnings must be an array");
  } else {
    warnings.push(...candidate.warnings.map((w) => String(w)));
  }
  if (!candidate.metadata || typeof candidate.metadata !== "object") {
    errors.push("metadata is required");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = {
  EXTRACTOR_VERSION,
  createAikidoKnowledgeExtractor,
  validateCandidate,
  resolveExtractionText,
  buildCandidateId,
};
