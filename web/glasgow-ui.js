// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const giResults=new Map();let giEpoch=0,giRunning=false,giWorker=null,giReject=null;
function giReset(){
 giEpoch++;giResults.clear();
 if(giWorker){giWorker.terminate();giWorker=null;giReject?.(Error('Archive changed; analysis cancelled.'));giReject=null;}
}
function giGetNight(key){return giResults.get(key);}
function giRows(){
 const min=$('giFrom').value,max=$('giTo').value,short=$('giHideShort').checked;
 return nights.filter(n=>(!min||n.key>=min)&&(!max||n.key<=max)&&(!short||n.usage>=4));
}
function giControls(){
 $('giAnalyze').disabled=giRunning||!giRows().length;
 $('giAnalyzeNight').disabled=giRunning||!night;
 $('giCancel').hidden=!giRunning;
}
async function giAnalyze(list){
 if(giRunning)return;giRunning=true;giControls();const epoch=giEpoch;
 try{
  for(let i=0;i<list.length;i++){
   const n=list[i];$('giStatus').textContent=`Analyzing ${i+1}/${list.length}: ${n.key}`;
   if(!giResults.has(n.key)){
    const result=await new Promise((resolve,reject)=>{
     const worker=new Worker('glasgow-worker.js');giWorker=worker;giReject=reject;
     const finish=()=>{worker.terminate();if(giWorker===worker){giWorker=null;giReject=null;}};
     worker.onmessage=e=>{finish();e.data.error?reject(Error(e.data.error)):resolve(e.data.result);};
     worker.onerror=e=>{finish();reject(Error(e.message||'Glasgow worker failed.'));};
     const ch=n.channels['Flow.40ms'];
     // Transfer copies, leaving the original archive and charts intact.
     const channel=ch?{unit:ch.unit,segments:ch.segments.map(s=>({start:s.start,dt:s.dt,values:new Float64Array(s.values)}))}:null;
     worker.postMessage({channel},channel?channel.segments.map(s=>s.values.buffer):[]);
    });
    if(epoch!==giEpoch)return;
    giResults.set(n.key,result);
   }
   giRenderHome();giRenderNight();
  }
  $('giStatus').textContent='Analysis complete. Results stay in memory; recalculate after reopening or changing the archive.';
 }catch(e){$('giStatus').textContent=e.message;}
 finally{giRunning=false;giControls();}
}
function giRenderHome(){
 giControls();const list=giRows();
 const valid=list.map(n=>({n,r:giResults.get(n.key)})).filter(x=>x.r?.status==='ok');
 $('giSummary').textContent=valid.length?`${valid.length} nights analyzed · mean GI ${fmt(valid.reduce((s,x)=>s+x.r.overall,0)/valid.length)} · minimum ${fmt(Math.min(...valid.map(x=>x.r.overall)))} · maximum ${fmt(Math.max(...valid.map(x=>x.r.overall)))}`:'No Glasgow results for this selection. Select a date range and analyze.';
 const keys=[['overall','Overall GI'],...Glasgow.COMPONENTS];
 const metric=$('giMetric').value||'overall';const label=keys.find(([k])=>k===metric)?.[1]||metric;
 const raw=list.map(n=>{const r=giResults.get(n.key);return {key:n.key,value:r?.status==='ok'?(metric==='overall'?r.overall:r.components[metric]):null};});
 const smoothed=Glasgow.movingMean(raw,'value',Number($('giSmooth').value));
 $('giTrend').replaceChildren();const maximum=Math.max(1,...smoothed.map(r=>r.smoothed||0));
 for(const row of smoothed){const box=el('div',undefined,'trendrow'),track=el('div',undefined,'track');if(Number.isFinite(row.smoothed)){const bar=el('div',undefined,'bar');bar.style.width=100*row.smoothed/maximum+'%';track.append(bar);}box.append(button(row.key,()=>openNight(row.key)),track,el('span',fmt(row.smoothed)));box.title=label+' · raw '+fmt(row.value);$('giTrend').append(box);}
 const headings=['Night','Analyzed h','Breaths','Overall GI',...Glasgow.COMPONENTS.map(x=>x[1]),'Mean IPAP','Mean EPAP','Δ mean P','Status'];
 const rows=list.map(n=>{const r=giResults.get(n.key),ipap=stats(n.channels['Press.2s'])?.mean,epap=stats(n.channels['EprPress.2s'])?.mean;return [button(n.key,()=>openNight(n.key)),fmt(r?.seconds/3600),r?.inspirations??'—',fmt(r?.overall),...Glasgow.COMPONENTS.map(([k])=>fmt(r?.components?.[k])),fmt(ipap),fmt(epap),Number.isFinite(ipap)&&Number.isFinite(epap)?fmt(ipap-epap):'—',r?.status==='ok'?(r.warnings.join(' ')||'Analyzed'):r?.reason||'Not analyzed'];});
 $('giTable').replaceChildren(table(headings,rows));$('giCSV').disabled=!valid.length;
}
function giRenderNight(){
 if(!night)return;giControls();const r=giResults.get(night.key);
 $('giNightStatus').textContent=r?.status==='ok'?`Overall GI ${fmt(r.overall)} · ${r.inspirations} inspirations · ${fmt(r.seconds/3600)} h analyzed of ${fmt(night.usage)} h use. ${r.warnings.join(' ')}`:r?.reason||'Not analyzed. Use “Analyze this night”.';
 $('giNightComponents').replaceChildren();
 if(r?.status==='ok')$('giNightComponents').append(table(['Component','Fraction of inspirations'],Glasgow.COMPONENTS.map(([k,label])=>[label,fmt(r.components[k])])));
 giDrawHeatmap();
}
function giDrawHeatmap(){
 const canvas=$('giHeatmap');if(!canvas||!night||$('detail').hidden)return;
 const result=giResults.get(night.key);canvas.hidden=result?.status!=='ok';if(canvas.hidden)return;
 const w=canvas.clientWidth;if(w<100)return;const h=320,dpr=devicePixelRatio||1;canvas.width=w*dpr;canvas.height=h*dpr;
 const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const x0=120,pw=Math.max(1,Math.floor(w-x0-18)),start=night.origin+left*1000,end=start+span*1000;
 const bins=Glasgow.heatBins(result,start,end,pw),keys=[['overall','Overall'],...Glasgow.COMPONENTS];
 ctx.font='11px system-ui';
 keys.forEach(([key,label],row)=>{const y=10+row*27;ctx.fillStyle='#425966';ctx.fillText(label,0,y+14);ctx.fillStyle='#eef2f4';ctx.fillRect(x0,y,pw,22);bins.forEach((bin,i)=>{if(!bin.count)return;const v=key==='overall'?bin.overall/9:bin[key];ctx.fillStyle=`rgba(105,56,170,${.08+.92*v})`;ctx.fillRect(x0+i,y,1,22);});});
 ctx.fillStyle='#425966';for(let i=0;i<5;i++)ctx.fillText(clock(start+(end-start)*i/4),Math.min(w-62,x0+pw*i/4),305);
 // Share timestamps, markers and cursor with the signal charts.
 const line=(t,color)=>{if(t<start||t>end)return;const x=x0+(t-start)/(end-start)*pw;ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(x,8);ctx.lineTo(x,280);ctx.stroke();};
 for(const m of annotations.filter(m=>m.night===night.key))line(m.time,'#ce4475');
 if(cursor!==null)line(night.origin+cursor*1000,'#253d4d');
}
function giExport(){
 const cols=['night','algorithm','analyzed_hours','inspirations','overall',...Glasgow.COMPONENTS.map(x=>x[0]),'mean_ipap','mean_epap','difference_mean_ipap_epap','warnings'];
 const rows=giRows().flatMap(n=>{const r=giResults.get(n.key);if(r?.status!=='ok')return [];const ipap=stats(n.channels['Press.2s'])?.mean,epap=stats(n.channels['EprPress.2s'])?.mean;return [[n.key,r.version,r.seconds/3600,r.inspirations,r.overall,...Glasgow.COMPONENTS.map(([k])=>r.components[k]),ipap??'',epap??'',Number.isFinite(ipap)&&Number.isFinite(epap)?ipap-epap:'',r.warnings.join(' ')]];});
 download(new Blob([[cols,...rows].map(row=>row.map(x=>'"'+String(x).replaceAll('"','""')+'"').join(',')).join('\n')],{type:'text/csv'}),'glasgow-nightly.csv');
}
$('giMetric').replaceChildren(...[['overall','Overall GI'],...Glasgow.COMPONENTS].map(([key,label])=>{const o=el('option',label);o.value=key;return o;}));
for(const id of ['giFrom','giTo','giHideShort','giMetric','giSmooth'])$(id).onchange=giRenderHome;
$('giAnalyze').onclick=()=>giAnalyze(giRows());$('giAnalyzeNight').onclick=()=>{if(night)giAnalyze([night]);};
$('giCancel').onclick=()=>{giEpoch++;if(giWorker){giWorker.terminate();giWorker=null;giReject?.(Error('Analysis cancelled. Completed nights are retained.'));giReject=null;}};
$('giCSV').onclick=giExport;
$('giHeatmap').onclick=e=>{if(!night)return;const r=e.currentTarget.getBoundingClientRect(),x=e.clientX-r.left;if(x<120)return;const f=Math.max(0,Math.min(1,(x-120)/(r.width-138)));jump(night.origin+(left+f*span)*1000);};
giRenderHome();
