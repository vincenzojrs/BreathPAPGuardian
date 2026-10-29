// SPDX-License-Identifier: GPL-3.0-or-later
const {test}=require('node:test'),assert=require('node:assert/strict'),{File}=require('node:buffer');
const Polar=require('../web/polar.js'),Core=require('../web/core.js');
const base=BigInt(Date.parse('2024-01-02T12:00:00Z'))*1000000n, ns=s=>String(base+BigInt(s));
const file=(name,text)=>new File([text],name,{type:'text/plain'});
function fixture(){return [
 file('session.json',JSON.stringify({schema_version:1,time_zone:'Europe/Rome',start_unix_ns:ns(0),end_unix_ns:ns(600000000000),device_id:'synthetic'})),
 file('000_ecg.csv',`timestamp_unix_ns,ecg_uv,connection_segment\n${ns(0)},100,1\n${ns(7692308)},-50,1\n${ns(1000000000)},10,2\n`),
 file('000_hr.csv',`timestamp_unix_ns,hr_bpm\n${ns(0)},70\n${ns(1000000000)},71\n`),
 file('000_rr.csv',`timestamp_unix_ns,rr_ms,screen_accepted\n${ns(100000000)},860,true\n${ns(950000000)},850,false\n`),
 file('000_hrv.csv',`window_start_unix_ns,window_end_unix_ns,rmssd_candidate_ms,usable_heuristic\n${ns(0)},${ns(300000000000)},32,true\n${ns(300000000000)},${ns(600000000000)},,false\n`)
]}
test('imports all four signals with irregular R–R and window-valued HRV',async()=>{
 const a=await Polar.prepare(fixture(),null),channels=await Polar.channels({...a,zone:a.info.zone});
 assert.deepEqual(Object.keys(channels),['ecg','hr','rr','hrv']);
 assert.equal(channels.ecg.segments.length,2);
 assert.equal(channels.ecg.segments[0].values.length,2);
 assert.equal(channels.rr.segments[0].times[1]-channels.rr.segments[0].times[0],850);
 assert.equal(channels.rr.segments[0].quality[1],0);
 const t=Date.UTC(2024,0,2,13);assert.equal(Core.sample(channels.hrv,t+150000).v,32);
 assert.equal(Core.sample(channels.hrv,t+300000).quality,0);
 assert.equal(channels.hrv.segments[0].ends[0]-channels.hrv.segments[0].times[0],300000);
});
test('rejects incomplete or ambiguous inputs before persistence',async()=>{
 await assert.rejects(()=>Polar.prepare(fixture().slice(0,4),null),/Missing hrv/);
 await assert.rejects(()=>Polar.prepare([...fixture(),fixture()[0]],null),/Duplicate/);
 const broken=fixture();broken[1]=file('000_ecg.csv',`timestamp_unix_ns,ecg_uv\n${ns(1000000000)},0\n${ns(0)},0\n`);
 const record=await Polar.prepare(broken,null);await assert.rejects(()=>Polar.channels({...record,zone:record.info.zone}),/not monotonic/);
});
test('large Polar source blobs survive portable chunk encoding and restoration',async()=>{
 const vm=require('node:vm'),fs=require('node:fs'),source=fs.readFileSync(require.resolve('../web/app.js'),'utf8'),stored=new Map();let next=0;
 const ctx={Blob,Int8Array,Float64Array,Uint8Array,Number,Array,Object,Promise,NaN,
  api:async(path,blob)=>{assert.equal(path,'blob');const key='blob'+(++next);stored.set(key,blob);return {key};},
  fetch:async url=>{const key=url.split('/').at(-1);return {ok:stored.has(key),blob:async()=>stored.get(key)}}};vm.createContext(ctx);
 for(const name of ['portableEncode','portableDecode']){const start=source.indexOf('async function '+name+'('),end=source.indexOf('\n',start);vm.runInContext(source.slice(start,end),ctx);}
 const input=new Blob([new Uint8Array(32*1024*1024).fill(4),new Uint8Array([1,2,3])],{type:'text/csv'});
 const encoded=await ctx.portableEncode(input);assert.equal(encoded.__blobChunks.length,2);const out=await ctx.portableDecode(encoded);
 assert.equal(out.size,input.size);assert.equal(out.type,input.type);assert.deepEqual([...new Uint8Array(await out.slice(-3).arrayBuffer())],[1,2,3]);
});
for(const portable of [false,true])test(`Polar import saves once to ${portable?'portable':'IndexedDB'} and skips reimport`,async()=>{
 const vm=require('node:vm'),fs=require('node:fs'),source=fs.readFileSync(require.resolve('../web/app.js'),'utf8');
 const start=source.indexOf('async function ingestPolar('),end=source.indexOf("\n$('polarFiles').onchange",start),recorded=new Map(),elements={polarStatus:{},polarFiles:{},polarFolder:{},polarZone:{value:'Europe/Rome'}};
 const night={key:'2024-01-02',intervals:[[Date.UTC(2024,0,2,13),Date.UTC(2024,0,2,13,10)]]},operations=[];
 const ctx={PolarImport:Polar,PolarCSV:require('../web/polar-csv.js'),PAPImport:{zipEntries:null},Blob,BigInt,JSON,Number,Date,Error,console,
  $:id=>elements[id],night,nights:[night],external:[],busy:false,portable,confirm:()=>true,clock:t=>new Date(t).toISOString().slice(11,19),fmt:n=>Number(n.toFixed(2)).toString(),
  Portable:{assertWrite(){},hash:async v=>require('node:crypto').createHash('sha256').update(v).digest('hex'),begin:async()=>operations.push('begin'),finish:async()=>operations.push('finish'),pause:async()=>operations.push('pause'),render(){}},
  portableEncode:async x=>x,api:async(path,changes)=>{assert.equal(path,'batch');for(const [,value] of changes.put)recorded.set(value.id,value)},put:async(store,value)=>{assert.equal(store,'external');recorded.set(value.id,value)},refresh:async()=>{ctx.external=[...recorded.values()]}};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);await ctx.ingestPolar(fixture());assert.equal(recorded.size,1,elements.polarStatus.textContent);assert.equal([...recorded.values()][0].blobs['000_ecg.csv'].size>0,true);
 await ctx.ingestPolar(fixture());assert.equal(recorded.size,1);assert.match(elements.polarStatus.textContent,/already imported/);if(portable)assert.deepEqual(operations,['begin','finish']);
});
