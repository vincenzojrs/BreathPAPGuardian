// SPDX-License-Identifier: GPL-3.0-or-later
(function(root){
'use strict';
const reference=typeof module!=='undefined'&&module.exports?require('./vendor/glasgow-reference.js'):root.GlasgowReference;
const VERSION='glasgow-9-v1';
const COMPONENTS=[['skew','Skew'],['spike','Spike'],['flatTop','Flat Top'],['topHeavy','Top Heavy'],['multiPeak','Multi Peak'],['noPause','No Pause'],['inspirRate','Inspir Rate'],['multiBreath','Multi Breath'],['ampVar','Variable Amp']];
const round=v=>Math.round(v*100)/100;
// Each uninterrupted finite run is independent: never synthesize breaths across gaps.
function analyzeChannel(channel){
 const sessions=[],warnings=[];
 if(!channel)return {version:VERSION,status:'unavailable',reason:'High-resolution flow unavailable. Import BRP EDF data.',sessions,warnings};
 const unit=channel.unit.trim(),scale=unit==='L/s'?60:unit==='L/min'?1:null;
 if(scale===null)return {version:VERSION,status:'unavailable',reason:'Unsupported flow unit: '+unit,sessions,warnings};
 for(const segment of channel.segments){
  if(!Number.isFinite(segment.dt)||Math.abs(segment.dt-.04)>1e-7){warnings.push('Skipped flow segment: expected 25 Hz.');continue;}
  let a=0;
  while(a<segment.values.length){
   while(a<segment.values.length&&!Number.isFinite(segment.values[a]))a++;
   let b=a;while(b<segment.values.length&&Number.isFinite(segment.values[b]))b++;
   if(b===a)break;
   if(b-a>=51){
    const start=segment.start+a*40;
    const data=Array.from(segment.values.subarray(a,b),(v,i)=>({x:start+i*40,y:v*scale}));
    const result=reference.analyze(data);
    if(result.cumIndex){
     const components=Object.fromEntries(COMPONENTS.map(([key])=>[key,result.cumIndex[key]]));
     const breaths=result.inspirations.map(v=>({time:start+v.start*40,end:start+v.end*40,indices:v.indices}));
     sessions.push({start,end:start+(b-a)*40,seconds:(b-a)*.04,components,breaths});
    }else warnings.push('No complete inspirations in a flow run; its duration is excluded.');
   }else warnings.push('Flow run shorter than 51 samples excluded.');
   a=b;
  }
 }
 const seconds=sessions.reduce((sum,s)=>sum+s.seconds,0);
 if(!seconds)return {version:VERSION,status:'unavailable',reason:'No analyzable 25 Hz flow with complete inspirations.',sessions,warnings:[...new Set(warnings)]};
 const components=Object.fromEntries(COMPONENTS.map(([key])=>[key,round(sessions.reduce((sum,s)=>sum+s.components[key]*s.seconds,0)/seconds)]));
 // Match groupByNight in upstream multi_night_analyzer.html: sum all NINE rounded components.
 const overall=round(COMPONENTS.reduce((sum,[key])=>sum+components[key],0));
 const inspirations=sessions.reduce((sum,s)=>sum+s.breaths.length,0);
 if(seconds<300)warnings.push('Less than five minutes analyzed; interpret short runs cautiously.');
 return {version:VERSION,status:'ok',overall,components,seconds,inspirations,sessions,warnings:[...new Set(warnings)]};
}
// Trailing calendar-day window. Do not turn missing nights into zeros.
function movingMean(rows,key,days){
 return rows.map(row=>{
  const stop=Date.parse(row.key+'T12:00:00Z'),begin=stop-(days-1)*86400000;
  const values=rows.filter(r=>{const t=Date.parse(r.key+'T12:00:00Z');return t>=begin&&t<=stop&&Number.isFinite(r[key]);}).map(r=>r[key]);
  return {...row,smoothed:Number.isFinite(row[key])&&values.length?values.reduce((a,b)=>a+b,0)/values.length:null};
 });
}
function heatBins(result,start,end,width){
 const bins=Array.from({length:width},()=>({count:0,overall:0,...Object.fromEntries(COMPONENTS.map(([k])=>[k,0]))}));
 if(result?.status!=='ok'||end<=start)return bins;
 for(const s of result.sessions)for(const breath of s.breaths){
  if(breath.time<start||breath.time>=end)continue;
  const bin=bins[Math.min(width-1,Math.floor((breath.time-start)/(end-start)*width))];bin.count++;bin.overall+=breath.indices.overall;
  for(const [key] of COMPONENTS)if(breath.indices[key])bin[key]++;
 }
 for(const bin of bins)if(bin.count){bin.overall/=bin.count;for(const [key] of COMPONENTS)bin[key]/=bin.count;}
 return bins;
}
const api={VERSION,COMPONENTS,analyzeChannel,movingMean,heatBins};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Glasgow=api;
})(globalThis);
