// SPDX-License-Identifier: GPL-3.0-or-later
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../web/philips.js'),C=require('../web/core.js'),I=require('../web/import-files.js');
const {chunk,summary,eventFile,start,le,props,file}=require('./philips-fixtures.js');
const parse=(bytes,ext)=>P.parse(bytes,'0000002A.'+ext);
const record=parsed=>({parsed,imported:0});
test('properties normalize short/long keys and reject unsupported or unidentified devices',()=>{
 assert.equal(P.properties(props).model,'500X150');assert.equal(P.properties(props).tags.SRN,'SYNTHETIC-DEVICE');
 assert.equal(P.properties(props.replace('FV=6','FamilyVersion=6')).familyVersion,6);
 assert.throws(()=>P.properties(props.replace('FV=6','FV=3')),/Unsupported/);
 assert.throws(()=>P.properties(props.replace('SN=SYNTHETIC-DEVICE','SN=')),/identity/);
});
test('summary decodes CPAP settings and uses mask-on duration rather than elapsed equipment time',()=>{
 const p=parse(summary(),'001'),s=p.sessions[0];assert.equal(s.id,42);assert.equal(s.settings.Mode,'CPAP');assert.equal(s.settings.Pressure,9);assert.equal(s.settings.FlexMode,'C-Flex+');assert.equal(s.settings.RampMinutes,20);
 assert.deepEqual(s.intervals,[[(start+10)*1000,(start+130)*1000]]);assert.equal(p.duration,135);
 const n=C.buildNights([record(p)]).nights[0];assert.equal(n.usage,120/3600);assert.equal(n.eventsComplete,false);assert.equal(Object.keys(n.channels).length,0);
});
test('events use report delay as offset, not an invented apnea duration; spans have start and duration',()=>{
 const p=parse(eventFile(),'002');assert.deepEqual(p.events.map(e=>[e.text,(e.time-start*1000)/1000,e.duration]),[['Obstructive apnea',23,0],['Clear airway apnea',45,0],['Hypopnea',57,0],['Periodic breathing',70,8]]);
 assert.deepEqual(p.eventCoverage,[[start*1000,(start+120)*1000]]);
 assert.equal(p.signals.find(s=>s.label==='PRS1.TotalLeak').values[0],25);
 assert.equal(p.signals.find(s=>s.label==='PRS1.FlexPressure').values[0],8);
 assert(!p.signals.some(s=>s.label==='Leak.2s'||s.label==='FlowLim.2s'));
});
test('waveform is signed 5 Hz L/min, contiguous blocks merge; clock gaps remain',()=>{
 const a=chunk(5),b=chunk(5,[],{start:start+2}),c=chunk(5,[],{start:start+10});
 const p=parse(Buffer.concat([a,b,c]),'005');assert.equal(p.signals.length,2);assert.equal(p.signals[0].dt,.2);assert.equal(p.signals[0].unit,'L/min');assert(p.signals[0].values instanceof Int8Array);assert.equal(p.signals[0].values.length,20);assert.deepEqual(Array.from(p.signals[0].values.slice(0,5)),[-128,-1,0,1,127]);
});
test('checksums, lengths, unsupported record codes and empty data fail closed',()=>{
 const original=eventFile();for(const [offset,message] of [[7,/checksum/],[original.length-5,/CRC/]]){const b=Buffer.from(original);b[offset]^=1;assert.throws(()=>parse(b,'002'),message);}
 assert.throws(()=>parse(original.subarray(0,-1),'002'),/truncated/);
 assert.throws(()=>parse(Buffer.alloc(0),'002'),/Empty/);
 assert.throws(()=>parse(chunk(2,[[0x30,[0,0,0]]]),'002'),/Unsupported Philips event/);
 assert.throws(()=>parse(original,'001'),/mismatch/);
 const short=chunk(2,[[6,[0,0]]]);assert.throws(()=>parse(short,'002'),/Invalid Philips record/);
});
test('coverage and use union overlapping summaries; missing session events never become zero AHI',()=>{
 const s=parse(summary({on:0,use:120}),'001'),e=parse(eventFile(),'002');let n=C.buildNights([record(s),record(s),record(e)]).nights[0];
 assert.equal(n.usage,120/3600);assert.equal(n.eventsComplete,true);assert.equal(n.events.length,4);assert.equal(n.sessionSettings.length,1);
 n=C.buildNights([record(s),record(e),record(parse(summary({start:start+3600,id:43,on:0,use:120}),'001'))]).nights[0];assert.equal(n.eventsComplete,false);assert.equal(n.eventCoverageSeconds,120);
});
test('noon splitting and deletion preserve other-day intervals, waveform types and settings',()=>{
 const noon=Date.UTC(2024,0,2,12)/1000;
 const s=parse(summary({start:noon-60,on:0,use:120}),'001');const nights=C.buildNights([record(s)]).nights;assert.equal(nights.length,2);assert.deepEqual(nights.map(n=>n.usage),[1/60,1/60]);
 const removed=C.removeNightFromParsed(s,'2024-01-01');assert(removed.affected);const kept=C.buildNights(removed.parts.map(record)).nights;assert.equal(kept.length,1);assert.equal(kept[0].key,'2024-01-02');assert.equal(kept[0].settings.Pressure,9);
 const wave=parse(chunk(5,[],{start:noon-1}),'005');const w=C.removeNightFromParsed(wave,'2024-01-01').parts[0];assert(w.signals[0].values instanceof Int8Array);assert.equal(w.signals[0].values.length,5);
});
test('interval samples cross noon accurately and are weighted by actual duration',()=>{
 const noon=Date.UTC(2024,0,2,12),p={start:noon-30000,duration:120,signals:[{label:'PRS1.TotalLeak',unit:'L/min',step:true,start:noon-30000,dt:120,values:Float64Array.of(20)}],events:[],vendor:'Philips'};
 const n=C.buildNights([record(p)]).nights;assert.deepEqual(n.map(n=>n.channels['PRS1.TotalLeak'].segments[0].dt),[30,90]);
 const ch={unit:'L/min',segments:[{start:0,step:true,dt:110,values:Float64Array.of(10)},{start:110000,step:true,dt:10,values:Float64Array.of(100)}]};assert.equal(C.stats(ch).med,10);assert.equal(C.stats(ch).mean,17.5);assert.equal(C.sample(ch,109999).v,10);
});
test('device preflight accepts folder and loose files, filters macOS metadata, rejects mixed devices before saving',async()=>{
 const list=[file('PROP.TXT',props,'P-SERIES/DEVICE/PROP.TXT'),file('0000002A.001',summary(),'P-SERIES/DEVICE/P0/0000002A.001'),file('._0000002A.001','garbage','__MACOSX/P-SERIES/._0000002A.001')];
 const r=await I.prepare(list);assert.equal(r.plan.length,2);assert.equal(r.ignoredCount,1);assert.equal(r.plan[1].device.serial,'SYNTHETIC-DEVICE');
 assert.equal((await I.prepare([file('PROP.TXT',props),file('0000002A.001',summary())])).plan.length,2);
 await assert.rejects(()=>I.prepare([list[1]]),/PROP.TXT/);
 await assert.rejects(()=>I.prepare(list,[{tags:{SRN:'OTHER'}}]),/one PAP device/);
 await assert.rejects(()=>I.prepare([...list,file('BRP.edf','dummy')]),/one PAP device/);
 await assert.rejects(()=>I.prepare([file('PROP.BIN','dummy')]),/Encrypted DreamStation 2/);
});
test('backup preflight prevents restoring a second vendor or serial into the archive',()=>{
 assert.throws(()=>I.validateArchive([{device:{vendor:'Philips',serial:'A'}},{name:'BRP.edf'}]),/one PAP device/);
 assert.throws(()=>I.validateArchive([{tags:{SRN:'A'}},{tags:{SRN:'B'}}]),/one PAP device/);
 assert.doesNotThrow(()=>I.validateArchive([{device:{vendor:'Philips',serial:'A'}},{tags:{SRN:'A'}}]));
});
test('flow-only nights have useful charts but cannot claim complete therapy AHI',()=>{
 const n=C.buildNights([record(parse(chunk(5),'005')),record(parse(eventFile(),'002'))]).nights[0];assert.equal(n.eventsComplete,false);
});
test('deleting a middle day preserves both retained pieces of a long summary session',()=>{
 const t=Date.UTC(2024,0,1,13),session={id:42,start:t,end:t+3*86400000,intervals:[[t,t+3*86400000]],settings:{Mode:'CPAP'},rawSettings:{}};
 const p={vendor:'Philips',start:t,duration:3*86400,signals:[],events:[],sessions:[session],eventCoverage:[]};
 const result=C.removeNightFromParsed(p,'2024-01-02'),n=C.buildNights(result.parts.map(record)).nights;
 assert.deepEqual(n.map(x=>x.key),['2024-01-01','2024-01-03','2024-01-04']);assert.equal(n.reduce((a,n)=>a+n.usage,0),48);
});
