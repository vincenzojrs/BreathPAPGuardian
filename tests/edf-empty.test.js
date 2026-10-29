// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic fixtures; no patient data.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {readEDF}=require('../web/core.js'),ImportDelta=require('../web/import-delta.js');
function fixture(records=-1,payloadRecords=0,ns=3){
 const header=256+256*ns,stride=ns*25*2,bytes=new Uint8Array(header+payloadRecords*stride);bytes.fill(32,0,header);
 const field=(at,width,value)=>{const s=String(value).padEnd(width,' ');for(let i=0;i<width;i++)bytes[at+i]=s.charCodeAt(i);};
 field(0,8,0);field(168,8,'20.10.26');field(176,8,'02.07.05');field(184,8,header);field(236,8,records);field(244,8,'60.00');field(252,4,ns);
 let offset=256;
 for(const [width,value]of [[16,'Flow.40ms'],[80,''],[8,'L/s'],[8,-1],[8,1],[8,-32768],[8,32767],[80,''],[8,25],[32,'']]){
  for(let i=0;i<ns;i++)field(offset+i*width,width,value);
  offset+=ns*width;
 }
 return bytes.buffer;
}
test('reported 1024-byte EDF with -1 records is explicitly classified as no samples',()=>{
 const buffer=fixture();assert.equal(buffer.byteLength,1024);
 assert.throws(()=>readEDF(buffer,'empty.edf'),e=>e.code==='EDF_NO_DATA');
});
test('zero-record header-only EDF is also skipped',()=>assert.throws(()=>readEDF(fixture(0),'empty.edf'),e=>e.code==='EDF_NO_DATA'));
test('finalized EDF containing samples remains importable',()=>{
 const p=readEDF(fixture(1,1),'complete.edf');assert.equal(p.records,1);assert.equal(p.signals.length,3);assert.equal(p.signals[0].values.length,25);
});
test('unknown count with actual samples is not silently discarded as empty',()=>assert.throws(()=>readEDF(fixture(-1,1),'unfinished.edf'),e=>e.code!=='EDF_NO_DATA'));
test('truncated declared recording is still an error',()=>assert.throws(()=>readEDF(fixture(1,0),'truncated.edf'),e=>e.code!=='EDF_NO_DATA'));
test('invalid header dimensions are still an error',()=>{
 const buffer=fixture();new Uint8Array(buffer)[252]=48;
 assert.throws(()=>readEDF(buffer,'invalid.edf'),e=>e.code!=='EDF_NO_DATA');
});
async function importFixture(buffers){
 const batches=[],messages=[],operations=[];
 const source=fs.readFileSync(require.resolve('../web/app.js'),'utf8');
 const start=source.indexOf('async function ingest('),end=source.indexOf('\nasync function walk',start);
 assert(start>=0&&end>start);
 const context={
  busy:false,db:{},portable:true,files:[],nights:[],ImportDelta,readEDF,Philips:require('../web/philips.js'),PAPImport:require('../web/import-files.js'),
  Portable:{begin:async()=>operations.push('begin'),finish:async()=>operations.push('finish'),pause:async()=>operations.push('pause'),render(){}},
  getAll:async()=>[],api:async(path,body)=>{assert.equal(path,'batch');batches.push(body);},
  portableEncode:async x=>x,put:async()=>{throw Error('Unexpected browser write');},
  crypto:{subtle:{digest:async()=>new Uint8Array([1,2,3]).buffer}},
  Blob:class {constructor(parts,options){this.parts=parts;this.type=options.type;}},
  status:x=>messages.push(x),refresh:async()=>{},showHome(){},$:()=>({value:''})
 };
 const ingest=vm.runInNewContext('('+source.slice(start,end)+')',context);
 await ingest(buffers.map((buffer,i)=>({name:'synthetic-'+i+'.edf',type:'application/octet-stream',arrayBuffer:async()=>buffer})));
 return {batches,messages,operations};
}
test('three empty files do not pause a mixed valid SD import or persist empty EDFs',async()=>{
 const result=await importFixture([fixture(),fixture(0),fixture(),fixture(1,1)]);
 assert.deepEqual(result.operations,['begin','finish']);assert.equal(result.batches.length,1);
 assert.equal(result.batches[0].put[0][1].parsed.records,1);
 assert(result.messages.some(x=>x.includes('3 empty EDF skipped')));
});
test('a real malformed recording continues to preserve the import in paused state',async()=>{
 const result=await importFixture([fixture(1,1),fixture(1,0)]);
 assert.deepEqual(result.operations,['begin','pause']);assert(result.messages.some(x=>x.includes('Import paused')));
});
