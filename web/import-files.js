// SPDX-License-Identifier: GPL-3.0-or-later
// Local-only ZIP and device preflight. No network or third-party runtime.
(function(root){
'use strict';
const P=typeof module!=='undefined'&&module.exports?require('./philips.js'):root.Philips;
const DS2=typeof module!=='undefined'&&module.exports?require('./dreamstation2.js'):root.DreamStation2;
const pathOf=f=>(f.webkitRelativePath||f._path||f.name).replaceAll('\\','/');
const table=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function supported(name){return /\.(edf|tgt)$/i.test(name)||P.isProperties(name)||P.isData(name);}
async function zipEntries(file){
 // Read central directory only. Each compressed entry is inflated on demand.
 if(file.size>1024**3)throw Error('ZIP exceeds 1 GiB. Extract it and choose the SD folder.');
 const tail=new Uint8Array(await file.slice(Math.max(0,file.size-65557)).arrayBuffer()),view=new DataView(tail.buffer);
 let e=-1;for(let p=tail.length-22;p>=0;p--)if(view.getUint32(p,true)===0x06054b50&&p+22+view.getUint16(p+20,true)===tail.length){e=p;break;}
 if(e<0)throw Error('Invalid ZIP: end of directory not found');
 const count=view.getUint16(e+10,true),size=view.getUint32(e+12,true),offset=view.getUint32(e+16,true);
 if(view.getUint16(e+4,true)||view.getUint16(e+6,true)||view.getUint16(e+8,true)!==count||count===65535||offset===0xffffffff||size===0xffffffff)throw Error('ZIP64 and multi-volume ZIP are unsupported. Extract the SD folder first.');
 if(offset+size>file.size-tail.length+e||size>32*1024**2)throw Error('Invalid ZIP directory bounds');
 const b=new Uint8Array(await file.slice(offset,offset+size).arrayBuffer()),dv=new DataView(b.buffer),dec=new TextDecoder(),out=[];let p=0,total=0;
 for(let i=0;i<count;i++){
  if(p+46>b.length||dv.getUint32(p,true)!==0x02014b50)throw Error('Invalid ZIP directory entry');
  const flags=dv.getUint16(p+8,true),method=dv.getUint16(p+10,true),crc=dv.getUint32(p+16,true),compressed=dv.getUint32(p+20,true),length=dv.getUint32(p+24,true),n=dv.getUint16(p+28,true),extra=dv.getUint16(p+30,true),comment=dv.getUint16(p+32,true),local=dv.getUint32(p+42,true);
  if(p+46+n+extra+comment>b.length)throw Error('Truncated ZIP entry');
  const path=dec.decode(b.subarray(p+46,p+46+n)).replaceAll('\\','/');p+=46+n+extra+comment;
  if(path.startsWith('/')||/^[a-z]:/i.test(path)||path.split('/').includes('..')||path.includes('\0'))throw Error('Unsafe ZIP path');
  if(path.endsWith('/')||P.ignored(path))continue;
  if(!supported(path))continue;
  total+=length;if(total>2*1024**3||length>128*1024**2)throw Error('ZIP expansion limit exceeded');
  if(flags&1||![0,8].includes(method))throw Error('Encrypted ZIP or unsupported compression. Extract the SD folder first.');
  const entry={name:path.split('/').at(-1),_path:path,size:length,type:'application/octet-stream',async arrayBuffer(){
   if(local+30>offset)throw Error('Invalid ZIP local header');
   const h=new DataView(await file.slice(local,local+30).arrayBuffer());
   if(h.getUint32(0,true)!==0x04034b50||h.getUint16(8,true)!==method||(h.getUint16(6,true)&1))throw Error('Invalid ZIP local header');
   const begin=local+30+h.getUint16(26,true)+h.getUint16(28,true);
   if(begin+compressed>offset)throw Error('ZIP entry outside data area');
   const blob=file.slice(begin,begin+compressed);let bytes;
   if(method===0){if(compressed!==length)throw Error('Invalid stored ZIP size');bytes=new Uint8Array(await blob.arrayBuffer());}
   else{
    let stream;try{stream=blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));}catch{throw Error('This browser cannot inflate ZIP files. Extract the ZIP and choose the SD folder.');}
    const reader=stream.getReader(),parts=[];let got=0;
    try{while(true){const r=await reader.read();if(r.done)break;got+=r.value.length;if(got>length)throw Error('ZIP entry exceeds declared size');parts.push(r.value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}
    if(got!==length)throw Error('Truncated ZIP content');bytes=new Uint8Array(got);let pos=0;for(const part of parts){bytes.set(part,pos);pos+=part.length;}
   }
   if(crc32(bytes)!==crc)throw Error('ZIP CRC mismatch');return bytes.buffer;
  },async text(){return new TextDecoder().decode(await this.arrayBuffer());}};
  out.push(entry);
 }
 if(p!==b.length)throw Error('Unexpected ZIP directory data');out.ignoredCount=count-out.length;return out;
}
function validateArchive(records){
 const serials=new Set(records.map(f=>f.tags?.SRN||f.device?.serial).filter(Boolean));
 const philips=records.some(f=>f.device?.vendor==='Philips'||f.parsed?.vendor==='Philips');
 const resmed=records.some(f=>f.parsed&&!f.parsed.vendor||/\.(edf|tgt)$/i.test(f.name));
 if(serials.size>1||philips&&resmed)throw Error('This archive supports one PAP device. Use a separate browser profile for Philips and ResMed.');
}
async function prepare(input,stored=[]){
 const entries=[],decoder=DS2.createDecoder();let ignoredCount=0;
 for(const f of input){if(P.ignored(pathOf(f))){ignoredCount++;continue;}if(/\.zip$/i.test(f.name)){const zipped=await zipEntries(f);entries.push(...zipped);ignoredCount+=zipped.ignoredCount;}else entries.push(f);}
 const devices=new Map(),serials=new Set(stored.map(f=>f.tags?.SRN||f.device?.serial).filter(Boolean));
 let hasPhilips=stored.some(f=>f.device?.vendor==='Philips'||f.parsed?.vendor==='Philips'),hasEDF=stored.some(f=>f.parsed&&!f.parsed.vendor||/\.edf$/i.test(f.name));
 const selected=[];
 for(const f of entries){
  const path=pathOf(f);if(P.ignored(path)){ignoredCount++;continue;}
  if(!supported(f.name)){ignoredCount++;continue;}
  selected.push(f);
  if(P.isProperties(f.name)){const encrypted=/\.bin$/i.test(f.name),text=encrypted?new TextDecoder().decode(await decoder.decrypt(await f.arrayBuffer())):await f.text(),device=P.properties(text);device.generation=encrypted?2:1;if(encrypted)device.tags.PNA='Philips DreamStation 2 '+device.model;serials.add(device.serial);devices.set(path.slice(0,path.lastIndexOf('/')+1),device);hasPhilips=true;}
  if(P.isData(f.name))hasPhilips=true;
  if(/\.edf$/i.test(f.name))hasEDF=true;
  if(/\.tgt$/i.test(f.name)){hasEDF=true;const m=(await f.text()).match(/#SRN\s+(\S+)/);if(m)serials.add(m[1]);}
 }
 if(serials.size>1||hasPhilips&&hasEDF)throw Error('This archive supports one PAP device. Use a separate browser profile for Philips and ResMed; no files from this import were saved.');
 const plan=[];
 for(const f of selected){
  let device=null;
  if(P.isProperties(f.name)||P.isData(f.name)){
   const path=pathOf(f),matches=[...devices].filter(([dir])=>dir?path.startsWith(dir):!path.includes('/')).sort((a,b)=>b[0].length-a[0].length);
   device=matches[0]?.[1];
   if(!device)throw Error('Select the complete Philips device folder, or PROP.TXT / PROP.BIN together with its session files. Device identity is required.');
  }
  if(P.isData(f.name)&&(/\.b0[125]$/i.test(f.name)!==(device.generation===2)))throw Error('Philips session format does not match its device properties.');
  plan.push({file:f,path:pathOf(f),device,decode:device?.generation===2?decoder.decrypt:null});
 }
 return {plan,ignoredCount};
}
const api={prepare,zipEntries,crc32,pathOf,validateArchive};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PAPImport=api;
})(globalThis);
