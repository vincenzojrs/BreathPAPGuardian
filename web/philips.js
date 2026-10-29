// SPDX-License-Identifier: GPL-3.0-only
// PRS1 F0V6 decoding adapted from OSCAR. See THIRD_PARTY_NOTICES.md.
// Copyright (c) 2019-2024 The OSCAR Team; 2011-2018 Mark Watkins.
(function(root){
'use strict';
const VERSION='prs1-f0v6-v2';
const u16=(b,p)=>b[p]+256*b[p+1];
const u32=(b,p)=>(b[p]+256*b[p+1]+65536*b[p+2]+16777216*b[p+3])>>>0;
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i<<24;for(let j=0;j<8;j++)c=c&0x80000000?(c<<1)^0x04c11db7:c<<1;return c>>>0;});
function crc32wchar(bytes){let c=0xffffffff;for(const b of bytes){for(let i=0;i<3;i++)c=(c<<8)^crcTable[c>>>24];c=(c<<8)^crcTable[(c>>>24)^b];}return c>>>0;}
function ignored(path){return path.replaceAll('\\','/').split('/').some(p=>p.startsWith('.')||p==='__MACOSX');}
function isData(name){return /\.(001|002|005|b01|b02|b05)$/i.test(name);}
function isProperties(name){return /^prop(?:(?:erties|\d*)\.txt|\.bin)$/i.test(name.split('/').at(-1));}
function properties(text){
 const props=Object.create(null),aliases={CF:'CardFormat',SN:'SerialNumber',MN:'ModelNumber',DFV:'DataFormatVersion',F:'Family',FV:'FamilyVersion',SV:'SoftwareVersion'};
 for(const line of text.split(/\r?\n/)){const at=line.indexOf('=');if(at>0){const k=line.slice(0,at).trim();props[aliases[k]||k]=line.slice(at+1).trim();}}
 if(props.Family==='xPAP')props.Family='0';
 if(props.Family!=='0'||props.FamilyVersion!=='6'||props.DataFormatVersion!=='3')throw Error('Unsupported Philips format: only PRS1 family 0 / version 6 / data version 3 is supported.');
 if(!props.SerialNumber||!props.ModelNumber)throw Error('Philips properties lack device identity.');
 return {vendor:'Philips',family:0,familyVersion:6,serial:props.SerialNumber,model:props.ModelNumber,software:props.SoftwareVersion||'',tags:{SRN:props.SerialNumber,PNA:'Philips DreamStation '+props.ModelNumber,Manufacturer:'Philips Respironics',Model:props.ModelNumber}};
}
function chunks(buffer,expectedExt){
 const b=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer),result=[];
 if(!b.length)throw Error('Empty Philips data file');
 for(let offset=0;offset<b.length;){
  const fail=message=>{throw Error(`${message} (byte ${offset})`);};
  if(b.length-offset<20)fail('Truncated Philips header');
  const size=u16(b,offset+1),end=offset+size;
  if(size<21||end>b.length)fail('Invalid or truncated Philips block');
  const h=b.subarray(offset,end),type=h[3],ext=h[6];
  if(h[0]!==3||h[4]!==0||h[5]!==6)fail('Unsupported Philips family/version');
  if(expectedExt!==undefined&&ext!==expectedExt)fail('Philips extension/header mismatch');
  if(![1,2,5].includes(ext)||(ext===5?type!==1:type!==0))fail('Unsupported Philips block type');
  let length;const sizes=Object.create(null),wave=[];
  let duration=0;
  if(type===0){
   length=17+2*h[15];if(length+4>size)fail('Truncated record-size table');
   for(let p=16;p<length-1;p+=2){if(sizes[h[p]]!==undefined)fail('Duplicate record code');sizes[h[p]]=h[p+1];}
  }else{
   length=21+4*h[18];if(length+4>size||h[18]<1||h[18]>2)fail('Unsupported waveform header');
   duration=u16(h,15)*h[17];if(duration<=0)fail('Invalid waveform duration');
   for(let p=19;p<length-2;p+=4){if(h[p]!==wave.length||h[p+3]!==8||!u16(h,p+1))fail('Unsupported waveform channel');wave.push({kind:h[p],samples:u16(h,p+1),dt:h[17]/u16(h,p+1)});}
   if(h[length-2]!==0)fail('Unsupported waveform flags');
  }
  let sum=0;for(let p=0;p<length-1;p++)sum=(sum+h[p])&255;
  if(sum!==h[length-1])fail('Philips header checksum mismatch');
  const data=h.subarray(length,size-4);
  if(crc32wchar(data)!==u32(h,size-4))fail('Philips data CRC mismatch');
  if(type===1&&data.length!==u16(h,15)*wave.reduce((n,w)=>n+w.samples,0))fail('Waveform sample count mismatch');
  result.push({sessionId:u32(h,7),start:u32(h,11)*1000,ext,sizes,wave,duration,data});offset=end;
 }
 return result;
}
function records(chunk,minimum,visit){
 const b=chunk.data;
 for(let p=0;p<b.length;){const code=b[p++],size=chunk.sizes[code];
  if(size===undefined||size<(minimum[code]??1)||p+size>b.length)throw Error('Invalid Philips record 0x'+code.toString(16));
  visit(code,b.subarray(p,p+size));p+=size;
 }
}
function settings(b){
 const result={},raw={};let mode;
 const min={0x0c:3,0x0d:2,0x0e:2,0x0f:4,0x10:3,0x35:2};
 for(let p=0;p<b.length;){
  if(p+2>b.length)throw Error('Truncated Philips setting');
  const code=b[p++],len=b[p++];if(len<(min[code]||1)||p+len>b.length)throw Error('Invalid Philips setting length');
  const v=b.subarray(p,p+len);p+=len;raw['0x'+code.toString(16).padStart(2,'0')]=Array.from(v);
  switch(code){
   case 0:mode=v[0];result.Mode=['CPAP','BiLevel','AutoCPAP','AutoBiLevel','CPAP-Check'][mode]||'Unknown ('+mode+')';break;
   case 0x0a:result.Pressure=v[0]/10;break;
   case 0x0c:result.MinPressure=v[0]/10;result.MaxPressure=v[1]/10;result.Pressure=v[2]/10;break;
   case 0x0d:result.MinPressure=v[0]/10;result.MaxPressure=v[1]/10;break;
   case 0x0e:result.EPAP=v[0]/10;result.IPAP=v[1]/10;break;
   case 0x0f:result.MinEPAP=v[0]/10;result.MaxIPAP=v[1]/10;result.MinPS=v[2]/10;result.MaxPS=v[3]/10;break;
   case 0x10:result.Mode='Auto-Trial';result.AutoTrialDays=v[0];result.MinPressure=v[1]/10;result.MaxPressure=v[2]/10;break;
   case 0x2b:result.RampType=v[0]===0?'Linear':v[0]===128?'SmartRamp':'Unknown';break;
   case 0x2c:result.RampMinutes=v[0];break;
   case 0x2d:result.RampPressure=v[0]/10;break;
   case 0x2e:result.FlexMode=v[0]===0?'Off':v[0]===0x80?([1,3].includes(mode)?'Bi-Flex':'C-Flex'):v[0]===0x90?(mode===2?'A-Flex':'C-Flex+'):v[0]===0xa0?'Rise time':v[0]===0xb0?'P-Flex':'Unknown';break;
   case 0x30:result.FlexLevel=v[0];break;
  }
 }
 return {settings:result,rawSettings:raw};
}
function summary(c){
 let t=0,on=null,config={settings:{},rawSettings:{}};const intervals=[];
 records(c,[1,1,9,4,2,4,1,4,27,2,4,11,1,2,6],(code,b)=>{
  if(![0,1,2,3,4,5,6,7,8,9,10,11,12,13,14].includes(code))throw Error('Unsupported Philips summary record '+code);
  if(code===1)config=settings(b);
  if([2,3,4,9,10,11].includes(code))t+=u16(b,0);
  if(code===3){if(on!==null)throw Error('Repeated Philips mask-on');on=t;}
  if(code===4){if(on===null)throw Error('Philips mask-off without mask-on');if(t>on)intervals.push([c.start+on*1000,c.start+t*1000]);on=null;}
 });
 if(on!==null)throw Error('Incomplete Philips mask-on interval');
 return {id:c.sessionId,start:c.start,end:c.start+t*1000,intervals,...config};
}
function events(c,p){
 let t=0,lastStats=0,bilevel=false;const pressure=[];
 const add=(code,seconds,duration,text)=>p.events.push({time:c.start+seconds*1000,duration,text,code,source:'Philips',sessionId:c.sessionId});
 const segment=(label,unit,start,seconds,value)=>{if(seconds>0)p.signals.push({label,unit,start:c.start+start*1000,dt:seconds,values:Float64Array.of(value),step:true,sessionId:c.sessionId});};
 records(c,[2,3,4,3,3,3,3,3,3,2,3,4,3,2,5,5,5,5,4,3,3,3],(code,b)=>{
  if(![1,2,3,4,5,6,7,10,11,12,13,14,15,16,17,18,20,21].includes(code))throw Error('Unsupported Philips event record '+code);
  if(code!==0x12)t+=u16(b,0);
  const v=b.subarray(2);
  if(code===1)pressure.push({t,label:'PRS1.Pressure',value:v[0]/10});
  else if(code===2){bilevel=true;pressure.push({t,label:'PRS1.EPAP',value:v[0]/10},{t,label:'PRS1.IPAP',value:v[1]/10});}
  else if(code===4)add(code,t,0,'Pressure pulse');
  else if([5,6,7,10,11,12,20,21].includes(code))add(code,t-(code===11?v[1]:v[0]),0,({5:'RERA',6:'Obstructive apnea',7:'Clear airway apnea',12:'Flow limitation'})[code]||'Hypopnea');
  else if(code===13)add(code,t,0,'Vibratory snore');
  else if([14,15,16].includes(code)){const duration=u16(v,0)*2;add(code,t-v[2]-duration,duration,({14:'Variable breathing',15:'Periodic breathing',16:'Large leak'})[code]);}
  else if(code===17){
   segment('PRS1.TotalLeak','L/min',lastStats,t-lastStats,v[0]);
   segment('PRS1.SnoreCount','count/interval',lastStats,t-lastStats,v[1]);
   segment(bilevel?'PRS1.AveragePressure':'PRS1.FlexPressure','cmH2O',lastStats,t-lastStats,v[2]/10);lastStats=t;
  }
 });
 for(const label of new Set(pressure.map(x=>x.label))){const list=pressure.filter(x=>x.label===label);list.forEach((x,i)=>segment(label,'cmH2O',x.t,(list[i+1]?.t??t)-x.t,x.value));}
 if(t>0)p.eventCoverage.push([c.start,c.start+t*1000]);
 return t;
}
function waveform(c,p){
 const arrays=c.wave.map(w=>w.kind===0?new Int8Array(c.duration/w.dt):new Float64Array(c.duration/w.dt));
 let at=0;const offsets=c.wave.map(()=>0);
 while(at<c.data.length)for(let k=0;k<c.wave.length;k++)for(let j=0;j<c.wave[k].samples;j++){
  const v=c.data[at++];arrays[k][offsets[k]++]=k===0?(v>127?v-256:v):v/10;
 }
 c.wave.forEach((w,k)=>p.signals.push({label:k===0?'PRS1.Flow':'PRS1.MaskPressure',unit:k===0?'L/min':'cmH2O',dt:w.dt,start:c.start,values:arrays[k],sessionId:c.sessionId}));
}
// Merge only truly contiguous waveform chunks; keep clock gaps/overlaps explicit.
function mergeWaveforms(signals){
 const groups=new Map();
 for(const s of signals){const key=s.label+':'+s.sessionId;const list=groups.get(key)||[];list.push(s);groups.set(key,list);}
 const out=[];
 for(const list of groups.values()){
  list.sort((a,b)=>a.start-b.start);let run=[];
  const flush=()=>{if(!run.length)return;const length=run.reduce((n,s)=>n+s.values.length,0),values=new run[0].values.constructor(length);let pos=0;for(const s of run){values.set(s.values,pos);pos+=s.values.length;}out.push({...run[0],values});run=[];};
  for(const s of list){const prev=run.at(-1);if(prev&&(prev.dt!==s.dt||Math.abs(prev.start+prev.dt*prev.values.length*1000-s.start)>.01))flush();run.push(s);}flush();
 }
 return out;
}
function parse(buffer,name){
 const ext=Number(name.split('.').at(-1).replace(/^b/i,''));if(!isData(name))throw Error('Unsupported Philips file extension');
 const list=chunks(buffer,ext),p={name,vendor:'Philips',parserVersion:VERSION,start:Infinity,duration:0,summary:false,signals:[],events:[],sessions:[],eventCoverage:[]};let finish=0;
 for(const c of list){p.start=Math.min(p.start,c.start);let duration=c.duration;
  if(ext===1){const s=summary(c);p.sessions.push(s);duration=(s.end-c.start)/1000;}
  if(ext===2)duration=events(c,p);
  if(ext===5)waveform(c,p);
  finish=Math.max(finish,c.start+duration*1000);
 }
 p.duration=(finish-p.start)/1000;if(ext===5||ext===2)p.signals=mergeWaveforms(p.signals);return p;
}
const api={VERSION,properties,chunks,parse,crc32wchar,ignored,isData,isProperties};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Philips=api;
})(globalThis);
