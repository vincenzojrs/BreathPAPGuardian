// SPDX-License-Identifier: GPL-3.0-or-later
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const Philips=require('../web/philips.js'),PAPImport=require('../web/import-files.js'),ImportDelta=require('../web/import-delta.js');
const {chunk,summary,eventFile,props}=require('./philips-fixtures.js');
const source=fs.readFileSync(require.resolve('../web/app.js'),'utf8');
const ingestSource=source.slice(source.indexOf('async function ingest('),source.indexOf('\nasync function walk'));
const fixture=()=>[['PROP.TXT',Buffer.from(props)],['0000002A.001',summary({on:0,use:120})],['0000002A.002',eventFile()],['0000002A.005',chunk(5,[],{samples:[-35,0,35,0,-35]})]].map(([name,bytes])=>({name,_path:'SD/P-SERIES/SYNTHETIC/'+(name==='PROP.TXT'?'':'P0/')+name,text:async()=>bytes.toString(),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}));
for(const portable of [false,true])test(`shared Philips import and duplicate handling with ${portable?'portable':'IndexedDB'} storage`,async()=>{
 const records=new Map(),operations=[],messages=[];
 const ctx={busy:false,db:{},portable,files:[],nights:[],Philips,PAPImport,ImportDelta,Blob,crypto:require('node:crypto').webcrypto,
 Portable:{begin:async()=>operations.push('begin'),finish:async()=>operations.push('finish'),pause:async()=>operations.push('pause'),render(){}},
 getAll:async()=>[...records.values()],portableEncode:async v=>v,
 api:async(_,body)=>{for(const [,id] of body.delete||[])records.delete(id);for(const [,v] of body.put||[])records.set(v.id,v);},
 transaction:async(_,mode,fn)=>{assert.equal(mode,'readwrite');fn({put:v=>records.set(v.id,v),delete:id=>records.delete(id)});},
 refresh:async()=>{ctx.files=[...records.values()];},showHome(){},status:m=>messages.push(m),$:()=>({value:''})};
 const ingest=vm.runInNewContext('('+ingestSource+')',ctx);
 await ingest(fixture());assert.equal(records.size,4,messages.join("\n"));assert.equal([...records.values()].find(x=>x.name.endsWith('.005')).parsed.signals[0].values.constructor.name,'Int8Array');
 await ingest(fixture());assert.equal(records.size,4,messages.join("\n"));assert.match(messages.at(-1),/4 unchanged/);
 const changed=fixture();changed[1]={...changed[1],arrayBuffer:async()=>{const b=summary({on:0,use:180});return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}};
 await ingest(changed);assert.equal(records.size,4,messages.join("\n"));assert.match(messages.at(-1),/1 updated/);
 if(portable)assert.deepEqual(operations,['begin','finish','begin','finish','begin','finish']);
});
test('portable samples retain signed values across JSON storage and backup',async()=>{
 const ctx={Blob,Int8Array,Float64Array,Uint8Array,atob,btoa};vm.createContext(ctx);
 for(const name of ['portableEncode','portableDecode']){const start=source.indexOf('async function '+name+'('),end=source.indexOf('\n',start);vm.runInContext(source.slice(start,end),ctx);}
 const original=Int8Array.from([-128,-35,0,35,127]);const encoded=await ctx.portableEncode(original),decoded=await ctx.portableDecode(JSON.parse(JSON.stringify(encoded)));
 assert(decoded instanceof Int8Array);assert.deepEqual([...decoded],[...original]);
});
