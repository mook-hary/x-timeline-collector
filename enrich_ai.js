require("dotenv").config({ quiet: true });

const path = require("path");
const OpenAI = require("openai");
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
const {
  emptyUsage,
  extractUsageFromResponse,
  addUsage,
  printUsageSummary,
} = require("./lib/api-usage");

const INPUT_FILE = path.join(__dirname, "output", "timeline_ai.json");
const OUTPUT_FILE = path.join(__dirname, "output", "timeline_enriched.json");
const PROGRESS_FILE = path.join(__dirname, "output", "enrich_progress.json");
const CACHE_FILE = path.join(__dirname, "output", "enrich_cache.json");

const ENRICH_AI_PROMPT_VERSION = "1";
const ENRICH_AI_SCHEMA_VERSION = "1";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MIN_INTERVAL_MS = 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["importance", "summary", "tags", "reason"],
  properties: {
    importance: {
      type: "integer",
      minimum: 1,
      maximum: 5,
      description: "重要度 1(低)〜5(高)",
    },
    summary: {
      type: "string",
      description: "日本語で80文字以内の要約",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 5,
    },
    reason: {
      type: "string",
      description: "重要度と判断の短い理由。日本語60文字以内",
    },
  },
};

const SYSTEM_PROMPT = `あなたはX（Twitter）投稿の補強分析器です。
すでに決まっている category は変更せず、追加情報だけを生成してください。

出力する項目:
- importance: 1〜5 の整数
  5: 自分の学習・仕事・意思決定に強く関わる
  4: 有用で後から見返したい
  3: 普通に興味がある
  2: 弱い関心・雑談寄り
  1: 広告・ノイズ・ほぼ無関係
- summary: 投稿の要点を日本語で80文字以内
- tags: 検索しやすい短いタグを0〜5個
- reason: 重要度の根拠を日本語で60文字以内

注意事項:
- category は入力の確定値として扱い、再分類しない
- 単語の有無だけでなく、投稿全体の主題で判断する
- 広告・販促が主目的なら importance は低め（1〜2）
- 極端に短い反応や判断不能な投稿は summary を簡潔にし、importance は低め
- authorName / authorHandle は補助情報のみ
- URLのドメインだけで判断しない
- JSON以外は出力しない`;

function printHelp() {
  console.log(`x-timeline-collector AI Enrich (enrich_ai.js)

Usage:
  node enrich_ai.js [--limit N]
  node enrich_ai.js --cache-stats
  node enrich_ai.js --help
  npm run enrich -- [--limit N]

Options:
  --limit <N>     Max posts to process this run (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})
  --cache-stats   Print cache stats only (no API)
  --help, -h      Show this help (does not enrich)

Input:
  output/timeline_ai.json

Output:
  output/timeline_enriched.json
  output/enrich_progress.json
  output/enrich_cache.json

API:
  Required when pending targets need OpenAI (OPENAI_API_KEY in .env).
  Optional OPENAI_MODEL (default gpt-5-mini).

Chrome:
  Not required

Notes:
  Does not change category. Adds enrichment only.
  Progress/cache reused only when execution contract matches.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true, cacheStats: false, limit: DEFAULT_LIMIT };
  }
  return {
    help: false,
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
  return readJsonObjectOptional(
    PROGRESS_FILE,
    {},
    "output/enrich_progress.json"
  );
}

function getEnrichCacheResult(value) {
  if (value && value.result && typeof value.result === "object") {
    return value.result;
  }
  if (!value || typeof value !== "object") return null;
  return {
    importance: value.importance,
    summary: value.summary,
    tags: value.tags,
    reason: value.reason,
  };
}

function isValidEnrichCacheResult(result) {
  return Boolean(
    result &&
      Number.isInteger(result.importance) &&
      result.importance >= 1 &&
      result.importance <= 5 &&
      typeof result.summary === "string" &&
      typeof result.reason === "string" &&
      Array.isArray(result.tags)
  );
}

function loadCache() {
  const data = readJsonObjectOptional(CACHE_FILE, {}, "output/enrich_cache.json");

  for (const [key, value] of Object.entries(data)) {
    if (typeof key !== "string") {
      fail("output/enrich_cache.json のキーが不正です。上書きせず終了します。");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(
        `output/enrich_cache.json の値が不正です（キー: ${key}）。上書きせず終了します。`
      );
    }
    const result = getEnrichCacheResult(value);
    if (!isValidEnrichCacheResult(result)) {
      fail(
        `output/enrich_cache.json の結果フィールドが不正です（キー: ${key}）。上書きせず終了します。`
      );
    }
  }

  return data;
}

function getCategory(post) {
  return post.finalAnalysis?.category || post.analysis?.category || "その他";
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  return list.map((tag) => String(tag ?? "")).sort((a, b) => a.localeCompare(b));
}

function computeInputFingerprint(post) {
  const finalAnalysis = post.finalAnalysis || {};
  return hashStable({
    authorHandle: normalizeHandle(post.authorHandle),
    text: normalizeText(post.text),
    finalCategory: getCategory(post),
    classificationSource: finalAnalysis.source || "",
    classificationConfidence:
      finalAnalysis.confidence === undefined ? null : finalAnalysis.confidence,
    classificationReason: finalAnalysis.reason || "",
    classificationTags: normalizeTags(finalAnalysis.tags),
  });
}

function buildExecutionContract(post, model) {
  return {
    inputFingerprint: computeInputFingerprint(post),
    model,
    promptVersion: ENRICH_AI_PROMPT_VERSION,
    schemaVersion: ENRICH_AI_SCHEMA_VERSION,
  };
}

function isProgressCompleteForContract(entry, contract) {
  if (!matchesExecutionContract(entry, contract)) return false;
  return Number.isInteger(entry.importance);
}

function displayHandle(post) {
  const handle = normalizeHandle(post.authorHandle);
  return handle || "@unknown";
}

function truncateChars(value, max) {
  const text = String(value || "").trim();
  if ([...text].length <= max) return text;
  return [...text].slice(0, max).join("");
}

function buildEnrichPayload(post) {
  const finalAnalysis = post.finalAnalysis || {};
  return {
    authorName: post.authorName || "",
    authorHandle: post.authorHandle || "",
    text: post.text || "",
    url: post.url || "",
    category: getCategory(post),
    classificationSource: finalAnalysis.source || "",
    classificationConfidence: finalAnalysis.confidence ?? null,
    classificationReason: finalAnalysis.reason || "",
    classificationTags: Array.isArray(finalAnalysis.tags) ? finalAnalysis.tags : [],
  };
}

function validateEnrichResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("AI応答がオブジェクトではありません");
  }
  if (!Number.isInteger(data.importance) || data.importance < 1 || data.importance > 5) {
    throw new Error("importance は 1〜5 の整数である必要があります");
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    throw new Error("summary が空です");
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
    importance: data.importance,
    summary: truncateChars(data.summary, 80),
    tags: data.tags.slice(0, 5).map((tag) => String(tag).trim()).filter(Boolean),
    reason: truncateChars(data.reason, 60),
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

async function enrichWithAi(client, model, post) {
  const payload = buildEnrichPayload(post);

  const response = await client.responses.create({
    model,
    instructions: SYSTEM_PROMPT,
    input: JSON.stringify(payload, null, 2),
    text: {
      format: {
        type: "json_schema",
        name: "timeline_enrichment",
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

  return {
    result: validateEnrichResult(parsed),
    usage: extractUsageFromResponse(response),
  };
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
    importance: result.importance,
    summary: result.summary,
    tags: result.tags,
    reason: result.reason,
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
      importance: result.importance,
      summary: result.summary,
      tags: result.tags,
      reason: result.reason,
    },
    importance: result.importance,
    summary: result.summary,
    tags: result.tags,
    reason: result.reason,
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
  if (!isValidEnrichCacheResult(getEnrichCacheResult(entry))) {
    return { cacheKey, entry: null };
  }
  return { cacheKey, entry };
}

function buildEnrichment(post, progress, model) {
  const url = post.url || "";
  const contract = buildExecutionContract(post, model);
  const saved = url ? progress[url] : null;

  if (saved && isProgressCompleteForContract(saved, contract)) {
    const source = saved.source === "ai-cache" ? "ai-cache" : "ai";
    return {
      source,
      importance: saved.importance,
      summary: saved.summary || "",
      tags: Array.isArray(saved.tags) ? saved.tags : [],
      reason: saved.reason || "",
      analyzedAt: saved.completedAt || saved.analyzedAt || "",
      model: saved.model || "",
    };
  }

  return {
    source: "pending",
    importance: 0,
    summary: "",
    tags: [],
    reason: "補強分析待ち",
    analyzedAt: "",
    model: "",
  };
}

function buildOutputPosts(posts, progress, model) {
  return posts.map((post) => {
    const { enrichment: _ignored, ...rest } = post;
    return {
      ...rest,
      enrichment: buildEnrichment(post, progress, model),
    };
  });
}

function printCacheStats(cache) {
  const versions = {
    promptVersion: ENRICH_AI_PROMPT_VERSION,
    schemaVersion: ENRICH_AI_SCHEMA_VERSION,
  };
  const entries = Object.entries(cache).map(([hash, value]) => ({
    hash,
    ...value,
    useCount: Number(value.useCount) || 0,
    kind: classifyCacheEntryKind(value, versions),
  }));

  const totalUseCount = entries.reduce((sum, entry) => sum + entry.useCount, 0);
  const byModel = {};
  const byImportance = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const byKind = { valid: 0, legacy: 0, mismatch: 0 };

  for (const entry of entries) {
    const modelName = entry.model || "(unknown)";
    byModel[modelName] = (byModel[modelName] || 0) + 1;
    byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    const importance = getEnrichCacheResult(entry)?.importance;
    if (byImportance[importance] != null) {
      byImportance[importance] += 1;
    }
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
  console.log("重要度別件数:");
  for (let i = 5; i >= 1; i--) {
    console.log(`  ${i}: ${byImportance[i]}`);
  }
  console.log("最も利用された上位10件:");
  if (mostUsed.length === 0) {
    console.log("  (なし)");
  } else {
    for (const [index, entry] of mostUsed.entries()) {
      const importance =
        getEnrichCacheResult(entry)?.importance ?? entry.importance;
      console.log(
        `  ${index + 1}. useCount=${entry.useCount} kind=${entry.kind} importance=${importance} hash=${entry.hash.slice(0, 12)}...`
      );
    }
  }
  console.log("最終利用日時が古い上位10件:");
  if (oldest.length === 0) {
    console.log("  (なし)");
  } else {
    for (const [index, entry] of oldest.entries()) {
      const importance =
        getEnrichCacheResult(entry)?.importance ?? entry.importance;
      console.log(
        `  ${index + 1}. lastUsedAt=${entry.lastUsedAt || entry.cachedAt || "(なし)"} kind=${entry.kind} importance=${importance} hash=${entry.hash.slice(0, 12)}...`
      );
    }
  }
  console.log("使用モデル別件数:");
  const models = Object.keys(byModel).sort();
  if (models.length === 0) {
    console.log("  (なし)");
  } else {
    for (const modelName of models) {
      console.log(`  ${modelName}: ${byModel[modelName]}`);
    }
  }
}

async function main() {
  const { help, cacheStats, limit } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  const cache = loadCache();

  if (cacheStats) {
    printCacheStats(cache);
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";

  const posts = readJsonArrayRequired(INPUT_FILE, "output/timeline_ai.json");

  const progress = loadProgress();
  const contractDoneTargets = posts.filter((post) => {
    if (!post.url) return false;
    const contract = buildExecutionContract(post, model);
    return isProgressCompleteForContract(progress[post.url], contract);
  });
  const pendingTargets = posts.filter((post) => {
    if (!post.url) return true;
    const contract = buildExecutionContract(post, model);
    return !isProgressCompleteForContract(progress[post.url], contract);
  });
  const toProcess = pendingTargets.slice(0, limit);

  console.log(`全投稿数: ${posts.length}`);
  console.log(`契約一致の進捗済み件数: ${contractDoneTargets.length}`);
  console.log(`キャッシュ登録件数: ${Object.keys(cache).length}`);
  console.log(`今回の処理上限: ${limit}`);
  console.log(`今回処理する件数: ${toProcess.length}`);
  console.log(`モデル: ${model}`);
  console.log(
    `promptVersion=${ENRICH_AI_PROMPT_VERSION} schemaVersion=${ENRICH_AI_SCHEMA_VERSION}`
  );

  let apiAttemptCount = 0;
  let apiSuccessCount = 0;
  let apiFailureCount = 0;
  let cacheHitCount = 0;
  let consecutiveFailures = 0;
  let client = null;
  let usageTotals = emptyUsage();

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
      (post) => post.enrichment?.source === "pending"
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
    printUsageSummary("Enrich", usageTotals);
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

        const result = getEnrichCacheResult(cached);
        writeProgressFromResult(
          progress,
          post.url,
          contract,
          {
            importance: result.importance,
            summary: result.summary,
            tags: Array.isArray(result.tags) ? result.tags : [],
            reason: result.reason,
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
        const { result, usage } = await enrichWithAi(client, model, post);
        usageTotals = addUsage(usageTotals, usage);
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
          `[${label}] 成功: importance=${result.importance} summary=${result.summary}`
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
    (post) => post.enrichment?.source === "pending"
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
  printUsageSummary("Enrich", usageTotals);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`予期しないエラーで終了しました: ${message}`);
    process.exit(1);
  });
}

module.exports = {
  ENRICH_AI_PROMPT_VERSION,
  ENRICH_AI_SCHEMA_VERSION,
  computeInputFingerprint,
  buildExecutionContract,
  isProgressCompleteForContract,
  findMatchingCacheEntry,
  writeProgressFromResult,
  writeCacheEntry,
  buildEnrichment,
};
