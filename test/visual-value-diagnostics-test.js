const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { evaluateVisualPosts, emptyVisual } = require('../lib/visual-value');
const { failureDiagnostic, printFailureDiagnostics } = require('../lib/visual-value-diagnostics');
const { createOpenAiRequestFn } = require('../vision_ai');
const { emptyUsage } = require('../lib/api-usage');
const post = { url: 'https://x.com/a/status/1', text: 'private text', vision: {status:'ok',observations:'A diagram'}, media: [{type:'image'}] };
function sdkError(fields) { return Object.assign(new Error('provider details withheld'),fields); }
async function main() {
  const cases = [
    [sdkError({code:'missing_api_key'}),'missing_api_key','before_request'],
    [sdkError({status:401,code:'invalid_api_key'}),'auth_error','during_request'],
    [sdkError({status:403}),'auth_error','during_request'],
    [sdkError({status:429,code:'rate_limit_exceeded'}),'rate_limit','during_request'],
    [sdkError({name:'APIConnectionError',cause:{code:'ENOTFOUND'}}),'request_error','during_request'],
    [sdkError({status:404,code:'model_not_found'}),'model_error','during_request'],
    [sdkError({name:'APIConnectionTimeoutError'}),'timeout','during_request'],
    [sdkError({status:400,code:'invalid_json_schema'}),'schema_validation_error','during_request'],
    [new Error('unclassified'),'unknown_error','during_request'],
    [null,'unknown_error','during_request'],
  ];
  for (const [error,category,phase] of cases) {
    const cache = {};
    const result = await evaluateVisualPosts([post],{cache,requestFn:async()=>{throw error;}});
    assert.equal(result.diagnostics[0].category,category);
    assert.equal(result.diagnostics[0].phase,phase);
    assert.deepStrictEqual(result.posts,[{...post,visual:emptyVisual()}]);
    assert.deepStrictEqual(cache,{});
    assert.equal(result.diagnostics[0].itemIndex,0);
    assert.equal(result.diagnostics[0].model,'gpt-5-mini');
    assert.equal(result.diagnostics[0].promptVersion,'1');
    assert.equal(result.diagnostics[0].schemaVersion,'1');
  }
  for (const response of [{output_text:'NOT JSON secret-body',_request_id:'req_test123'},{output:[],_request_id:'req_empty'}]) {
    const adapter = createOpenAiRequestFn({responses:{create:async()=>response}},{usage:emptyUsage()});
    const result = await evaluateVisualPosts([post],{requestFn:adapter});
    assert.equal(result.diagnostics[0].category,'invalid_response');
    assert.equal(result.diagnostics[0].phase,'after_response');
    assert.equal(result.diagnostics[0].requestId,response._request_id);
    assert(!JSON.stringify(result.diagnostics).includes('secret-body'));
  }
  const invalid = await evaluateVisualPosts([post],{requestFn:async()=>({value:6,roles:[]})});
  assert.equal(invalid.diagnostics[0].category,'schema_validation_error');
  assert.equal(invalid.diagnostics[0].phase,'schema_validation');
  const cache = {};
  let calls = 0;
  const options = {cache,requestFn:async()=>{calls++;return {value:3,roles:['diagram']};}};
  const success = await evaluateVisualPosts([post],options);
  const hit = await evaluateVisualPosts([post],options);
  assert.equal(calls,1);
  assert.equal(hit.summary.cacheHits,1);
  assert.deepStrictEqual(hit.posts,success.posts);
  assert.deepStrictEqual(success.diagnostics,[]);
  assert(!JSON.stringify(cache).includes('diagnostics'));
  const secret = 'sk-test-DO-NOT-LEAK';
  const poisoned = sdkError({status:401,code:secret,type:'Authorization: Bearer '+secret,request_id:'req_'+secret,
    message:`Authorization: Bearer ${secret}\nhttps://media.example/image?token=private-query\n{"input":"private-payload"}`,stack:'private-stack'});
  const diagnostic = failureDiagnostic(poisoned,{model:secret,promptVersion:secret,schemaVersion:secret});
  const logs = [];
  printFailureDiagnostics([diagnostic],line=>logs.push(line));
  for(const forbidden of [secret,'private-query','private-payload','private-stack','Authorization','media.example']) assert(!logs.join('').includes(forbidden));
  assert.equal(diagnostic.httpStatus,401);
  assert.equal(diagnostic.apiCode,null);
  assert(diagnostic.message.length<=200);
  const known = failureDiagnostic(sdkError({status:400,code:'invalid_json_schema',type:'invalid_request_error',request_id:'req_123'}));
  assert.equal(known.apiCode,'invalid_json_schema');
  assert.equal(known.apiType,'invalid_request_error');
  assert.equal(known.requestId,'req_123');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'visual-diagnostics-'));
  try {
    const input=path.join(root,'input.json'),output=path.join(root,'output.json'),cacheFile=path.join(root,'cache.json');
    fs.writeFileSync(input,JSON.stringify({posts:[post]}));
    // Explicit empty key prevents dotenv from loading a real key; no HTTP can occur.
    const cli=spawnSync(process.execPath,[path.resolve(__dirname,'../visual_value_ai.js'),'--apply','--input',input,'--output',output,'--cache',cacheFile],{
      encoding:'utf8',env:{...process.env,OPENAI_API_KEY:''},
    });
    assert.equal(cli.status,0,cli.stderr);
    assert(cli.stdout.includes('missing_api_key'));
    assert(cli.stdout.includes('before_request'));
    assert(cli.stdout.includes('VISUAL_VALUE_DEGRADED'));
    assert(!cli.stdout.includes('private text'));
    const artifact=JSON.parse(fs.readFileSync(output));
    assert.deepStrictEqual(artifact.posts,[{...post,visual:emptyVisual()}]);
    assert(!JSON.stringify(artifact).includes('diagnostics'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cacheFile)),{});
  } finally {fs.rmSync(root,{recursive:true,force:true});}
  console.log('visual-value-diagnostics-test: ALL PASS (no real API)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
