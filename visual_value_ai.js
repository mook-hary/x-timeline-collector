const { withArtifactProvenance } = require("./lib/collection-provenance");
require('dotenv').config({ quiet: true });
const path = require('path');
const OpenAI = require('openai');
const { readJsonObjectOptional, writeJsonAtomic } = require('./lib/pipeline-io');
const { parseArgs, createOpenAiRequestFn } = require('./vision_ai');
const { failureDiagnostic, printFailureDiagnostics } = require('./lib/visual-value-diagnostics');
const { emptyUsage, printUsageSummary } = require('./lib/api-usage');
const { evaluateVisualPosts, DEFAULT_MODEL } = require('./lib/visual-value');

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Visual Value: --apply | --dry-run | --no-api | --cache-stats\n--input PATH --output PATH --cache PATH\nDefaults: output/daily-vision.json, output/daily-visual.json, output/visual_value_cache.json\nDefault mode: dry-run (no writes/API). OPENAI_MODEL defaults to gpt-5-mini.');
    return;
  }
  const resolve = (name, fallback) => args[name] ? path.resolve(args[name]) : path.join(__dirname, 'output', fallback);
  const cacheFile = resolve('cache', 'visual_value_cache.json');
  const cache = readJsonObjectOptional(cacheFile, {});
  if (args.cacheStats) { console.log(`Visual Value cache entries: ${Object.keys(cache).length}`); return; }
  const dryRun = !args.apply || args.dryRun;
  return withArtifactProvenance({ inputPath: resolve('input', 'daily-vision.json'), outputPath: resolve('output', 'daily-visual.json'), shape: 'editorial', dryRun }, async (artifact) => {
    const input = artifact.data;
    const posts = Array.isArray(input) ? input : input.posts;
    if (!Array.isArray(posts)) throw new Error('Expected posts array');
    const usageHolder = { usage: emptyUsage() };
    let requestImpl;
    const result = await evaluateVisualPosts(posts, {
      cache, dryRun, model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      requestFn: async request => {
        if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('API key is not configured'), { code: 'missing_api_key' });
        if (!requestImpl) requestImpl = createOpenAiRequestFn(new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 }), usageHolder);
        return requestImpl(request);
      },
    });
    if (!dryRun) {
      artifact.writeJson(Array.isArray(input) ? result.posts : { ...input, posts: result.posts, itemCount: result.posts.length, visualValueStage: result.summary });
      writeJsonAtomic(cacheFile, result.cache);
    }
    console.log(`全投稿数: ${posts.length}`);
    console.log(JSON.stringify(result.summary));
    if (result.summary.failed) console.log(`VISUAL_VALUE_DEGRADED failed=${result.summary.failed}`);
    printFailureDiagnostics(result.diagnostics);
    printUsageSummary('Visual Value', usageHolder.usage);
  });
}
if (require.main === module) main().catch(error => { console.error('[visual-value:failure] ' + JSON.stringify(failureDiagnostic(error, { phase: 'before_request' }))); process.exitCode = 1; });
module.exports = { main };
