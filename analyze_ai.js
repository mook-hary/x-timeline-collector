require("dotenv").config({ quiet: true });

const path = require("path");
const OpenAI = require("openai");
const { getCategoryOrder } = require("./lib/categories");
const {
  normalizeHandle,
  normalizeText,
  hashStable,
  matchesExecutionContract,
  buildCacheKey,
  classifyCacheEntryKind,
} = require("./lib/ai-contract");
const {
  fail,
  readJsonArrayRequired,
  readJsonObjectOptional,
  writeJsonAtomic,
} = require("./lib/pipeline-io");

const INPUT_FILE = path.join(__dirname, "output", "timeline_analyzed.json");
const OUTPUT_FILE = path.join(__dirname, "output", "timeline_ai.json");
const PROGRESS_FILE = path.join(__dirname, "output", "ai_progress.json");
const CACHE_FILE = path.join(__dirname, "output", "ai_cache.json");

// Source of Truth: config/categories.json (key order)
const CATEGORIES = getCategoryOrder();

const ANALYZE_AI_PROMPT_VERSION = "1";
const ANALYZE_AI_SCHEMA_VERSION = "1";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MIN_INTERVAL_MS = 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "confidence", "reason", "tags"],
  properties: {
    category: {
      type: "string",
      enum: CATEGORIES,
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    reason: {
      type: "string",
      description: "日本語で60文字以内の短い理由",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 5,
    },
  },
};

const SYSTEM_PROMPT = `あなたはX（Twitter）投稿の分類器です。投稿本文の主題を判断し、指定カテゴリから最も適切なものを1つだけ選んでください。

注意事項:
- 単語が出ているだけで決めず、投稿全体の主題を判断する
- 広告や販促が主目的なら「広告・PR」
- 記事紹介でも、記事の主題が明確なら内容カテゴリを優先する
- 前後の文脈や引用先がなく、判断不能なら「その他」
- 極端に短い反応だけの投稿は無理に推測せず「その他」
- 複数カテゴリにまたがる場合は中心的な主題を1つ選ぶ
- authorNameやauthorHandleは補助情報としてのみ使う
- URLのドメインだけで分類しない

必ず指定のJSON形式だけで回答してください。`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  return {
    cacheStats: argv.includes("--cache-stats"),
    limit: parseLimit(argv),
  };
}

function parseLimit(argv) {
  const index = argv.indexOf("--limit");
  if (index === -1) return DEFAULT_LIMIT;

  const raw = argv[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    fail("--limit には 1 以上の整数を指定してください。");
  }
  return Math.min(value, MAX_LIMIT);
}

function loadProgress() {
  return readJsonObjectOptional(PROGRESS_FILE, {}, "output/ai_progress.json");
}

function getAnalyzeCacheResult(value) {
  if (value && value.result && typeof value.result === "object") {
    return value.result;
  }
  if (!value || typeof value !== "object") return null;
  return {
    category: value.category,
    confidence: value.confidence,
    reason: value.reason,
    tags: value.tags,
  };
}

function isValidAnalyzeCacheResult(result) {
  return Boolean(
    result &&
      typeof result.category === "string" &&
      typeof result.confidence === "number" &&
      !Number.isNaN(result.confidence) &&
      typeof result.reason === "string" &&
      Array.isArray(result.tags)
  );
}

function loadCache() {
  const data = readJsonObjectOptional(CACHE_FILE, {}, "output/ai_cache.json");

  for (const [key, value] of Object.entries(data)) {
    if (typeof key !== "string") {
      fail("output/ai_cache.json のキーが不正です。上書きせず終了します。");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(
        `output/ai_cache.json の値が不正です（キー: ${key}）。上書きせず終了します。`
      );
    }
    const result = getAnalyzeCacheResult(value);
    if (!isValidAnalyzeCacheResult(result)) {
      fail(
        `output/ai_cache.json の結果フィールドが不正です（キー: ${key}）。上書きせず終了します。`
      );
    }
  }

  return data;
}

function normalizeMatchedKeywords(matchedKeywords) {
  const list = Array.isArray(matchedKeywords) ? matchedKeywords : [];
  return list
    .map((item) => ({
      keyword: String(item?.keyword ?? ""),
      weight: Number(item?.weight) || 0,
    }))
    .sort(
      (a, b) =>
        a.keyword.localeCompare(b.keyword) || a.weight - b.weight
    );
}

function computeInputFingerprint(post) {
  const analysis = post.analysis || {};
  return hashStable({
    authorHandle: normalizeHandle(post.authorHandle),
    text: normalizeText(post.text),
    keywordCategory: analysis.category || "",
    keywordConfidence: analysis.confidence || "",
    categoryScores: analysis.categoryScores || {},
    matchedKeywords: normalizeMatchedKeywords(analysis.matchedKeywords),
  });
}

function buildExecutionContract(post, model) {
  return {
    inputFingerprint: computeInputFingerprint(post),
    model,
    promptVersion: ANALYZE_AI_PROMPT_VERSION,
    schemaVersion: ANALYZE_AI_SCHEMA_VERSION,
  };
}

function isProgressCompleteForContract(entry, contract) {
  if (!matchesExecutionContract(entry, contract)) return false;
  return typeof entry.category === "string" && entry.category;
}

function displayHandle(post) {
  const handle = normalizeHandle(post.authorHandle);
  return handle || "@unknown";
}

function needsAi(post) {
  const analysis = post.analysis || {};
  return analysis.confidence === "low" || analysis.category === "その他";
}

function keywordConfidenceValue(level) {
  if (level === "high") return 0.9;
  if (level === "medium") return 0.8;
  return 0.5;
}

function buildAiPayload(post) {
  const analysis = post.analysis || {};
  return {
    authorName: post.authorName || "",
    authorHandle: post.authorHandle || "",
    text: post.text || "",
    url: post.url || "",
    keywordCategory: analysis.category || "",
    keywordConfidence: analysis.confidence || "",
    categoryScores: analysis.categoryScores || {},
    matchedKeywords: analysis.matchedKeywords || [],
  };
}

function truncateReason(reason) {
  const text = String(reason || "").trim();
  if ([...text].length <= 60) return text;
  return [...text].slice(0, 60).join("");
}

function validateAiResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("AI応答がオブジェクトではありません");
  }
  if (!CATEGORIES.includes(data.category)) {
    throw new Error(`不正なカテゴリです: ${data.category}`);
  }
  if (typeof data.confidence !== "number" || Number.isNaN(data.confidence)) {
    throw new Error("confidence が数値ではありません");
  }
  if (data.confidence < 0 || data.confidence > 1) {
    throw new Error("confidence は 0 から 1 の範囲である必要があります");
  }
  if (typeof data.reason !== "string" || !data.reason.trim()) {
    throw new Error("reason が空です");
  }
  if (!Array.isArray(data.tags)) {
    throw new Error("tags が配列ではありません");
  }
  if (data.tags.length > 5) {
    throw new Error("tags は最大5個までです");
  }
  if (!data.tags.every((tag) => typeof tag === "string")) {
    throw new Error("tags の要素は文字列である必要があります");
  }

  return {
    category: data.category,
    confidence: data.confidence,
    reason: truncateReason(data.reason),
    tags: data.tags.slice(0, 5),
  };
}

function extractOutputText(response) {
  if (response && typeof response.output_text === "string" && response.output_text) {
    return response.output_text;
  }

  if (!response || !Array.isArray(response.output)) {
    throw new Error("AI応答からテキストを取得できませんでした");
  }

  const chunks = [];
  for (const item of response.output) {
    if (!item || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content && content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }

  const text = chunks.join("").trim();
  if (!text) {
    throw new Error("AI応答が空でした");
  }
  return text;
}

async function classifyWithAi(client, model, post) {
  const payload = buildAiPayload(post);

  const response = await client.responses.create({
    model,
    instructions: SYSTEM_PROMPT,
    input: JSON.stringify(payload, null, 2),
    text: {
      format: {
        type: "json_schema",
        name: "timeline_classification",
        strict: true,
        schema: RESPONSE_SCHEMA,
      },
    },
  });

  const text = extractOutputText(response);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`AI応答のJSON解析に失敗しました: ${error.message}`);
  }

  return validateAiResult(parsed);
}

function touchCacheEntry(cache, cacheKey) {
  const entry = cache[cacheKey];
  entry.lastUsedAt = new Date().toISOString();
  entry.useCount = (Number(entry.useCount) || 0) + 1;
}

function writeProgressFromResult(progress, url, contract, result, source, completedAt) {
  progress[url] = {
    url,
    source,
    inputFingerprint: contract.inputFingerprint,
    model: contract.model,
    promptVersion: contract.promptVersion,
    schemaVersion: contract.schemaVersion,
    category: result.category,
    confidence: result.confidence,
    reason: result.reason,
    tags: result.tags,
    completedAt,
    analyzedAt: completedAt,
  };
}

function writeCacheEntry(cache, cacheKey, contract, result, cachedAt) {
  cache[cacheKey] = {
    inputFingerprint: contract.inputFingerprint,
    model: contract.model,
    promptVersion: contract.promptVersion,
    schemaVersion: contract.schemaVersion,
    result: {
      category: result.category,
      confidence: result.confidence,
      reason: result.reason,
      tags: result.tags,
    },
    // Flat fields kept for older readers / stats display
    category: result.category,
    confidence: result.confidence,
    reason: result.reason,
    tags: result.tags,
    cachedAt,
    createdAt: cachedAt,
    lastUsedAt: cachedAt,
    useCount: 1,
  };
}

function findMatchingCacheEntry(cache, contract) {
  const cacheKey = buildCacheKey(contract);
  const entry = cache[cacheKey];
  if (!entry) return { cacheKey, entry: null };
  if (!matchesExecutionContract(entry, contract)) {
    return { cacheKey, entry: null };
  }
  if (!isValidAnalyzeCacheResult(getAnalyzeCacheResult(entry))) {
    return { cacheKey, entry: null };
  }
  return { cacheKey, entry };
}

function buildFinalAnalysis(post, progress, model) {
  const analysis = post.analysis || {};
  const url = post.url || "";

  if (!needsAi(post)) {
    return {
      source: "keyword",
      category: analysis.category || "その他",
      confidence: keywordConfidenceValue(analysis.confidence),
      reason: "キーワード分類の確信度がmedium以上",
      tags: [],
      analyzedAt: analysis.analyzedAt || "",
    };
  }

  const contract = buildExecutionContract(post, model);
  const saved = url ? progress[url] : null;
  if (saved && isProgressCompleteForContract(saved, contract)) {
    const source = saved.source === "ai-cache" ? "ai-cache" : "ai";
    return {
      source,
      category: saved.category,
      confidence: saved.confidence,
      reason: saved.reason,
      tags: Array.isArray(saved.tags) ? saved.tags : [],
      analyzedAt: saved.completedAt || saved.analyzedAt || "",
    };
  }

  return {
    source: "pending",
    category: "その他",
    confidence: 0,
    reason: "AI分類待ち",
    tags: [],
    analyzedAt: "",
  };
}

function buildOutputPosts(posts, progress, model) {
  return posts.map((post) => ({
    ...post,
    finalAnalysis: buildFinalAnalysis(post, progress, model),
  }));
}

function printCacheStats(cache) {
  const versions = {
    promptVersion: ANALYZE_AI_PROMPT_VERSION,
    schemaVersion: ANALYZE_AI_SCHEMA_VERSION,
  };
  const entries = Object.entries(cache).map(([hash, value]) => ({
    hash,
    ...value,
    useCount: Number(value.useCount) || 0,
    kind: classifyCacheEntryKind(value, versions),
  }));

  const totalUseCount = entries.reduce((sum, entry) => sum + entry.useCount, 0);
  const byModel = {};
  const byKind = { valid: 0, legacy: 0, mismatch: 0 };
  for (const entry of entries) {
    const model = entry.model || "(unknown)";
    byModel[model] = (byModel[model] || 0) + 1;
    byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
  }

  const mostUsed = [...entries]
    .sort((a, b) => b.useCount - a.useCount || a.hash.localeCompare(b.hash))
    .slice(0, 10);

  const oldest = [...entries]
    .sort((a, b) => {
      const aTime = Date.parse(a.lastUsedAt || a.cachedAt || "") || 0;
      const bTime = Date.parse(b.lastUsedAt || b.cachedAt || "") || 0;
      if (aTime !== bTime) return aTime - bTime;
      return a.hash.localeCompare(b.hash);
    })
    .slice(0, 10);

  console.log(`キャッシュ総件数: ${entries.length}`);
  console.log(`合計利用回数: ${totalUseCount}`);
  console.log(
    `契約別: valid=${byKind.valid} legacy=${byKind.legacy} mismatch=${byKind.mismatch}`
  );
  console.log("最も利用された上位10件:");
  if (mostUsed.length === 0) {
    console.log("  (なし)");
  } else {
    for (const [index, entry] of mostUsed.entries()) {
      const category =
        getAnalyzeCacheResult(entry)?.category || entry.category || "(なし)";
      console.log(
        `  ${index + 1}. useCount=${entry.useCount} kind=${entry.kind} category=${category} hash=${entry.hash.slice(0, 12)}...`
      );
    }
  }
  console.log("最終利用日時が古い上位10件:");
  if (oldest.length === 0) {
    console.log("  (なし)");
  } else {
    for (const [index, entry] of oldest.entries()) {
      const category =
        getAnalyzeCacheResult(entry)?.category || entry.category || "(なし)";
      console.log(
        `  ${index + 1}. lastUsedAt=${entry.lastUsedAt || entry.cachedAt || "(なし)"} kind=${entry.kind} category=${category} hash=${entry.hash.slice(0, 12)}...`
      );
    }
  }
  console.log("使用モデル別件数:");
  const models = Object.keys(byModel).sort();
  if (models.length === 0) {
    console.log("  (なし)");
  } else {
    for (const model of models) {
      console.log(`  ${model}: ${byModel[model]}`);
    }
  }
}

async function main() {
  const { cacheStats, limit } = parseArgs(process.argv.slice(2));
  const cache = loadCache();

  if (cacheStats) {
    printCacheStats(cache);
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";

  const posts = readJsonArrayRequired(
    INPUT_FILE,
    "output/timeline_analyzed.json"
  );

  const progress = loadProgress();
  const aiTargets = posts.filter(needsAi);
  const contractDoneTargets = aiTargets.filter((post) => {
    if (!post.url) return false;
    const contract = buildExecutionContract(post, model);
    return isProgressCompleteForContract(progress[post.url], contract);
  });
  const pendingTargets = aiTargets.filter((post) => {
    if (!post.url) return true;
    const contract = buildExecutionContract(post, model);
    return !isProgressCompleteForContract(progress[post.url], contract);
  });
  const toProcess = pendingTargets.slice(0, limit);

  console.log(`全投稿数: ${posts.length}`);
  console.log(`AI分類対象数: ${aiTargets.length}`);
  console.log(`契約一致の進捗済み件数: ${contractDoneTargets.length}`);
  console.log(`キャッシュ登録件数: ${Object.keys(cache).length}`);
  console.log(`今回の処理上限: ${limit}`);
  console.log(`今回処理する件数: ${toProcess.length}`);
  console.log(`モデル: ${model}`);
  console.log(
    `promptVersion=${ANALYZE_AI_PROMPT_VERSION} schemaVersion=${ANALYZE_AI_SCHEMA_VERSION}`
  );

  let apiAttemptCount = 0;
  let apiSuccessCount = 0;
  let apiFailureCount = 0;
  let cacheHitCount = 0;
  let consecutiveFailures = 0;
  let client = null;

  const needsApi = toProcess.some((post) => {
    const contract = buildExecutionContract(post, model);
    return !findMatchingCacheEntry(cache, contract).entry;
  });
  if (needsApi && !apiKey) {
    fail(
      "OPENAI_API_KEY が設定されていません。\n" +
        ".env.example をコピーして .env を作成し、APIキーを設定してください。\n" +
        "例: cp .env.example .env"
    );
  }

  if (toProcess.length === 0) {
    const outputPosts = buildOutputPosts(posts, progress, model);
    writeJsonAtomic(OUTPUT_FILE, outputPosts);
    const pendingCount = outputPosts.filter(
      (post) => post.finalAnalysis?.source === "pending"
    ).length;
    console.log("今回処理する対象はありません。");
    console.log(`今回API実行件数: 0`);
    console.log(`今回キャッシュ使用件数: 0`);
    console.log(`契約一致の進捗再利用件数: ${contractDoneTargets.length}`);
    console.log(`API成功件数: 0`);
    console.log(`API失敗件数: 0`);
    console.log(`未処理件数: ${pendingCount}`);
    console.log(`キャッシュ総件数: ${Object.keys(cache).length}`);
    console.log(`保存先: ${OUTPUT_FILE}`);
    return;
  }

  for (let i = 0; i < toProcess.length; i++) {
    const post = toProcess[i];
    const label = `${i + 1}/${toProcess.length}`;
    const handle = displayHandle(post);
    const contract = buildExecutionContract(post, model);

    try {
      if (!post.url) {
        throw new Error("投稿URLがないため進捗キーを保存できません");
      }

      if (isProgressCompleteForContract(progress[post.url], contract)) {
        console.log(`[${label}] 契約一致の進捗を使用: ${handle}`);
        continue;
      }

      const { cacheKey, entry: cached } = findMatchingCacheEntry(cache, contract);
      if (cached) {
        touchCacheEntry(cache, cacheKey);
        writeJsonAtomic(CACHE_FILE, cache);

        const result = getAnalyzeCacheResult(cached);
        writeProgressFromResult(
          progress,
          post.url,
          contract,
          {
            category: result.category,
            confidence: result.confidence,
            reason: result.reason,
            tags: Array.isArray(result.tags) ? result.tags : [],
          },
          "ai-cache",
          cached.cachedAt ||
            cached.createdAt ||
            cached.lastUsedAt ||
            new Date().toISOString()
        );
        writeJsonAtomic(PROGRESS_FILE, progress);
        cacheHitCount++;
        console.log(`[${label}] キャッシュ使用: ${handle}`);
      } else {
        if (!client) {
          client = new OpenAI({ apiKey });
        }

        console.log(`[${label}] API実行: ${handle}`);
        apiAttemptCount++;
        const result = await classifyWithAi(client, model, post);
        const now = new Date().toISOString();

        writeCacheEntry(cache, cacheKey, contract, result, now);
        writeJsonAtomic(CACHE_FILE, cache);

        writeProgressFromResult(
          progress,
          post.url,
          contract,
          result,
          "ai",
          now
        );
        writeJsonAtomic(PROGRESS_FILE, progress);

        apiSuccessCount++;
        consecutiveFailures = 0;
        console.log(
          `[${label}] 成功: ${result.category} (confidence=${result.confidence})`
        );
      }
    } catch (error) {
      apiFailureCount++;
      consecutiveFailures++;
      const message = error && error.message ? error.message : String(error);
      console.error(`[${label}] 失敗: ${message}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `連続 ${MAX_CONSECUTIVE_FAILURES} 件失敗したため処理を中止します。`
        );
        break;
      }
    }

    writeJsonAtomic(OUTPUT_FILE, buildOutputPosts(posts, progress, model));

    if (i < toProcess.length - 1 && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      const upcoming = toProcess[i + 1];
      if (!upcoming) continue;
      const upcomingContract = buildExecutionContract(upcoming, model);
      const upcomingHasProgress = Boolean(
        upcoming.url &&
          isProgressCompleteForContract(progress[upcoming.url], upcomingContract)
      );
      const upcomingHasCache = Boolean(
        findMatchingCacheEntry(cache, upcomingContract).entry
      );
      if (!upcomingHasProgress && !upcomingHasCache) {
        await sleep(MIN_INTERVAL_MS);
      }
    }
  }

  const outputPosts = buildOutputPosts(posts, progress, model);
  writeJsonAtomic(OUTPUT_FILE, outputPosts);
  const remainingPending = outputPosts.filter(
    (post) => post.finalAnalysis?.source === "pending"
  ).length;

  console.log(`今回API実行件数: ${apiAttemptCount}`);
  console.log(`今回キャッシュ使用件数: ${cacheHitCount}`);
  console.log(`契約一致の進捗再利用件数: ${contractDoneTargets.length}`);
  console.log(`API成功件数: ${apiSuccessCount}`);
  console.log(`API失敗件数: ${apiFailureCount}`);
  console.log(`未処理件数: ${remainingPending}`);
  console.log(`キャッシュ総件数: ${Object.keys(cache).length}`);
  console.log(`保存先: ${OUTPUT_FILE}`);
  console.log(`進捗ファイル: ${PROGRESS_FILE}`);
  console.log(`キャッシュファイル: ${CACHE_FILE}`);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`予期しないエラーで終了しました: ${message}`);
    process.exit(1);
  });
}

module.exports = {
  ANALYZE_AI_PROMPT_VERSION,
  ANALYZE_AI_SCHEMA_VERSION,
  computeInputFingerprint,
  buildExecutionContract,
  isProgressCompleteForContract,
  findMatchingCacheEntry,
  writeProgressFromResult,
  writeCacheEntry,
  needsAi,
  buildFinalAnalysis,
};
