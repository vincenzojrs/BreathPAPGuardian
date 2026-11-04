const {test}=require('node:test'),assert=require('node:assert/strict'),{webcrypto,createHash}=require('node:crypto'),Window=require('../web/polar-window.js');
const hash=x=>createHash('sha256').update(x).digest('hex');
const a='a'.repeat(64),b='b'.repeat(64);
const index={format:'bpg-ecg-index-experiment-v1',source_bytes:12,header:'time,value\n',parts:[{key:a,offset:0,size:5},{key:b,offset:5,size:7}],blocks:[{offset:1,end_offset:4,start_ns:'1000000',end_ns:'2000000',sha256:hash('bcd')},{offset:4,end_offset:9,start_ns:'9000000',end_ns:'10000000',sha256:hash('efghi')},{offset:9,end_offset:12,start_ns:'20000000',end_ns:'21000000',sha256:hash('jkl')}]};
const wall=s=>Number(BigInt(s))/1e6;
test('selects only overlapping rows and splits them at blob boundaries',()=>{
 assert.deepEqual(Window.plan(index,9,10,wall),[{key:a,start:4,end:5},{key:b,start:0,end:4}]);
 assert.deepEqual(Window.plan(index,3,8,wall),[]);
 assert.deepEqual(Window.plan(index,2,9,wall),[{key:a,start:1,end:4},{key:a,start:4,end:5},{key:b,start:0,end:4}]);
});
test('loads only planned ranges and preserves exact order',async()=>{
 const files={[a]:Buffer.from('abcde'),[b]:Buffer.from('fghijkl')},requests=[];
 const fetcher=async(url,options)=>{const key=url.split('/').pop(),r=options.headers.Range,match=/bytes=(\d+)-(\d+)/.exec(r),start=Number(match[1]),end=Number(match[2]);requests.push([key,start,end]);const bytes=files[key].subarray(start,end+1);return {status:206,headers:{get:()=>`bytes ${start}-${end}/${files[key].length}`},arrayBuffer:async()=>Uint8Array.from(bytes).buffer};};
 assert.equal(await (await Window.load(index,9,10,wall,fetcher,undefined,webcrypto.subtle)).text(),'time,value\nefghi');assert.deepEqual(requests,[[a,4,4],[b,0,3]]);
});
test('rejects malformed indices, incorrect server responses and clock discontinuity',async()=>{
 assert.throws(()=>Window.plan({...index,source_bytes:13},0,10,wall),/size mismatch/);
 assert.throws(()=>Window.plan(index,0,30,s=>Number(BigInt(s))/1e6+(s==='10000000'?3600000:0)),/clock change/);
 await assert.rejects(()=>Window.load(index,9,10,wall,async()=>({status:200}),undefined,webcrypto.subtle),/range unavailable/);
});
test('rejects a byte range whose payload differs from the verified index',async()=>{
 const fetcher=async(url,options)=>{const m=/bytes=(\d+)-(\d+)/.exec(options.headers.Range),start=+m[1],end=+m[2];return {status:206,headers:{get:()=>`bytes ${start}-${end}/99`},arrayBuffer:async()=>new Uint8Array(end-start+1).buffer};};
 await assert.rejects(()=>Window.load(index,9,10,wall,fetcher,undefined,webcrypto.subtle),/integrity check/);
});
test('compressed source chunks restore exact selected rows and verify hashes',async()=>{
 const {deflateSync}=require('node:zlib'),rawA=Buffer.from('abcde'),rawB=Buffer.from('fghijkl'),ca=deflateSync(rawA),cb=deflateSync(rawB);
 const compressed={...index,parts:[{key:a,offset:0,size:5,codec:'deflate',sha256:hash(rawA),stored_size:ca.length},{key:b,offset:5,size:7,codec:'deflate',sha256:hash(rawB),stored_size:cb.length}]};
 const requests=[],fetcher=async(url,options)=>{const key=url.split('/').pop();requests.push([key,options.headers.Range]);const bytes=key===a?ca:cb;return {status:200,arrayBuffer:async()=>Uint8Array.from(bytes).buffer};};
 assert.equal(await (await Window.load(compressed,9,10,wall,fetcher,undefined,webcrypto.subtle)).text(),'time,value\nefghi');
 assert.deepEqual(requests,[[a,undefined],[b,undefined]]);
 const bad={...compressed,parts:[{...compressed.parts[0],sha256:'0'.repeat(64)},compressed.parts[1]]};
 await assert.rejects(()=>Window.load(bad,9,10,wall,fetcher,undefined,webcrypto.subtle),/integrity/);
});
