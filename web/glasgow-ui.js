// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const giResults=new Map(),giMemoryCache=new Map();
const GI_METHOD='glasgow-reference-nine-components-v1';
async function giSignature(n){const ch=n.channels['Flow.40ms'];if(!ch)return GI_METHOD+'|no-flow|'+n.key;const parts=[];for(const s of ch.segments){const bytes=await crypto.subtle.digest('SHA-256',s.values);parts.push([s.start,s.dt,s.values.length,Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('')]);}return Portable.hash(JSON.stringify([GI_METHOD,ch.unit,parts]));}
function applyPortablePreferences(rows){const p=rows.find(x=>x.id==='view');if(!p)return;if(Array.isArray(p.signalOrder))signalOrder=p.signalOrder;if(['classic','custom'].includes(p.giChartMode))giChartMode=p.giChartMode;for(const [set,values] of [[giSelected,p.giSelected],[trendSelected,p.trendSelected]])if(Array.isArray(values)){set.clear();values.forEach(x=>set.add(x));}}
function savePortablePreferences(){if(!portable||!Portable.writable||Portable.state?.preview)return;put('preferences',{id:'view',signalOrder,giChartMode,giSelected:[...giSelected],trendSelected:[...trendSelected]}).catch(e=>Portable.error(e));}
let giEpoch=0,giWorker=null,giReject=null,giScheduled=null;
const giKeys=[['overall','Mean GI'],...Glasgow.COMPONENTS];
const palette=['#087f7a','#8b4ac2','#d06024','#2274be','#bf3965','#658115','#6356cb','#a46528','#00839b','#536875'];
let giChartMode='classic';
const giSelected=new Set(['overall','flatTop','topHeavy']),trendSelected=new Set(['usage','gi:overall']);
let signalOrder=[];
try{const saved=JSON.parse(localStorage.getItem('bpg-signal-order')||'[]');if(Array.isArray(saved))signalOrder=saved.filter(k=>typeof k==='string');}catch{}
function giGetNight(key){return giResults.get(key);}
function giReset(){
 giEpoch++;giResults.clear();clearTimeout(giScheduled);
 if(giWorker){giWorker.terminate();giWorker=null;giReject?.(Error('Archive changed'));giReject=null;}
 if(portable)Portable.analysisBusy=true;const epoch=giEpoch;giScheduled=setTimeout(()=>giAnalyze([...nights],epoch),0);
}
async function giAnalyze(list,epoch){
 for(let i=0;i<list.length&&epoch===giEpoch;i++){
  const n=list[i];$('giStatus').textContent=`Analyzing Glasgow Index · ${i+1}/${list.length} · ${n.key}`;
  try{
   if(n.vendor==='Philips'){giResults.set(n.key,{status:'unavailable',reason:'Glasgow Index unavailable for Philips flow: the current algorithm requires validated 25 Hz input. No resampling is applied.'});continue;}
   const signature=portable?await giSignature(n):null,cached=portable?(giCacheRecords.find(x=>x.id===n.key&&x.signature===signature&&x.method===GI_METHOD)||giMemoryCache.get(signature)):null;
   const result=cached?.result||await new Promise((resolve,reject)=>{
    const worker=new Worker('glasgow-worker.js');giWorker=worker;giReject=reject;
    const finish=()=>{worker.terminate();if(giWorker===worker){giWorker=null;giReject=null;}};
    worker.onmessage=e=>{finish();e.data.error?reject(Error(e.data.error)):resolve(e.data.result);};
    worker.onerror=e=>{finish();reject(Error(e.message||'Glasgow analysis failed'));};
    const ch=n.channels['Flow.40ms'];
    const channel=ch?{unit:ch.unit,segments:ch.segments.map(s=>({start:s.start,dt:s.dt,values:new Float64Array(s.values)}))}:null;
    worker.postMessage({channel},channel?channel.segments.map(s=>s.values.buffer):[]);
   });
   if(epoch!==giEpoch)return;giResults.set(n.key,result);
   if(portable){const entry={id:n.key,signature,method:GI_METHOD,result};giMemoryCache.set(signature,entry);if(Portable.writable&&!Portable.state?.preview&&!Portable.state?.pending&&!giCacheRecords.some(x=>x.id===n.key&&x.signature===signature&&x.method===GI_METHOD)){try{await put('analysis',entry);giCacheRecords=giCacheRecords.filter(x=>x.id!==n.key);giCacheRecords.push(entry);}catch(e){Portable.error(e);}}}
  }catch(e){if(epoch!==giEpoch)return;giResults.set(n.key,{status:'unavailable',reason:e.message});}
  giRenderHome();renderOverview();giRenderNight();if(night?.key===n.key)renderStats();
 }
 if(epoch===giEpoch){giRenderHome();renderOverview();giRenderNight();if(night)renderStats();if(portable){Portable.analysisBusy=false;Portable.changed();}const done=[...giResults.values()].filter(r=>r.status==='ok').length;$('giStatus').textContent=list.length?`Glasgow analysis complete · ${done}/${list.length} nights available. Cached results are reused when flow and algorithm are unchanged.`:'';}
}
function giRows(){const min=$('giFrom').value,max=$('giTo').value;return nights.filter(n=>(!min||n.key>=min)&&(!max||n.key<=max)&&(!$('giHideShort').checked||n.usage>=4));}
function giRenderHome(){renderTrend();}
function renderOverview(){
 const last=nights.slice(-7),mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
 const withEvents=last.map(n=>({usage:n.usage,apnea:count(n,'apnea'),hypopnea:count(n,'hypopnea')})).filter(x=>x.usage>0&&x.apnea!==null&&x.hypopnea!==null);
 const hours=withEvents.reduce((sum,x)=>sum+x.usage,0),ahi=hours?withEvents.reduce((sum,x)=>sum+x.apnea+x.hypopnea,0)/hours:null;
 const flow=last.map(n=>stat(n,'FlowLim.2s')?.mean).filter(Number.isFinite);
 const usage=last.map(n=>n.usage).filter(Number.isFinite);
 const gi=last.map(n=>giResults.get(n.key)).filter(r=>r?.status==='ok').map(r=>r.overall);
 const cards=[
  [fmt(ahi),'Annotated AHI · latest 7',`${withEvents.length}/${last.length} nights with event files and use. Annotated apneas + hypopneas divided by their total hours of device use; this is not a clinical sleep AHI.`],
  [fmt(mean(flow)),'Mean flow limitation · latest 7',`${flow.length}/${last.length} nights with recorded FlowLim values. Arithmetic mean of available nightly signal means, not GI.`],
  [fmt(mean(usage)),'Mean use · latest 7',`${usage.length}/${last.length} nights with available use duration; hours per night.`],
  [fmt(mean(gi)),'Mean GI · latest 7',`${gi.length}/${last.length} nights with analyzable flow. Mean of available nightly GI totals; not RDI.`],
  [String(nights.length),'Nights available','Total visible nights in this archive.']
 ];
 $('kpis').replaceChildren(...cards.map(([value,label,hint])=>{const card=el('div',undefined,'kpi');card.title=hint;card.append(el('strong',value),el('span',label));return card;}));
}
function trendDefinitions(){
 const defs=[['usage','Usage','h'],['gi:overall','Mean GI','GI (0–9)'],['apnea','Annotated apneas','count'],['hypopnea','Annotated hypopneas','count'],['snore','Snore episodes','count'],['flowlim','Flow limitation episodes','count'],['snoreMin','Snore above threshold','min'],['flowMin','Flow limitation above threshold','min']];
 const keys=[...new Set(nights.flatMap(n=>Object.keys(n.channels)))];return [...defs,...keys.map(k=>['mean:'+k,(names[k]||k)+' · mean',displayUnit(nights.find(n=>n.channels[k]).channels[k].unit)])];
}
function trendValue(n,key){
 if(key==='usage')return n.usage;
 if(key.startsWith('gi:')){const r=giResults.get(n.key);return r?.status==='ok'?(key==='gi:overall'?r.overall:r.components[key.slice(3)]):null;}
 if(key==='apnea'||key==='hypopnea')return count(n,key);
 if(key.startsWith('mean:'))return stat(n,key.slice(5))?.mean??null;
 const snore=key.startsWith('snore'),ep=episodes(n.channels[snore?'Snore.2s':'FlowLim.2s'],Number($(snore?'snoreThreshold':'flowThreshold').value));return ep?(key.endsWith('Min')?ep.minutes:ep.count):null;
}
function seriesToggle(key,label,color,checked,onchange){
 const l=el('label',undefined,'series-chip'),input=el('input'),swatch=el('span',undefined,'series-swatch');input.type='checkbox';input.checked=checked;input.dataset.series=key;input.onchange=()=>onchange(input.checked);swatch.style.background=color;l.append(input,swatch,document.createTextNode(label));return l;
}
function renderTrend(){
 const defs=trendDefinitions(),choices=$('trendChoices');choices.replaceChildren();defs.forEach(([k,label,unit],i)=>choices.append(seriesToggle(k,label,seriesColor(i),trendSelected.has(k),v=>{v?trendSelected.add(k):trendSelected.delete(k);savePortablePreferences();renderTrend();})));
 const list=giRows(),host=$('trend');host.replaceChildren();$('trendReadout').textContent='';if(!list.length){host.append(el('p','Import nights to see your trends.'));return;}
 const active=defs.flatMap(([k,label,unit],i)=>trendSelected.has(k)?[{k,label,unit,color:seriesColor(i),rows:Glasgow.movingMean(list.map(n=>({key:n.key,value:trendValue(n,k)})),'value',Number($('giSmooth').value))}]:[]);
 if(!active.length){host.append(el('p','Select one or more series above.'));return;}
 const canvas=el('canvas');canvas.id='trendCanvas';canvas.setAttribute('aria-label','Grouped bar chart of nightly trends');host.append(canvas);
 const w=Math.max(650,host.clientWidth||1000,list.length*Math.max(50,active.length*15+20)+90),h=300,dpr=devicePixelRatio||1;canvas.style.width=w+'px';canvas.width=w*dpr;canvas.height=h*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
 const x0=58,pw=w-86,group=pw/list.length,base=245,top=40,plotHeight=base-top;
 ctx.font='11px system-ui';ctx.fillStyle='#536875';ctx.fillText('Bars scaled per metric · exact units below',x0,17);
 for(let j=0;j<=4;j++){const y=base-j*plotHeight/4;ctx.strokeStyle='#e5edef';ctx.beginPath();ctx.moveTo(x0,y);ctx.lineTo(w-28,y);ctx.stroke();}
 const scales=el('div',undefined,'trend-scales');
 active.forEach((s,index)=>{
  const values=s.rows.map(r=>r.smoothed).filter(Number.isFinite),lo=Math.min(0,...values),hi=Math.max(0,...values),range=hi-lo||1,zeroY=base-(0-lo)/range*plotHeight;
  const note=el('span',`${s.label}: ${values.length?fmt(lo)+'–'+fmt(hi)+' '+s.unit:'unavailable'}`);note.style.color=s.color;scales.append(note);
  for(let i=0;i<s.rows.length;i++){
   const value=s.rows[i].smoothed;if(!Number.isFinite(value))continue;
   const y=base-(value-lo)/range*plotHeight,barWidth=Math.min(19,(group-12)/active.length),x=x0+(i+.5)*group+(index-(active.length-1)/2)*barWidth;
   ctx.fillStyle=s.color;ctx.fillRect(x-barWidth/2,Math.min(zeroY,y),barWidth,Math.max(2,Math.abs(zeroY-y)));
  }
 });
 for(let i=0;i<list.length;i++){const x=x0+(i+.5)*group;if(group>=75||i%Math.ceil(75/group)===0)ctx.fillText(list[i].key,Math.max(x0,Math.min(w-85,x-30)),278);}
 host.append(scales);
 const nearest=e=>{const r=canvas.getBoundingClientRect(),index=Math.max(0,Math.min(list.length-1,Math.floor((e.clientX-r.left-x0)/group)));return list[index];};
 canvas.onpointermove=e=>{const n=nearest(e);$('trendReadout').textContent=n.key+' · '+active.map(s=>s.label+': '+fmt(s.rows.find(r=>r.key===n.key)?.smoothed)+' '+s.unit).join(' · ');};canvas.onclick=e=>openNight(nearest(e).key);
}
function seriesColor(i){return i===0?'#3f6470':i===1?palette[0]:`hsl(${(Math.round(i*137.508)+100)%360} 65% 36%)`;}
function orderedSignals(){return [...selected].sort((a,b)=>{const ia=signalOrder.indexOf(a),ib=signalOrder.indexOf(b);return (ia<0?999:ia)-(ib<0?999:ib);});}
function moveSignal(source,target){
 if(source===target)return;const order=[...new Set([...signalOrder,...selected])],from=order.indexOf(source),to=order.indexOf(target);if(from<0||to<0)return;order.splice(from,1);order.splice(to,0,source);signalOrder=order;try{localStorage.setItem('bpg-signal-order',JSON.stringify(order));}catch{}savePortablePreferences();build();giRenderNight();
}
function setupSignalCard(box,head,key){
 box.dataset.signal=key;const handle=el('span','⠿');handle.className='drag-handle no-print';handle.draggable=true;handle.title='Drag to reorder '+(names[key]||key);handle.setAttribute('aria-label',handle.title);
 handle.ondragstart=e=>{e.dataTransfer.setData('text/plain',key);e.dataTransfer.effectAllowed='move';box.classList.add('dragging');};handle.ondragend=()=>document.querySelectorAll('.dragging,.drop-target').forEach(x=>x.classList.remove('dragging','drop-target'));
 box.ondragover=e=>{if([...e.dataTransfer.types].includes('text/plain')){e.preventDefault();box.classList.add('drop-target');}};box.ondragleave=()=>box.classList.remove('drop-target');box.ondrop=e=>{e.preventDefault();box.classList.remove('drop-target');moveSignal(e.dataTransfer.getData('text/plain'),key);};
 const up=button('↑',()=>{const list=orderedSignals(),i=list.indexOf(key);if(i>0)moveSignal(key,list[i-1]);}),down=button('↓',()=>{const list=orderedSignals(),i=list.indexOf(key);if(i<list.length-1)moveSignal(key,list[i+1]);});for(const [b,label] of [[up,'Move signal up'],[down,'Move signal down']]){b.className='no-print';b.setAttribute('aria-label',label);b.title=label;}head.append(handle,up,down);
}
function giCreateCard(){
 const box=el('section',undefined,'chart'),head=el('div',undefined,'head');box.id='giNightPanel';setupSignalCard(box,head,'glasgow');head.append(el('strong','Glasgow Index'));
 const selector=el('select');selector.id='giChartMode';selector.setAttribute('aria-label','Glasgow chart type');for(const [value,label] of [['classic','GI · Classic timeline'],['custom','GI · Component curves']]){const o=el('option',label);o.value=value;selector.append(o);}selector.value=giChartMode;selector.onchange=()=>{giChartMode=selector.value;savePortablePreferences();build();giRenderNight();};
 const controls=el('div',undefined,'no-print');controls.append(selector);
 if(giChartMode==='custom'){const choices=el('div',undefined,'series-choices');giKeys.forEach(([k,l],i)=>choices.append(seriesToggle(k,l,palette[i],giSelected.has(k),v=>{v?giSelected.add(k):giSelected.delete(k);savePortablePreferences();giDrawHeatmap();})));controls.append(choices);}
 const info=el('p');info.id='giNightStatus';info.setAttribute('role','status');const hint=el('p',giChartMode==='classic'?'Darker marks indicate more flagged inspirations. Gray means no analyzed inspiration starts in that column. Click to inspect the flow.':'Each point averages inspirations starting in a time bin (at least 30 seconds, unless the visible range is shorter). GI uses the left scale (0–9); components use the right scale (0–1). Gaps remain empty. Click to inspect the flow.','muted');
 const canvas=el('canvas');canvas.id='giHeatmap';canvas.setAttribute('aria-label','Glasgow component timeline');canvas.onclick=e=>{const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,x0=giChartMode==='classic'?120:65;if(x<x0)return;jump(night.origin+(left+Math.max(0,Math.min(1,(x-x0)/(r.width-x0-50)))*span)*1000);};box.append(head,controls,info,hint,canvas);cards.push({key:'glasgow',canvas});return box;
}
function giRenderNight(){
 if(!night||!$('giNightStatus'))return;const r=giResults.get(night.key);$('giNightStatus').textContent=r?.status==='ok'?`Mean GI ${fmt(r.overall)} · ${r.inspirations} inspirations · ${fmt(r.seconds/3600)} h analyzed of ${fmt(night.usage)} h use. ${r.warnings.join(' ')}`:r?.reason||'Analyzing Glasgow Index automatically…';giDrawHeatmap();
}
function giStatisticRows(){
 const r=night&&giResults.get(night.key);if(r?.status!=='ok')return [['GI · flags per inspiration','0–9','—','—','—','—','—'],['GI · nightly index','0–9','—','—','—','—','—']];
 const values=Float64Array.from(r.sessions.flatMap(s=>s.breaths.map(b=>b.indices.overall)));
 const s=stats({unit:'',segments:[{dt:1,values}]});
 return [['GI · flags per inspiration','0–9',fmt(s?.min),fmt(s?.med),fmt(s?.p95),fmt(s?.p995),fmt(s?.mean)],['GI · nightly index','0–9','—','—','—','—',fmt(r.overall)],...Glasgow.COMPONENTS.map(([k,label])=>['GI · '+label,'fraction','—','—','—','—',fmt(r.components[k])])];
}
function giStatisticsNote(){
 const r=night&&giResults.get(night.key);return r?.status==='ok'?`${r.inspirations} inspirations · ${fmt(r.seconds/3600)} h analyzed. GI percentiles and the first mean describe per-inspiration flag counts. Nightly GI and component means use the reference duration-weighted, rounded session method; they can differ from a simple breath average.`:r?.reason||'Glasgow analysis runs automatically; statistics will appear when ready.';
}
function giDrawHeatmap(){
 const canvas=$('giHeatmap');if(!canvas||!night||$('detail').hidden)return;const result=giResults.get(night.key),w=canvas.clientWidth;if(w<100)return;const h=320,dpr=devicePixelRatio||1;canvas.width=w*dpr;canvas.height=h*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.font='11px system-ui';
 if(result?.status!=='ok'){ctx.fillStyle='#536875';ctx.fillText(result?.reason||'Analyzing…',20,50);return;}
 const classic=giChartMode==='classic',x0=classic?120:65,pw=Math.max(1,Math.floor(w-x0-50)),start=night.origin+left*1000,end=start+span*1000;
 if(classic){const bins=Glasgow.heatBins(result,start,end,pw);giKeys.forEach(([key,label],row)=>{const y=10+row*27;ctx.fillStyle='#425966';ctx.fillText(key==='overall'?'Overall GI':label,0,y+14);ctx.fillStyle='#eef2f4';ctx.fillRect(x0,y,pw,22);bins.forEach((bin,i)=>{if(!bin.count)return;const v=key==='overall'?bin.overall/9:bin[key];ctx.fillStyle=`rgba(105,56,170,${.08+.92*v})`;ctx.fillRect(x0+i,y,1,22);});});}
 else{
  const width=Math.max(1,Math.min(Math.floor(pw/4),Math.floor(span/30))),bins=Glasgow.heatBins(result,start,end,width);
  for(let i=0;i<=3;i++){const y=270-i*75;ctx.strokeStyle='#e5edef';ctx.beginPath();ctx.moveTo(x0,y);ctx.lineTo(x0+pw,y);ctx.stroke();ctx.fillStyle='#536875';ctx.fillText(String(i*3),20,y+4);ctx.fillText(fmt(i/3),x0+pw+8,y+4);}ctx.fillText('GI 0–9',12,25);ctx.fillText('0–1',x0+pw+7,25);
  giKeys.forEach(([key,label],index)=>{if(!giSelected.has(key))return;ctx.strokeStyle=palette[index];ctx.fillStyle=palette[index];ctx.lineWidth=2;ctx.beginPath();let fresh=true;bins.forEach((b,i)=>{if(!b.count){fresh=true;return;}const x=x0+(i+.5)/width*pw,y=270-(key==='overall'?b.overall/9:b[key])*225;fresh?ctx.moveTo(x,y):ctx.lineTo(x,y);fresh=false;});ctx.stroke();bins.forEach((b,i)=>{if(b.count){ctx.beginPath();ctx.arc(x0+(i+.5)/width*pw,270-(key==='overall'?b.overall/9:b[key])*225,2.5,0,Math.PI*2);ctx.fill();}});});if(!giSelected.size){ctx.fillStyle='#536875';ctx.fillText('Select one or more series above.',x0+20,145);}
 }
 ctx.fillStyle='#425966';for(let i=0;i<5;i++)ctx.fillText(clock(start+(end-start)*i/4),Math.min(w-62,x0+pw*i/4),305);
 const line=(t,color)=>{if(t<start||t>end)return;const x=x0+(t-start)/(end-start)*pw;ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(x,8);ctx.lineTo(x,280);ctx.stroke();};for(const m of annotations.filter(m=>m.night===night.key))line(m.time,'#ce4475');if(cursor!==null)line(night.origin+cursor*1000,'#253d4d');
}
for(const id of ['giFrom','giTo','giHideShort','giSmooth'])$(id).onchange=giRenderHome;
