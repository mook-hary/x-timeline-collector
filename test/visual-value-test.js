const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const v = require('../lib/visual-value');
const a = require('../analyze_ai');
const e = require('../enrich_ai');
const { scoreEditorialPost, rankEditorialPosts } = require('../lib/editorial-score');
const { runMorning, parseMorningArgs, buildMorningPlan } = require('../scripts/morning');
const { buildMorningHealthReport, formatMorningPipelineSummary } = require('../lib/morning-health');
const post = () => ({ url: 'https://x.com/a/status/1', text: 'secret post text', engagement: { likes: 999 }, importance: 2, informationValue: 2, editorialScore: 10,
  media: [{ type: 'video', previewUrl: 'https://example.com/a?size=small' }, { type: 'image' }],
  vision: { status: 'ok', observations: 'A chart', visibleText: 'A B', uncertainties: 'Labels cropped', analyzedAt: 'today' } });
async function main() {
  for (const status of [undefined, 'skipped', 'failed']) {
    const p = post(); p.vision = status ? { status } : undefined;
    const result = await v.evaluateVisualPosts([p], { requestFn: () => { throw Error('must not call'); } });
    assert.deepStrictEqual(result.posts[0].visual, v.emptyVisual());
    assert.equal(result.summary.apiRequests, 0);
  }
  for (const value of [null, 1, 2, 3, 4, 5]) assert.equal(v.normalizeVisual({ value, roles: [] }).value, value);
  for (const value of [undefined, 0, 6, 2.5, '3', NaN]) assert.throws(() => v.normalizeVisual({ value, roles: [] }));
  assert.throws(() => v.normalizeVisual({ value: 3, roles: ['unknown'] }));
  assert.throws(() => v.normalizeVisual({ value: 3, roles: ['other', 'photo'] }));
  assert.deepStrictEqual(v.normalizeVisual({ value: 4, roles: ['reference', 'diagram', 'reference'] }).roles, ['reference', 'diagram']);
  let calls = 0;
  const cache = {};
  const p = post();
  const original = JSON.stringify(p);
  const options = { cache, requestFn: async request => {
    calls++;
    assert.deepStrictEqual(JSON.parse(request.input), v.buildEvidence(p));
    assert(request.input.includes('Labels cropped'));
    for (const forbidden of ['importance', 'informationValue', 'editorialScore', 'engagement', 'secret post text']) assert(!request.input.includes(forbidden));
    assert(request.instructions.includes('poster/frame only'));
    return { value: 5, roles: ['diagram', 'reference'] };
  }};
  const result = await v.evaluateVisualPosts([p, { ...p, url: 'second' }], options);
  assert.equal(calls, 1); assert.equal(result.summary.cacheHits, 1);
  await v.evaluateVisualPosts([p], options); assert.equal(calls, 1);
  assert.equal(JSON.stringify(p), original);
  assert.deepStrictEqual(result.posts.map(p => p.url), [p.url, 'second']);
  for (const field of ['importance', 'informationValue', 'editorialScore']) assert.equal(result.posts[0][field], p[field]);
  assert.equal(scoreEditorialPost(p), scoreEditorialPost(result.posts[0]));
  assert.deepStrictEqual(rankEditorialPosts([p, {...p, url:'second'}]).map(x => x.post.url), rankEditorialPosts(result.posts).map(x => x.post.url));
  for (const mod of [a,e]) {
    const payload = mod.buildAiPayload || mod.buildEnrichPayload;
    assert.deepStrictEqual(payload(p), payload(result.posts[0]));
    assert.equal(mod.computeInputFingerprint(p), mod.computeInputFingerprint(result.posts[0]));
  }
  const analyzed = a.buildOutputPosts(result.posts, {}, 'test');
  const enriched = e.buildOutputPosts(analyzed, {}, 'test');
  assert.deepStrictEqual(enriched.map(p => p.visual), result.posts.map(p => p.visual));
  assert.deepStrictEqual(a.buildOutputPosts([{}], {}, 'test')[0].visual, v.emptyVisual());
  assert.deepStrictEqual(e.buildOutputPosts([{}], {}, 'test')[0].visual, v.emptyVisual());
  for (const field of ['observations', 'visibleText', 'uncertainties']) {
    assert.notEqual(v.computeInputFingerprint(p), v.computeInputFingerprint({ ...p, vision: { ...p.vision, [field]: 'changed' } }));
  }
  assert.equal(v.computeInputFingerprint(p), v.computeInputFingerprint({ ...p, vision: { ...p.vision, analyzedAt: 'tomorrow', useCount: 90 }, media: [{type:'video',previewUrl:'different'}, {type:'image'}] }));
  assert.notEqual(v.computeInputFingerprint(p), v.computeInputFingerprint({ ...p, media: [...p.media].reverse() }));
  const { buildCacheKey } = require('../lib/ai-contract');
  const contract = v.buildExecutionContract(p);
  for (const field of ['model', 'promptVersion', 'schemaVersion']) assert.notEqual(buildCacheKey(contract), buildCacheKey({...contract, [field]:'changed'}));
  for (const requestFn of [async () => { throw Error('offline'); }, async () => ({value:6,roles:[]})]) {
    const cache = {};
    const failed = await v.evaluateVisualPosts([p], { cache, requestFn });
    assert.equal(failed.summary.failed, 1); assert.deepStrictEqual(cache, {});
    assert.deepStrictEqual(failed.posts[0], {...p, visual:v.emptyVisual()});
  }
  assert.deepStrictEqual(require('../lib/news-feed').toNewsFeedItem(p), require('../lib/news-feed').toNewsFeedItem(result.posts[0]));
  const { createOpenAiRequestFn } = require('../vision_ai');
  let adapterCalls = 0;
  const request = createOpenAiRequestFn({responses:{create:async body => {
    adapterCalls++;
    assert.equal(body.text.format.strict,true);
    assert.deepStrictEqual(body.text.format.schema,v.RESPONSE_SCHEMA);
    return {output_text:JSON.stringify({value:3,roles:['diagram']})};
  }}}, {usage:require('../lib/api-usage').emptyUsage()});
  await v.evaluateVisualPosts([p], {requestFn:request});
  assert.equal(adapterCalls,1);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-morning-'));
  try {
    const input = path.join(root, 'input.json');
    const output = path.join(root, 'output.json');
    fs.writeFileSync(input, JSON.stringify([p]));
    const cli = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '../visual_value_ai.js'), '--no-api', '--input', input, '--output', output, '--cache', path.join(root,'cache.json')], {encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr);
    assert(!fs.existsSync(output));
    assert(!fs.existsSync(path.join(root,'cache.json')));
    for (const failure of ['exit', 'throw', 'partial', 'vision-and-visual']) {
      const calls = [];
      const result = runMorning(parseMorningArgs(['--skip-collect']), { rootDir:root, log:()=>{}, spawn: (_cmd,args) => {
        calls.push(args);
        if (args[0].endsWith('visual_value_ai.js')) {
          if (failure === 'throw') throw Error('spawn unavailable');
          return {status: failure === 'partial' ? 0 : 2, stdout:'VISUAL_VALUE_DEGRADED failed=1'};
        }
        if (failure === 'vision-and-visual' && args[0].endsWith('vision_ai.js')) return {status:1};
        return {status:0, stdout:''};
      }});
      assert.equal(result.ok,true);
      const stage = result.stages.find(s => s.id === 'visual-value');
      assert.equal(stage.degraded,true); assert.equal(stage.ok, failure === 'partial');
      const ai = calls.find(args => args[0].endsWith('analyze_ai.js'));
      assert(ai.includes(failure === 'partial' ? 'output/daily-visual.json' : failure === 'vision-and-visual' ? 'output/daily-analyzed.json' : 'output/daily-vision.json'));
      const report = buildMorningHealthReport({status:'SUCCESS', stages:result.stages});
      assert(report.warnings.includes('VISUAL_VALUE_DEGRADED'));
      assert(formatMorningPipelineSummary(report).includes('[degraded]'));
    }
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
  const ids = buildMorningPlan(parseMorningArgs([])).steps.map(s=>s.id);
  assert.deepStrictEqual(ids.slice(2,5), ['vision','visual-value','analyze-ai']);
  console.log('visual-value-test: ALL PASS (mock only)');
}
main().catch(error => { console.error(error); process.exitCode=1; });
