// SPDX-License-Identifier: GPL-3.0-or-later
(function(root){
'use strict';
const Time=typeof module!=='undefined'&&module.exports?require('./polar-time.js'):root.PolarTime;
const CSV=typeof module!=='undefined'&&module.exports?require('./polar-csv.js'):root.PolarCSV;
const SPECS={ecg:['ecg_uv','Polar ECG','µV'],hr:['hr_bpm','Polar heart rate','bpm'],rr:['rr_ms','Polar R–R','ms'],hrv:['rmssd_candidate_ms','Polar RMSSD (candidate)','ms']};
function wallClock(zone){
 const offsets=new Map();return ns=>{
  const integer=Time.parseNs(ns),ms=Number(integer/1000000n)+Number(integer%1000000n)/1e6,key=Math.floor(ms/60000);
  if(!offsets.has(key))offsets.set(key,Time.localWallMilliseconds((BigInt(key)*60000000000n).toString(),zone)-key*60000);
  return ms+offsets.get(key);
 };
}
async function makeChannel(type,blob,zone){
 const [value,label,unit]=SPECS[type],wall=wallClock(zone),channel={label,unit,segments:[],polarType:type},required=type==='hrv'?['window_start_unix_ns','window_end_unix_ns',value,'usable_heuristic']:['timestamp_unix_ns',value];
 let t=[],v=[],quality=[],last=-Infinity,seg=null,prevSegment=null;
 function finish(){if(!t.length)return;const values=Float64Array.from(v),part={start:t[0],dt:type==='hrv'?300:type==='ecg'?1/130:1,times:Float64Array.from(t),values,quality:Uint8Array.from(quality),...(type==='hrv'?{ends:Float64Array.from(seg),step:true}:{})};
  if(type==='ecg'){const width=128,extrema=new Float64Array(Math.ceil(values.length/width)*2);for(let group=0;group<extrema.length/2;group++){let lo=Infinity,hi=-Infinity;for(let i=group*width;i<Math.min(values.length,(group+1)*width);i++){const x=values[i];if(Number.isFinite(x)){lo=Math.min(lo,x);hi=Math.max(hi,x);}}extrema[group*2]=lo;extrema[group*2+1]=hi;}part.envelope=extrema;part.envelopeWidth=width;}
  channel.segments.push(part);t=[];v=[];quality=[];seg=null;}
 for await(const r of CSV.objects(blob,required)){
  const time=wall(r[type==='hrv'?'window_start_unix_ns':'timestamp_unix_ns']);const gap=time-last;if(time<last)throw Error('Polar timeline is not monotonic on the PAP clock; split the recording at the clock change.');last=time;
  const valid=r[value]!==''&&Number.isFinite(Number(r[value]));if(!valid&&type!=='hrv')throw Error('Invalid '+label+' value');
  const current=r.connection_segment||'1';if(prevSegment!==null&&(current!==prevSegment||(type==='ecg'&&gap>50)||(type==='hr'&&gap>5000)||(type==='rr'&&gap>5000)))finish();prevSegment=current;
  t.push(time);v.push(valid?Number(r[value]):NaN);quality.push(type==='hrv'?r.usable_heuristic==='true'?1:0:type==='rr'?r.screen_accepted==='true'?1:0:1);
  if(type==='hrv'){if(!seg)seg=[];seg.push(wall(r.window_end_unix_ns));}
  if(t.length>=50000)finish();
 }
 finish();return channel;
}
async function prepare(files,zipReader,deviceZone){
 let entries=[];for(const file of files){if(/\.zip$/i.test(file.name))entries.push(...await zipReader(file,{include:p=>/(^|\/)(session\.json|\d{3}_(ecg|hr|rr|hrv|events|clock)\.csv)$/i.test(p),maxEntry:1500*1024**2}));else entries.push(file);}
 const byName=new Map();for(const f of entries){const name=f.name.toLowerCase();if(!/^(session\.json|\d{3}_(ecg|hr|rr|hrv|events|clock)\.csv)$/.test(name))continue;if(byName.has(name))throw Error('Duplicate file name in Polar recording: '+name);byName.set(name,f);}
 if(!byName.has('session.json'))throw Error('PolarPAP session.json not found. Select one complete session folder or ZIP.');
 const session=JSON.parse(await byName.get('session.json').text()),info=Time.checkSession(session,deviceZone);
 const blobs={};for(const [name,f] of byName){if(name==='session.json')continue;blobs[name]=f instanceof Blob?f:new Blob([await f.arrayBuffer()],{type:'text/csv'});}
 for(const kind of ['ecg','hr','rr','hrv'])if(!Object.keys(blobs).some(x=>x.endsWith('_'+kind+'.csv')))throw Error('Missing '+kind+' CSV in PolarPAP session.');
 return {session,info,blobs};
}
async function channels(record){
 const out={};for(const kind of Object.keys(SPECS)){
  const names=Object.keys(record.blobs).filter(n=>n.endsWith('_'+kind+'.csv')).sort();let merged=null;
  for(const name of names){const c=await makeChannel(kind,record.blobs[name],record.zone);if(!merged)merged=c;else merged.segments.push(...c.segments);}
  if(merged){merged.segments.sort((a,b)=>a.start-b.start);out[kind]=merged;}
 }return out;
}
const api={prepare,makeChannel,channels,wallClock};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PolarImport=api;
})(globalThis);
