const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../web/app.js'),'utf8');
test('refresh retains Polar blob references without fetching CSV contents',async()=>{
 const calls=[],record={id:'polar:a',night:'2024-01-01',polar:true,blobs:{'ecg.csv':{__ref:'ecg'}}};
 const ctx={portable:true,night:null,files:[],annotations:[],external:[],tombstones:[],giCacheRecords:[],cache:new Map(),
 api:async path=>{calls.push(path);return path==='records/external'?[record]:[]},
 getMarkers:async()=>[],portableDecode:async v=>{assert.equal(v.blobs,undefined);return v},getAll:async()=>[],buildNights:()=>({nights:[]}),ImportDelta:{visible:n=>n},home:()=>{},seedTrendSummaries:()=>{},prepareTrendSummaries:()=>{}};
 vm.createContext(ctx);const start=source.indexOf('async function refresh()'),end=source.indexOf('\n',start);vm.runInContext(source.slice(start,end),ctx);
 await ctx.refresh();assert.equal(ctx.external[0].blobs['ecg.csv'].__ref,'ecg');assert.deepEqual(calls,['records/external','sleep-status']);
});
test('Polar derived cache is byte bounded and evicts least recently used sessions',()=>{
 const ctx={ArrayBuffer,Map,JSON};vm.createContext(ctx);
 const start=source.indexOf('const polarChannelCache='),end=source.indexOf('\nasync function loadPolarNight',start);
 vm.runInContext(source.slice(start,end)+'\nglobalThis.check={polarRemember,polarCached,polarChannelSize};',ctx);
 const make=n=>({ecg:{segments:[{values:new Uint8Array(n)}]}}),{polarRemember,polarCached,polarChannelSize}=ctx.check;
 assert.equal(polarChannelSize(make(10)),10);
 const a=make(70*1024*1024),b=make(70*1024*1024),c=make(70*1024*1024);
 polarRemember('a',a);polarRemember('b',b);assert.equal(polarCached('a'),a);polarRemember('c',c);
 assert.equal(polarCached('b'),undefined);assert.equal(polarCached('a'),a);assert.equal(polarCached('c'),c);
});
test('switching nights prevents a stale Polar load from reaching the selected charts',async()=>{
 let resolve,parsed=0;const pending=new Promise(r=>{resolve=r;});
 const ctx={Object,portable:true,polarLoadGeneration:1,night:{key:'A'},channels:{},selected:new Set(),
  polarCacheKey:()=>'',polarCached:()=>null,portableDecode:async()=>pending,
  PolarImport:{channels:async()=>{parsed++;return {}}},polarRemember:()=>{},renderChoices:()=>{},build:()=>{},renderPolarSummary:()=>{}};
 vm.createContext(ctx);const start=source.indexOf('async function loadPolarStreams('),end=source.indexOf('\nasync function ingestPolar(',start);vm.runInContext(source.slice(start,end),ctx);
 const running=ctx.loadPolarStreams([{blobs:{'000_hr.csv':{__ref:'hr'},'000_ecg.csv':{__ref:'ecg'}}}],['hr'],'A',1,{});
 ctx.polarLoadGeneration=2;ctx.night={key:'B'};resolve({});await running;
 assert.equal(parsed,0);assert.deepEqual(Object.keys(ctx.channels),[]);
});
test('nightly summary signatures change only when a relevant PAP source changes',()=>{
 const start=Date.parse('2026-01-01T12:00:00Z'),mk=(id,t)=>({id,imported:1,parsed:{signals:[{start:t,dt:1,values:[1,2]}]}}),
  ctx={Date,JSON,Object,String,Number,DAY:86400000,files:[mk('first',start+1000),mk('unrelated',start+86400000+1000)]};
 vm.createContext(ctx);const begin=source.indexOf('function trendSummarySignature('),end=source.indexOf('\nfunction seedTrendSummaries',begin);vm.runInContext(source.slice(begin,end),ctx);
 const night={key:'2026-01-01',usage:1,channels:{Flow:{unit:'L/s',segments:[{start:start+1000,dt:1,values:[1,2]}]}}};
 const initial=ctx.trendSummarySignature(night);ctx.files[1].id='changed-other-night';assert.equal(ctx.trendSummarySignature(night),initial);
 ctx.files[0].id='changed-this-night';assert.notEqual(ctx.trendSummarySignature(night),initial);
});
