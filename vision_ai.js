const { withArtifactProvenance } = require("./lib/collection-provenance");
require("dotenv").config({ quiet: true });

const path = require("path");
const OpenAI = require("openai");
const {
  fail,
  readJsonObjectOptional,
  writeJsonAtomic,
} = require("./lib/pipeline-io");
const {
  emptyUsage,
  extractUsageFromResponse,
  addUsage,
  printUsageSummary,
} = require("./lib/api-usage");
const { parseIoFlags, resolveOptionalPath } = require("./lib/daily-scope");
const {
  VISION_PROMPT_VERSION,
  VISION_SCHEMA_VERSION,
  DEFAULT_VISION_MODEL,
  VISION_RESPONSE_SCHEMA,
  VISION_GROUNDING_PROMPT,
  analyzeVisionPosts,
  buildDailyVisionArtifact,
} = require("./lib/vision-analyze");

const INPUT_FILE = path.join(__dirname, "output", "daily-scope.json");
const OUTPUT_FILE = path.join(__dirname, "output", "daily-vision.json");
const CACHE_FILE = path.join(__dirname, "output", "vision_cache.json");
const PROGRESS_FILE = path.join(__dirname, "output", "vision_progress.json");
const MIN_INTERVAL_MS = 1000;

function printHelp() {
  console.log(`x-timeline-collector Vision Analyze (vision_ai.js)

Isolated Vision stage. Does not change scores, analysis, or enrichment.

Usage:
  node vision_ai.js --dry-run
  node vision_ai.js --no-api
  node vision_ai.js --apply
  node vision_ai.js --cache-stats
  node vision_ai.js --help
  npm run vision -- --dry-run
  npm run vision -- --apply

Options:
  --dry-run, --no-api   Candidate audit only. Zero API. No production writes.
  --apply               Run Vision against Daily Scope (real API).
  --cache-stats         Print cache stats only (no API).
  --input PATH          Default: output/daily-scope.json
  --output PATH         Default: output/daily-vision.json (apply only)
  --cache PATH          Default: output/vision_cache.json (apply only)
  --progress PATH       Default: output/vision_progress.json (apply only)
  --help, -h            Show this help

API:
  Required only for --apply when cache misses exist (OPENAI_API_KEY).
  Optional OPENAI_MODEL (default ${DEFAULT_VISION_MODEL}).

Notes:
  One Vision request per candidate post. All usable media in one request.
  Failed Vision is non-fatal. Output item count matches input.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePathFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value == null || String(value).startsWith("-")) {
    fail(`${name} にはパスを指定してください。`);
  }
  return String(value);
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  const { input, output, rest } = parseIoFlags(argv, fail);
  return {
    help: false,
    dryRun: rest.includes("--dry-run") || rest.includes("--no-api"),
    apply: rest.includes("--apply"),
    cacheStats: rest.includes("--cache-stats"),
    input,
    output,
    cache: parsePathFlag(argv, "--cache"),
    progress: parsePathFlag(argv, "--progress"),
  };
}

function loadCache(cacheFile) {
  const data = readJsonObjectOptional(cacheFile, {}, path.basename(cacheFile));
  for (const [key, value] of Object.entries(data)) {
    if (typeof key !== "string" || !value || typeof value !== "object") {
      fail(`${path.basename(cacheFile)} の形式が不正です。上書きせず終了します。`);
    }
  }
  return data;
}

function extractOutputText(response) {
  if (response && typeof response.output_text === "string" && response.output_text) {
    return response.output_text;
  }

  if (!response || !Array.isArray(response.output)) {
    throw new Error("Vision応答からテキストを取得できませんでした");
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
    throw new Error("Vision応答が空でした");
  }
  return text;
}

function createOpenAiRequestFn(client, usageHolder) {
  let lastCallAt = 0;
  return async function requestVision(request) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
    if (lastCallAt && wait > 0) {
      await sleep(wait);
    }
    lastCallAt = Date.now();

    const response = await client.responses.create({
      model: request.model,
      instructions: request.instructions || VISION_GROUNDING_PROMPT,
      input: request.input,
      text: {
        format: {
          type: "json_schema",
          name: "vision_observations",
          strict: true,
          schema: request.schema || VISION_RESPONSE_SCHEMA,
        },
      },
    });

    // Optional lifecycle notification for internal evaluator diagnostics.
    if (typeof request.onResponse === "function") {
      request.onResponse({ requestId: response && response._request_id });
    }
    usageHolder.usage = addUsage(
      usageHolder.usage,
      extractUsageFromResponse(response)
    );

    const text = extractOutputText(response);
    try {
      return JSON.parse(text);
    } catch (error) {
      const err = new Error(`Vision応答のJSON解析に失敗しました: ${error.message}`);
      err.code = "invalid_output";
      throw err;
    }
  };
}

function printDryRunReport(summary) {
  console.log(`input items: ${summary.inputCount}`);
  console.log(`candidates: ${summary.candidates}`);
  console.log(`skipped: ${summary.skipped}`);
  console.log(`usable media inputs: ${summary.usableMediaInputs}`);
  console.log(`expected Vision requests: ${summary.expectedVisionRequests}`);
  console.log(`API requests actually made: ${summary.apiRequests}`);
  console.log("candidate rows:");
  if (!summary.candidateRows.length) {
    console.log("  (none)");
    return;
  }
  for (const row of summary.candidateRows) {
    console.log(
      `  id=${row.id} author=${row.author} textLength=${row.textLength} mediaCount=${row.mediaCount} mediaTypes=${row.mediaTypes.join(",")}`
    );
  }
}

function printCacheStats(cache) {
  const entries = Object.keys(cache);
  console.log(`Vision cache entries: ${entries.length}`);
}

function writeProgressFromPosts(progress, posts, model, completedAt) {
  for (const post of posts) {
    if (!post || !post.url || !post.vision || post.vision.status !== "ok") {
      continue;
    }
    progress[post.url] = {
      url: post.url,
      source: "vision",
      model,
      promptVersion: VISION_PROMPT_VERSION,
      schemaVersion: VISION_SCHEMA_VERSION,
      completedAt,
      analyzedAt: post.vision.analyzedAt || completedAt,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const cacheFile = resolveOptionalPath(args.cache, CACHE_FILE);
  const cache = loadCache(cacheFile);

  if (args.cacheStats) {
    printCacheStats(cache);
    return;
  }

  const apply = Boolean(args.apply) && !args.dryRun;
  const dryRun = !apply;
  const model = process.env.OPENAI_MODEL || DEFAULT_VISION_MODEL;
  const inputFile = resolveOptionalPath(args.input, INPUT_FILE);
  const outputFile = resolveOptionalPath(args.output, OUTPUT_FILE);
  const progressFile = resolveOptionalPath(args.progress, PROGRESS_FILE);

  return withArtifactProvenance({ inputPath: inputFile, outputPath: outputFile, shape: "editorial", dryRun }, async (output) => {
    const input = output.data;
    const posts = Array.isArray(input) ? input : input.posts;

    console.log(`モデル: ${model}`);
    console.log(
      `promptVersion=${VISION_PROMPT_VERSION} schemaVersion=${VISION_SCHEMA_VERSION}`
    );
    console.log(`mode: ${dryRun ? "dry-run" : "apply"}`);

    let requestFn = null;
    const usageHolder = { usage: emptyUsage() };

    if (!dryRun) {
      const apiKey = process.env.OPENAI_API_KEY;
      let requestImpl = null;
      requestFn = async (request) => {
        if (!apiKey) {
          fail(
            "OPENAI_API_KEY が設定されていません。\n" +
              ".env.example をコピーして .env を作成し、APIキーを設定してください。"
          );
        }
        if (!requestImpl) {
          requestImpl = createOpenAiRequestFn(new OpenAI({ apiKey }), usageHolder);
        }
        return requestImpl(request);
      };
    }

    const result = await analyzeVisionPosts(posts, {
      dryRun,
      model,
      cache,
      requestFn,
    });

    if (dryRun) {
      printDryRunReport(result.summary);
      return;
    }

    const completedAt = new Date().toISOString();
    const artifact = buildDailyVisionArtifact(input, result.posts, {
      model,
      analyzedAt: completedAt,
      apiRequests: result.summary.apiRequests,
      cacheHits: result.summary.cacheHits,
      aborted: result.aborted,
    });
    output.writeJson(artifact);
    writeJsonAtomic(cacheFile, result.cache);

    const progress = readJsonObjectOptional(progressFile, {}, path.basename(progressFile));
    writeProgressFromPosts(progress, result.posts, model, completedAt);
    writeJsonAtomic(progressFile, progress);

    console.log(`全投稿数: ${result.summary.inputCount}`);
    console.log(`候補数: ${result.summary.candidates}`);
    console.log(`skipped: ${result.summary.skipped}`);
    console.log(`ok: ${result.summary.ok}`);
    console.log(`failed: ${result.summary.failed}`);
    console.log(`今回API実行件数: ${result.summary.apiRequests}`);
    console.log(`今回キャッシュ使用件数: ${result.summary.cacheHits}`);
    console.log(`保存先: ${outputFile}`);
    console.log(`進捗ファイル: ${progressFile}`);
    console.log(`キャッシュファイル: ${cacheFile}`);
    if (result.internalErrors.length) {
      for (const err of result.internalErrors) {
        console.error(`[vision] ${err.category}: ${err.message}`);
      }
    }
    printUsageSummary("Vision", usageHolder.usage);
  });
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? String(error.message) : String(error);
    console.error(`予期しないエラーで終了しました: ${message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  printHelp,
  createOpenAiRequestFn,
};
