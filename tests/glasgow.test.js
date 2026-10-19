// SPDX-License-Identifier: GPL-3.0-or-later
const test=require('node:test'),assert=require('node:assert/strict');
const {analyzeChannel,COMPONENTS,movingMean,heatBins}=require('../web/glasgow.js');
// Golden values obtained from unmodified upstream FlowLimits.js at
// 7529ae400f0c8cc680c0c9c2aec2552c1dbbb88a (not recomputed by the adapter).
const GOLDEN=[
 {count:71,components:{skew:0,spike:0,flatTop:0,topHeavy:0,multiPeak:0,noPause:.99,inspirRate:0,multiBreath:.01,ampVar:0}},
 {count:71,components:{skew:0,spike:0,flatTop:1,topHeavy:1,multiPeak:0,noPause:.99,inspirRate:0,multiBreath:.01,ampVar:0}},
 {count:115,components:{skew:0,spike:0,flatTop:0,topHeavy:0,multiPeak:0,noPause:.99,inspirRate:.95,multiBreath:.01,ampVar:0}}
];
const start=Date.UTC(2024,0,1,22);
function wave(seconds=300,kind=0){return Float64Array.from({length:seconds*25},(_,i)=>{const t=i/25,p=2*Math.PI*t/(kind===2?2.6:4.2),v=Math.sin(p);return v>=0?(kind===1?Math.min(.38,.65*v):.43*v*(1+.12*Math.sin(t/9))):.43*v;});}
function channel(values=wave(),unit='L/s',dt=.04){return {unit,segments:[{start,dt,values}]};}
test('25 Hz analysis reports nine fractions, finite GI and correct time span',()=>{
 const r=analyzeChannel(channel());assert.equal(r.status,'ok');assert.equal(r.seconds,300);assert(r.inspirations>60);
 assert.equal(Object.keys(r.components).length,9);assert.equal(r.overall,Math.round(COMPONENTS.reduce((s,[k])=>s+r.components[k],0)*100)/100);
 for(const v of Object.values(r.components))assert(v>=0&&v<=1);
 assert(r.sessions[0].breaths.every(b=>b.time>=start&&b.end<start+300000));
});
test('unit conversion L/s and L/min gives identical components and breaths',()=>{
 const a=wave(),b=Float64Array.from(a,x=>x*60);
 assert.deepEqual(analyzeChannel(channel(a)),analyzeChannel(channel(b,'L/min')));
});
test('matches golden outputs from unmodified upstream for three waveforms',()=>{
 for(const kind of [0,1,2]){
  const r=analyzeChannel(channel(wave(300,kind)));
  assert.deepEqual(r.components,GOLDEN[kind].components);
  assert.equal(r.inspirations,GOLDEN[kind].count);
 }
 // The flat waveform contributes Top Heavy: our nine-component total is 3,
 // while the legacy eight-component prepIndices total is 2.
 assert.equal(analyzeChannel(channel(wave(300,1))).overall,3);
});
test('no data, flat signals and short runs stay unavailable, never a perfect GI',()=>{
 for(const ch of [null,channel(new Float64Array(1000)),channel(new Float64Array(1000).fill(.5)),channel(new Float64Array(20)),channel(Float64Array.of(NaN,NaN))]){
  const r=analyzeChannel(ch);assert.equal(r.status,'unavailable');assert.equal(r.overall,undefined);
 }
});
test('unsupported rate and units are rejected instead of silently resampled',()=>{
 assert.equal(analyzeChannel(channel(wave(),'L/s',.02)).status,'unavailable');
 assert.equal(analyzeChannel(channel(wave(),'mystery')).status,'unavailable');
});
test('NaN runs and recording gaps are independent and retain absolute time',()=>{
 const a=wave(60),b=wave(120,1),ch={unit:'L/s',segments:[{start,dt:.04,values:a},{start:start+300000,dt:.04,values:b}]};
 const r=analyzeChannel(ch);assert.equal(r.seconds,180);assert.equal(r.sessions.length,2);
 assert.equal(r.sessions[1].start,start+300000);
 assert(r.sessions[1].breaths.every(x=>x.time>=start+300000));
 const joined=new Float64Array(a.length+100+b.length);joined.set(a);joined.fill(NaN,a.length,a.length+100);joined.set(b,a.length+100);
 const split=analyzeChannel(channel(joined));assert.equal(split.seconds,180);assert.equal(split.sessions.length,2);
 for(const [k] of COMPONENTS){const expected=Math.round((r.sessions[0].components[k]*60+r.sessions[1].components[k]*120)/180*100)/100;assert.equal(r.components[k],expected);}
});
test('heatmap excludes recording gaps and aggregates actual flagged breaths',()=>{
 const r=analyzeChannel(channel()),bins=heatBins(r,start,start+600000,20);
 assert.equal(bins.reduce((s,b)=>s+b.count,0),r.inspirations);
 assert(bins.slice(10).every(b=>b.count===0));
 for(const bin of bins)if(bin.count)assert(Math.abs(bin.overall-COMPONENTS.reduce((s,[k])=>s+bin[k],0))<1e-9);
});
test('moving means use calendar days and omit missing values',()=>{
 const rows=[{key:'2024-01-01',value:1},{key:'2024-01-02',value:null},{key:'2024-01-10',value:3}];
 assert.deepEqual(movingMean(rows,'value',3).map(r=>r.smoothed),[1,null,3]);
});
