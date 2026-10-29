'use strict';
const DAY=86400000;
function nightKey(t){return new Date(t-12*3600000).toISOString().slice(0,10);}
function readEDF(buffer,name){
 const bytes=new Uint8Array(buffer),dv=new DataView(buffer),dec=new TextDecoder('utf-8'),txt=(p,n)=>dec.decode(bytes.subarray(p,p+n)).trim();
 if(bytes.length<256)throw Error('Incomplete EDF header');
 const ns=Number(txt(252,4)),nr=Number(txt(236,8)),duration=Number(txt(244,8)),header=Number(txt(184,8));
 if(!Number.isInteger(ns)||ns<1||ns>1000||!Number.isInteger(nr)||(nr<0&&!(nr===-1&&bytes.length===header))||header!==256+256*ns)throw Error('Unsupported EDF structure');
 const date=txt(168,8).split('.').map(Number),time=txt(176,8).split('.').map(Number),year=date[2]>=85?1900+date[2]:2000+date[2],start=Date.UTC(year,date[1]-1,date[0],...time);
 if(!Number.isFinite(start)||duration<0)throw Error('Invalid EDF times');let pos=256;const fields=[];
 for(const width of [16,80,8,8,8,8,8,80,8,32]){fields.push(Array.from({length:ns},(_,i)=>txt(pos+i*width,width)));pos+=ns*width;}
 const counts=fields[8].map(Number);if(counts.some(n=>!Number.isInteger(n)||n<0))throw Error('Invalid sample count');const stride=counts.reduce((a,b)=>a+b,0)*2;
 if(bytes.length===header&&(nr===-1||nr===0)){const error=Error('EDF contains only its header: no recorded samples yet. Reimport after the recording is finalized.');error.code='EDF_NO_DATA';throw error;}
 if(header+nr*stride!==bytes.length)throw Error('Inconsistent EDF size');const signals=[],events=[];let offset=0;
 const summary=/^STR(?:\(|\.|$)/i.test(name);
 for(let c=0;c<ns;c++){const label=fields[0][c],n=counts[c];
 if(label==='EDF Annotations'){for(let r=0;r<nr;r++){const raw=dec.decode(bytes.subarray(header+r*stride+offset,header+r*stride+offset+n*2));for(const tal of raw.split('\0')){const chunks=tal.split('\x14'),tim=chunks.shift().split('\x15');for(const text of chunks.filter(Boolean)){const onset=Number(tim[0]);if(Number.isFinite(onset))events.push({time:start+onset*1000,duration:Number(tim[1]||0),text});}}}}
 else if(label!=='Crc16'&&duration>0&&n>0){const [pmin,pmax,dmin,dmax]=[3,4,5,6].map(j=>Number(fields[j][c]));if(dmin===dmax)throw Error('Invalid EDF scale');const values=new Float64Array(n*nr);for(let r=0;r<nr;r++)for(let j=0;j<n;j++){const raw=dv.getInt16(header+r*stride+offset+j*2,true);values[r*n+j]=summary&&raw===-1?NaN:pmin+(raw-dmin)*(pmax-pmin)/(dmax-dmin);}signals.push({label,unit:fields[2][c],dt:duration/n,start,values,name,samplesPerRecord:n});}offset+=n*2;}
 return {name,start,duration:nr*duration,recordDuration:duration,records:nr,summary,signals,events};
}
function unionIntervals(intervals){
 const result=[];
 for(const [a,b] of intervals.filter(([a,b])=>Number.isFinite(a)&&b>a).sort((a,b)=>a[0]-b[0])){
  const prev=result.at(-1);if(prev&&a<=prev[1])prev[1]=Math.max(prev[1],b);else result.push([a,b]);
 }
 return result;
}
function splitInterval(a,b,visit){
 while(a<b){const key=nightKey(a),end=Math.min(b,Date.parse(key+'T12:00:00Z')+DAY);visit(key,a,end);a=end;}
}
function coverageSeconds(intervals,coverage){
 const covered=unionIntervals(coverage);let ms=0;
 for(const [a,b] of unionIntervals(intervals))for(const [c,d] of covered)ms+=Math.max(0,Math.min(b,d)-Math.max(a,c));
 return ms/1000;
}
function buildNights(files){
 const nights=new Map(),get=k=>{
  if(!nights.has(k))nights.set(k,{key:k,channels:{},events:[],settings:{},summary:{},intervals:[],sessionSettings:[],eventCoverage:[]});
  return nights.get(k);
 };
 let device='PAP',identity={},rawSettings=[];
 const sorted=[...files].sort((a,b)=>a.imported-b.imported),sessions=new Map();
 for(const f of sorted){
  if(f.tags){if(f.tags.PNA){device=f.tags.PNA.replaceAll('_',' ');identity={...identity,...f.tags};}rawSettings.push({path:f.path,tags:f.tags});}
  const p=f.parsed;if(!p)continue;
  if(p.vendor==='Philips'){
   for(const session of p.sessions||[]){const key=session.id+':'+session.start,previous=sessions.get(key);sessions.set(key,previous?{...session,intervals:unionIntervals([...previous.intervals,...session.intervals])}:session);}
   for(const [a,b] of p.eventCoverage||[])splitInterval(a,b,(k,x,y)=>{const n=get(k);n.vendor='Philips';n.eventCoverage.push([x,y]);});
  }
  if(p.summary){
   for(let r=0;r<p.records;r++){
    const t=p.start+r*p.recordDuration*1000,k=nightKey(t),vals={};
    for(const s of p.signals){const v=Array.from(s.values.slice(r*s.samplesPerRecord,(r+1)*s.samplesPerRecord));vals[s.label]=v.length===1?v[0]:v;}
    if(!Number.isFinite(vals.Duration))continue;
    const n=get(k);n.summary=vals;n.settings=Object.fromEntries(Object.entries(vals).filter(([key])=>key.startsWith('S.')||key==='Mode'));
   }
   continue;
  }
  for(const s of p.signals){
   if(s.values.every(v=>!Number.isFinite(v))||/^(Pulse|SpO2)/.test(s.label)&&s.values.every(v=>v===-1))continue;
   let i=0;
   while(i<s.values.length){
    const t=s.start+i*s.dt*1000,k=nightKey(t),boundary=Date.parse(k+'T12:00:00Z')+DAY;
    // Interval statistics use their actual duration, including when crossing noon.
    if(s.step){
     let j=i+1;while(j<s.values.length&&s.start+(j+1)*s.dt*1000<=boundary)j++;
     const end=s.start+j*s.dt*1000;
     if(end>boundary){
      splitInterval(t,end,(key,a,b)=>{const n=get(key);if(p.vendor)n.vendor=p.vendor;const ch=n.channels[s.label]||(n.channels[s.label]={label:s.label,unit:s.unit,segments:[]});ch.segments.push({...s,start:a,dt:(b-a)/1000,values:s.values.slice(i,i+1)});});i++;continue;
     }
     const n=get(k);if(p.vendor)n.vendor=p.vendor;const ch=n.channels[s.label]||(n.channels[s.label]={label:s.label,unit:s.unit,segments:[]});
     ch.segments.push({...s,start:t,values:i===0&&j===s.values.length?s.values:s.values.slice(i,j)});i=j;continue;
    }
    const j=Math.min(s.values.length,Math.max(i+1,Math.ceil((boundary-s.start)/(s.dt*1000))));
    const n=get(k);if(p.vendor)n.vendor=p.vendor;
    const part={...s,start:t,values:i===0&&j===s.values.length?s.values:s.values.slice(i,j)};delete part.samplesPerRecord;
    const ch=n.channels[s.label]||(n.channels[s.label]={label:s.label,unit:s.unit,segments:[]});
    const duplicate=ch.segments.findIndex(q=>q.start===part.start);if(duplicate>=0)ch.segments[duplicate]=part;else ch.segments.push(part);i=j;
   }
  }
  for(const e of p.events){if(e.text==='Recording starts')continue;const n=get(nightKey(e.time));if(p.vendor)n.vendor=p.vendor;if(!n.events.some(x=>x.time===e.time&&x.text===e.text&&x.duration===e.duration))n.events.push(e);}
 }
 for(const s of sessions.values()){
  const keys=new Set();
  for(const [a,b] of s.intervals)splitInterval(a,b,(k,x,y)=>{get(k).intervals.push([x,y]);keys.add(k);});
  if(!keys.size)keys.add(nightKey(s.start));
  for(const k of keys){const n=get(k);n.vendor='Philips';n.hasTherapySummary=true;n.sessionSettings.push(s);}
 }
 for(const n of nights.values()){
  n.device=device;
  for(const ch of Object.values(n.channels)){
   ch.segments.sort((a,b)=>a.start-b.start);let end=-Infinity;
   ch.segments=ch.segments.flatMap(s=>{const cut=Math.max(0,Math.ceil((end-s.start)/(s.dt*1000)));if(cut>=s.values.length)return [];const p=cut?{...s,start:s.start+cut*s.dt*1000,values:s.values.slice(cut)}:s;end=p.start+p.values.length*p.dt*1000;return [p];});
  }
  const primary=n.channels['Flow.40ms']||n.channels['PRS1.Flow']||n.channels['Press.2s']||Object.values(n.channels)[0];
  if(!n.hasTherapySummary)n.intervals=primary?primary.segments.map(s=>[s.start,s.start+s.dt*s.values.length*1000]):[];
  n.intervals=unionIntervals(n.intervals);n.usage=n.intervals.reduce((a,[x,y])=>a+(y-x)/3600000,0);
  if(!primary&&!n.hasTherapySummary&&Number.isFinite(n.summary.Duration))n.usage=n.summary.Duration/60;
  n.origin=n.intervals[0]?.[0]||Date.parse(n.key+'T12:00:00Z');n.end=n.intervals.at(-1)?.[1]||n.origin+DAY;
  if(n.vendor==='Philips'){
   n.sessionSettings.sort((a,b)=>a.start-b.start);n.settings=n.sessionSettings.at(-1)?.settings||{};
   n.summary={SessionCount:n.sessionSettings.length,MaskOnMinutes:n.usage*60};
   n.eventCoverage=unionIntervals(n.eventCoverage);n.eventCoverageSeconds=coverageSeconds(n.intervals,n.eventCoverage);
   n.eventsComplete=!!n.hasTherapySummary&&n.usage>0&&n.usage*3600-n.eventCoverageSeconds<=1;
  }
  n.events.sort((a,b)=>a.time-b.time);
 }
 return {nights:[...nights.values()].sort((a,b)=>a.key.localeCompare(b.key)),device,identity,rawSettings};
}
function factor(unit){return unit==='L/s'?60:unit==='L'?1000:1;}
function displayUnit(unit){return unit==='L/s'?'L/min':unit==='L'?'mL':unit||'index';}
function stats(ch,excludeZeros=false){
 if(!ch)return null;const values=[];let sum=0,weight=0;const intervalData=ch.segments.some(s=>s.step);
 for(const s of ch.segments)for(const v of s.values){if(!Number.isFinite(v)||excludeZeros&&v===0)continue;values.push(intervalData?{v,w:s.dt}:v);sum+=v*s.dt;weight+=s.dt;}
 if(!values.length)return null;values.sort(intervalData?(a,b)=>a.v-b.v:(a,b)=>a-b);
 const q=p=>{if(intervalData){let cumulative=0;for(const x of values){cumulative+=x.w;if(cumulative>=p*weight)return x.v;}return values.at(-1).v;}const x=(values.length-1)*p,a=Math.floor(x);return values[a]+(values[Math.ceil(x)]-values[a])*(x-a);};
 const m=factor(ch.unit);return {min:(intervalData?values[0].v:values[0])*m,med:q(.5)*m,p95:q(.95)*m,p995:q(.995)*m,mean:sum/weight*m,count:values.length};
}
function episodes(ch,threshold=0){if(!ch)return null;let count=0,seconds=0,on=false,lastEnd=null;for(const s of ch.segments){if(lastEnd===null||Math.abs(s.start-lastEnd)>1)on=false;for(const v of s.values){const yes=Number.isFinite(v)&&v>threshold;if(yes&&!on)count++;if(yes)seconds+=s.dt;on=yes;}lastEnd=s.start+s.values.length*s.dt*1000;}return {count,minutes:seconds/60};}
function lowerTime(a,t){let l=0,r=a.length;while(l<r){const m=(l+r)>>1;if(a[m]<t)l=m+1;else r=m;}return l;}
function sample(ch,t){if(!ch)return null;for(const s of ch.segments){if(s.times){let i=lowerTime(s.times,t);if(ch.polarType==='hrv'){i=i<s.times.length&&s.times[i]===t?i:i-1;if(i<0||t>=s.ends[i])continue;}else {if(i===s.times.length)i--;else if(i>0&&Math.abs(s.times[i-1]-t)<Math.abs(s.times[i]-t))i--;const tolerance=ch.polarType==='ecg'?20:ch.polarType==='hr'?2000:2500;if(i<0||Math.abs(s.times[i]-t)>tolerance)continue;}return {t:s.times[i],v:s.values[i]*factor(ch.unit),quality:s.quality?.[i]};}if(t>=s.start&&t<s.start+s.values.length*s.dt*1000){const i=Math.min(s.values.length-1,(s.step?Math.floor:Math.round)((t-s.start)/1000/s.dt));return {t:s.start+i*s.dt*1000,v:s.values[i]*factor(ch.unit)};}}return null;}
function alignChannel(ch,offset,ppm){const base=ch.segments[0].start,scale=1+ppm/1e6;if(scale<=0)throw Error('Invalid drift');return {...ch,segments:ch.segments.map(s=>({...s,start:base+offset*1000+(s.start-base)*scale,dt:s.dt*scale}))};}
if(typeof module!=='undefined')module.exports={readEDF,buildNights,nightKey,stats,episodes,sample,alignChannel};
// Purge a PAP noon-to-noon day while preserving records from other days.
function removeNightFromParsed(p,key){
 if(p.summary){const removed=[];for(let r=0;r<p.records;r++)if(nightKey(p.start+r*p.recordDuration*1000)===key)removed.push(r);if(!removed.length)return {affected:false,parts:[p]};const parts=[];for(let r=0;r<p.records;r++){if(removed.includes(r))continue;parts.push({...p,start:p.start+r*p.recordDuration*1000,records:1,duration:p.recordDuration,signals:p.signals.map(s=>({...s,start:p.start+r*p.recordDuration*1000,values:s.values.slice(r*s.samplesPerRecord,(r+1)*s.samplesPerRecord)}))});}return {affected:true,parts};}
 const begin=Date.parse(key+'T12:00:00Z'),end=begin+DAY;
 const metadataHit=(p.sessions||[]).some(s=>s.intervals.some(([a,b])=>a<end&&b>begin)||nightKey(s.start)===key)||(p.eventCoverage||[]).some(([a,b])=>a<end&&b>begin);
 const affected=metadataHit||p.events.some(e=>e.time>=begin&&e.time<end)||p.signals.some(s=>s.start<end&&s.start+s.values.length*s.dt*1000>begin)||(!p.signals.length&&!p.events.length&&nightKey(p.start)===key);
 if(!affected)return {affected:false,parts:[p]};const parts=[];
 for(const [lo,hi]of [[-Infinity,begin],[end,Infinity]]){
  const signals=[];
  for(const s of p.signals){
   if(s.step){
    for(let i=0;i<s.values.length;i++){const a=Math.max(lo,s.start+i*s.dt*1000),b=Math.min(hi,s.start+(i+1)*s.dt*1000);if(b>a)signals.push({...s,start:a,dt:(b-a)/1000,values:s.values.slice(i,i+1)});}
   }else{const a=Math.max(0,Math.ceil((lo-s.start)/(s.dt*1000))),b=Math.min(s.values.length,Math.ceil((hi-s.start)/(s.dt*1000)));if(b>a)signals.push({...s,start:s.start+a*s.dt*1000,values:s.values.slice(a,b)});}
  }
  const events=p.events.filter(e=>e.time>=lo&&e.time<hi);
  const clip=intervals=>(intervals||[]).map(([a,b])=>[Math.max(a,lo),Math.min(b,hi)]).filter(([a,b])=>b>a);
  const sessions=(p.sessions||[]).flatMap(s=>{const intervals=clip(s.intervals);return intervals.length||!s.intervals.length&&s.start>=lo&&s.start<hi?[{...s,intervals}]:[];});
  const eventCoverage=clip(p.eventCoverage);
  if(!signals.length&&!events.length&&!sessions.length&&!eventCoverage.length)continue;
  const starts=[...signals.map(s=>s.start),...events.map(e=>e.time),...sessions.flatMap(s=>s.intervals.length?s.intervals.map(x=>x[0]):[s.start]),...eventCoverage.map(x=>x[0])];
  const start=Math.min(...starts),finish=Math.max(start,...signals.map(s=>s.start+s.values.length*s.dt*1000),...events.map(e=>e.time),...sessions.flatMap(s=>s.intervals.map(x=>x[1])),...eventCoverage.map(x=>x[1]));
  parts.push({...p,start,duration:(finish-start)/1000,signals,events,sessions,eventCoverage});
 }
 return {affected:true,parts};
}
if(typeof module!=='undefined')module.exports.removeNightFromParsed=removeNightFromParsed;

if(typeof module!=='undefined')Object.assign(module.exports,{unionIntervals,coverageSeconds});
