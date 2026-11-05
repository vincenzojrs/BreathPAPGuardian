// SPDX-License-Identifier: GPL-3.0-or-later
// Plan and verify source-blob byte ranges for a PAP-clock ECG window.
(function(root){
'use strict';
function planBlocks(index,start,end,wall){
 if(!index||index.format!=='bpg-ecg-index-experiment-v1'||!Number.isFinite(start)||!Number.isFinite(end)||end<start||typeof wall!=='function')throw Error('Invalid ECG window');
 let size=0;
 for(const part of index.parts){if(!/^[0-9a-f]{64}$/.test(part.key)||!Number.isSafeInteger(part.size)||part.size<0||part.offset!==size||(part.codec&& (part.codec!=='deflate'||!/^[0-9a-f]{64}$/.test(part.sha256)||!Number.isSafeInteger(part.stored_size))))throw Error('Invalid ECG parts');size+=part.size;}
 if(size!==index.source_bytes)throw Error('ECG index source size mismatch');
 const groups=[];let lastWall=-Infinity,lastEndOffset=0,lastNs=null;
 for(const block of index.blocks){
  if(!Number.isSafeInteger(block.offset)||!Number.isSafeInteger(block.end_offset)||block.offset<lastEndOffset||block.end_offset<=block.offset||block.end_offset>size||!/^[0-9a-f]{64}$/.test(block.sha256))throw Error('Invalid ECG block');
  const a=BigInt(block.start_ns),b=BigInt(block.end_ns),wa=wall(block.start_ns),wb=wall(block.end_ns);
  if(b<a||!Number.isFinite(wa)||!Number.isFinite(wb)||wa<lastWall||Math.abs((wb-wa)-Number(b-a)/1e6)>2||(lastNs!==null&&Math.abs((wa-lastWall)-Number(a-lastNs)/1e6)>2))throw Error('ECG clock change or invalid index');
  lastWall=wb;lastNs=b;lastEndOffset=block.end_offset;
  if(wa>end||wb<start)continue;
  const ranges=[];for(const part of index.parts){const x=Math.max(block.offset,part.offset),y=Math.min(block.end_offset,part.offset+part.size);if(x<y)ranges.push({key:part.key,start:x-part.offset,end:y-part.offset,...part.codec?{codec:part.codec,sha256:part.sha256,size:part.size,stored_size:part.stored_size}:{}});}
  groups.push({sha256:block.sha256,ranges});
 }
 return groups;
}
function plan(index,start,end,wall){return planBlocks(index,start,end,wall).flatMap(b=>b.ranges);}
async function load(index,start,end,wall,fetcher,signal,subtle=globalThis.crypto.subtle){
 const blocks=planBlocks(index,start,end,wall),pieces=[index.header];
 for(const block of blocks){
  const chunks=[];
  for(const range of block.ranges){
   const headers={'X-BPG-Local':'1'};if(!range.codec)headers.Range=`bytes=${range.start}-${range.end-1}`;
   const response=await fetcher('/api/blob/'+range.key,{headers,signal});
   if(range.codec?response.status!==200:response.status!==206)throw Error('ECG byte range unavailable');
   let bytes=await response.arrayBuffer();
   if(range.codec==='deflate'){
    if(response.status!==200||bytes.byteLength!==range.stored_size)throw Error('Compressed ECG blob unavailable');
    bytes=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
    const digest=await subtle.digest('SHA-256',bytes),hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    if(bytes.byteLength!==range.size||hash!==range.sha256)throw Error('Compressed ECG blob failed integrity check');
    bytes=bytes.slice(range.start,range.end);
   }else{
    if(response.status!==206)throw Error('ECG byte range unavailable');
    const expected=`bytes ${range.start}-${range.end-1}/`,actual=response.headers.get('Content-Range');
    if(!actual||!actual.startsWith(expected))throw Error('Unexpected ECG byte range');
   }
   if(bytes.byteLength!==range.end-range.start)throw Error('Incomplete ECG byte range');chunks.push(bytes);
  }
  const bytes=await new Blob(chunks).arrayBuffer(),digest=await subtle.digest('SHA-256',bytes),hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  if(hash!==block.sha256)throw Error('ECG block failed integrity check');pieces.push(bytes);
 }
 return new Blob(pieces,{type:'text/csv'});
}
const api={plan,load};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PolarWindow=api;
})(globalThis);
