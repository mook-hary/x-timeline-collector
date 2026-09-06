/** Public additive v1 contract; no model requests or production file writes. */
const assert = require('assert');
const {buildNewsFeed,toNewsFeedItem}=require('../lib/news-feed');
const {canonicalizeMediaList}=require('../lib/tweet-media');
const {buildOutputPosts:analyzeOutput}=require('../analyze_ai');
const {buildOutputPosts:enrichOutput}=require('../enrich_ai');
const {ROLES}=require('../lib/visual-value');
const options={generatedAt:'2026-09-06T00:00:00.000Z'};
const base={url:'https://x.com/test/status/1',text:'FULL_PRIVATE_X_TEXT',enrichment:{importance:3,informationValue:3,summary:'Public summary'},media:[
 {type:'image',url:'https://pbs.twimg.com/media/test.jpg?name=small&format=jpg'},
 {type:'image',url:'https://pbs.twimg.com/media/secret.jpg?token=SECRET_MEDIA_TOKEN'},
 {type:'image',url:'javascript:SECRET_SCRIPT'},
]};
const vision={status:'ok',observations:'A reference diagram.',visibleText:'Labels A and B',uncertainties:'PRIVATE_UNCERTAINTIES',model:'PRIVATE_MODEL',promptVersion:'PRIVATE_PROMPT',analyzedAt:'PRIVATE_DATE',mediaIdentities:['PRIVATE_IDENTITIES'],skipReason:'PRIVATE_SKIP',mediaCountAnalyzed:20,diagnostics:'PRIVATE_DIAGNOSTIC',cacheKey:'PRIVATE_CACHE',inputFingerprint:'PRIVATE_FINGERPRINT',requestId:'PRIVATE_REQUEST',error:'PRIVATE_ERROR'};
const visual={value:4,roles:['reference','diagram'],model:'PRIVATE_VISUAL_MODEL',diagnostics:'PRIVATE_VISUAL_DIAGNOSTIC'};
const post={...base,vision,visual};
const item=toNewsFeedItem(post);
assert.deepStrictEqual(item.vision,{status:'ok',observations:vision.observations,visibleText:vision.visibleText});
assert.deepStrictEqual(item.visual,{value:4,roles:['reference','diagram']});
assert.deepStrictEqual(Object.keys(item.vision).sort(),['observations','status','visibleText']);
assert.deepStrictEqual(Object.keys(item.visual).sort(),['roles','value']);
const raw=JSON.stringify(item);
assert(!raw.includes('PRIVATE_'));assert(!raw.includes('SECRET_'));
assert(!raw.includes('FULL_PRIVATE_X_TEXT'));
for(const status of ['skipped','failed',undefined]) {
 const p={...base,vision:status?{...vision,status}:undefined};
 assert(!('vision' in toNewsFeedItem(p)));
}
for(const invalid of [null,{},[],{status:'ok',observations:42},{status:'ok',observations:''}]) assert(!('vision' in toNewsFeedItem({...base,vision:invalid})));
assert.equal(toNewsFeedItem({...post,vision:{...vision,visibleText:null}}).vision.visibleText,null);
assert.equal(toNewsFeedItem({...post,vision:{...vision,visibleText:{secret:'PRIVATE'}}}).vision.visibleText,null);
for(const value of [null,1,2,3,4,5]) assert.equal(toNewsFeedItem({...base,visual:{value,roles:['photo']}}).visual.value,value);
for(const role of ROLES) assert.deepStrictEqual(toNewsFeedItem({...base,visual:{value:3,roles:[role]}}).visual.roles,[role]);
for(const invalid of [undefined,null,[],{}, {value:0,roles:['photo']},{value:6,roles:[]},{value:2.5,roles:[]},{value:'4',roles:[]},{value:NaN,roles:[]},{value:4,roles:['bad']},{value:4,roles:'photo'},{value:4,roles:['other','photo']}]) {
 assert.deepStrictEqual(toNewsFeedItem({...base,visual:invalid}).visual,{value:null,roles:[]});
}
assert.deepStrictEqual(toNewsFeedItem({...base,visual:{value:3,roles:['photo','reference','photo']}}).visual.roles,['reference','photo']);
assert.deepStrictEqual(item.media,canonicalizeMediaList(base.media));
const strip=({vision:_v,visual:_w,...old})=>old;
assert.deepStrictEqual(strip(item),strip(toNewsFeedItem(base)));
// Ranking, ties and duplicate IDs remain sort-only, unaffected by visual values.
const posts=[base,{...base,url:'https://x.com/test/status/2',enrichment:{importance:5,summary:'High'}},base,{}];
const extended=posts.map((p,i)=>({...p,vision,visual:{value:i===1?1:5,roles:['photo']}}));
const oldFeed=buildNewsFeed(posts,options),newFeed=buildNewsFeed(extended,options);
assert.equal(newFeed.schemaVersion,1);
assert.equal(newFeed.scope.itemCount,posts.length);assert.equal(newFeed.items.length,posts.length);
assert.deepStrictEqual(newFeed.items.map(strip),oldFeed.items.map(strip));
assert.deepStrictEqual(buildNewsFeed(extended,options),newFeed);
assert.equal(newFeed.items.filter(p=>p.id==='1').length,2);
// Existing output builders preserve both fields; the exporter projects only public fields.
const analyzed=analyzeOutput([post],{},'test');
const enriched=enrichOutput(analyzed,{},'test');
assert.deepStrictEqual(enriched[0].vision,vision);assert.deepStrictEqual(enriched[0].visual,visual);
const daily=JSON.parse(JSON.stringify({posts:enriched}));
const exported=buildNewsFeed(daily.posts,options).items[0];
assert.deepStrictEqual(exported.vision,item.vision);assert.deepStrictEqual(exported.visual,item.visual);
// No exporter network use: reject HTTP/fetch calls while exercising the conversion.
const http=require('http'),https=require('https');
const saved=[http.request,https.request,global.fetch];let calls=0;
const forbidden=()=>{calls++;throw Error('Exporter must not request network');};
try {http.request=forbidden;https.request=forbidden;global.fetch=forbidden;buildNewsFeed(extended,options);assert.equal(calls,0);}
finally {[http.request,https.request,global.fetch]=saved;}
console.log('news-feed-visual-test: ALL PASS');
