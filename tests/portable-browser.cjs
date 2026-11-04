// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic browser exercise. BPG_BROWSER_PATH may point to a local Chromium.
const {chromium}=require('playwright');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{spawn}=require('child_process');
const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bpg-portable-ui-'));
const ports=[18971,18972],servers=[];let browser;
const errors=[];
async function ready(page,port){await page.goto(`http://127.0.0.1:${port}`);await page.waitForFunction(()=>!!Portable.token);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());}
async function saved(page){await page.waitForFunction(()=>!busy&&!Portable.analysisBusy&&!Portable.summaryBusy&&!Portable.saving&&!Portable.writing&&!Portable.state.dirty&&!Portable.state.operation&&!Portable.state.pending,{},{timeout:60000});}
async function confirmSync(page){await page.locator('#confirmSync').click();await page.waitForFunction(()=>Portable.writable);}
async function release(page){await saved(page);await page.evaluate(async()=>{await Portable.api('session/close',{});Portable.closed=true;Portable.writable=false;clearInterval(Portable.poll);clearTimeout(Portable.timer);});}
(async()=>{
 try{
  for(let i=0;i<ports.length;i++)servers.push(spawn('python3',['server.py','--port',String(ports[i]),'--data-dir',path.join(tmp,'mac-'+i),'--shared-dir',path.join(tmp,'shared')],{cwd:root,stdio:'ignore'}));
  browser=await chromium.launch({headless:true,executablePath:process.env.BPG_BROWSER_PATH||undefined,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-zygote']});
  const context=await browser.newContext({viewport:{width:1500,height:1100},acceptDownloads:true}),a=await context.newPage();
  await ready(a,ports[0]);assert.equal(await a.locator('#files').isDisabled(),true);
  // An unrelated IndexedDB archive must not supply the portable night's data.
  await a.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('pap-local-v2',1);r.onupgradeneeded=()=>r.result.createObjectStore('files',{keyPath:'id'});r.onsuccess=()=>{const tx=r.result.transaction('files','readwrite');tx.objectStore('files').put({id:'wrong-browser-archive'});tx.oncomplete=()=>{r.result.close();resolve();};};r.onerror=reject;}));
  await confirmSync(a);assert.equal(await a.evaluate(()=>files.length),0);
  await a.locator('#files').setInputFiles(path.join(root,'examples/PAP_SYNTHETIC_DEMO.edf'));
  await a.waitForFunction(()=>nights.length===1&&giGetNight(nights[0].key)?.status==='ok');await saved(a);
  assert.equal(await a.evaluate(()=>giCacheRecords.some(r=>r.id===nights[0].key)),true);assert.equal(await a.evaluate(()=>giCacheRecords.some(r=>r.id==='trend:'+nights[0].key)),true);
  const version1=await a.evaluate(()=>Portable.state.base),objectNames=fs.readdirSync(path.join(tmp,'shared','objects'));
  await a.locator('#files').setInputFiles(path.join(root,'examples/PAP_SYNTHETIC_DEMO.edf'));
  await a.waitForFunction(()=>document.getElementById('status').textContent.includes('1 unchanged'));await saved(a);
  assert.equal(await a.evaluate(()=>files.length),1);assert.deepEqual(fs.readdirSync(path.join(tmp,'shared','objects')),objectNames);
  const fullEDF=fs.readFileSync(path.join(root,'examples/PAP_SYNTHETIC_DEMO.edf')),headerLength=Number(fullEDF.subarray(184,192).toString()),emptyEDF=Buffer.from(fullEDF.subarray(0,headerLength));emptyEDF.fill(32,236,244);emptyEDF.write('-1',236,'ascii');
  await a.locator('#files').setInputFiles({name:'EMPTY_HEADER.edf',mimeType:'application/octet-stream',buffer:emptyEDF});await a.waitForFunction(()=>document.getElementById('status').textContent.includes('1 empty EDF skipped'));await saved(a);assert.equal(await a.evaluate(()=>files.length),1);assert.equal(await a.evaluate(()=>!!Portable.state.pending),false);
  await a.locator('#yourNights summary').click();await a.locator('#nightList button').first().click();
  await a.locator('#window').selectOption('600');await a.evaluate(()=>{left=Math.max(0,(total-span)/2);render();});
  const chart=a.locator('#charts canvas').first(),rect=await chart.boundingBox();
  const expected=await a.evaluate(({x})=>iso(night.origin+(left+Math.max(0,Math.min(1,(x-65)/(document.querySelector('#charts canvas').getBoundingClientRect().width-82)))*span)*1000),{x:Math.round(rect.width*.5)});
  await chart.dblclick({position:{x:Math.round(rect.width*.5),y:60}});assert.equal(await a.locator('#markerTime').inputValue(),expected);await a.locator('#cancelMarker').click();
  await a.locator('#addMarker').click();await a.locator('#markerTitle').fill('Synthetic observation');await a.locator('#markerNote').fill('First Mac');
  await a.locator('#markerMedia').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSFEAAAAASUVORK5CYII=','base64')});
  await a.locator('#markerForm button[type=submit]').click();await a.locator('#markerDialog').waitFor({state:'hidden'});await saved(a);
  // An updated file replaces its old active record and retains annotations.
  const updated=fs.readFileSync(path.join(root,'examples/PAP_SYNTHETIC_DEMO.edf')),header=Number(updated.subarray(184,192).toString());updated.writeInt16LE(updated.readInt16LE(header)+1,header);
  await a.locator('#homeBtn').click();await a.locator('#files').setInputFiles({name:'PAP_SYNTHETIC_DEMO.edf',mimeType:'application/octet-stream',buffer:updated});
  await a.waitForFunction(()=>document.getElementById('status').textContent.includes('1 updated'));await saved(a);assert.equal(await a.evaluate(()=>files.length),1);assert.equal(await a.evaluate(()=>annotations.length),1);
  await a.locator('#nightBtn').click();await a.locator('#polarZone').fill('UTC');
  const polarStart=BigInt(await a.evaluate(()=>night.origin))*1000000n,ns=n=>String(polarStart+BigInt(n)*1000000000n),f=(name,text)=>({name,mimeType:'text/plain',buffer:Buffer.from(text)});
  let beat=polarStart,rrText='timestamp_unix_ns,rr_ms,sensor_contact,screen_accepted,connection_segment\n';for(let i=0;i<1500;i++){const ms=800+(i*37%200);beat+=BigInt(ms)*1000000n;rrText+=`${beat},${ms},true,true,1\n`;}
  const polar=[f('session.json',JSON.stringify({schema_version:1,time_zone:'UTC',start_unix_ns:ns(0),end_unix_ns:ns(1800),device_id:'synthetic'})),f('000_ecg.csv',`timestamp_unix_ns,ecg_uv,connection_segment\n${ns(0)},100,1\n${ns(1)},-50,1\n`),f('000_hr.csv',`timestamp_unix_ns,hr_bpm\n${ns(0)},70\n${ns(1)},71\n`),f('000_rr.csv',rrText),f('000_hrv.csv',`window_start_unix_ns,window_end_unix_ns,rmssd_candidate_ms,usable_heuristic\n${ns(0)},${ns(300)},32,true\n`)];
  await a.locator('#polarFiles').setInputFiles(polar);await a.waitForFunction(()=>document.querySelector('#polarStatus').textContent.includes('Heart rate, R–R and HRV loaded'));await saved(a);
  let sleepBackup;
  if(process.env.BPG_SLEEP_PYTHON||process.env.BPG_TEST_SLEEP){
   await a.locator('#sleepCompute').click();await a.waitForFunction(()=>document.querySelector('#sleepStatus').textContent.includes('coverage'),null,{timeout:60000});await saved(a);assert.equal(await a.evaluate(()=>sleepStates[night.key].status),'available');
   await a.locator('#archivePanel details').last().locator('summary').click();await a.locator('#compressPolar').click();await a.waitForFunction(()=>document.querySelector('#archiveMessage').textContent.includes('Compressed and verified'),null,{timeout:60000});await saved(a);
   const restoredECG=await a.evaluate(async()=>{const r=external.find(e=>e.polar).blobs['000_ecg.csv'];if(!r.__deflateChunks)throw Error('ECG not compressed');return (await portableDecode(r)).text();});assert.equal(restoredECG,polar[1].buffer.toString());
   await a.locator('#polarFiles').setInputFiles(polar);await a.waitForFunction(()=>document.querySelector('#polarStatus').textContent.includes('already imported'));assert.equal(await a.evaluate(()=>external.filter(e=>e.polar).length),1);
   await a.locator('#archiveBtn').click();const request=a.waitForEvent('download');await a.locator('#backup').click();await a.locator('#exportSave').click();sleepBackup=path.join(tmp,'sleep-backup.json');await (await request).saveAs(sleepBackup);await a.locator('#exportClose').click();
   const backup=JSON.parse(fs.readFileSync(sleepBackup));assert.ok(backup.data.analysis.some(r=>r.id.startsWith('sleep:')));assert.ok(backup.data.analysis.some(r=>!r.id.startsWith('sleep:')));
  }
  const expectedSavedMean=await a.evaluate(()=>stat(nights[0],'Flow.40ms')?.mean);
  await release(a);
  const b=await context.newPage(),blobRequests=[],rangeRequests=[],indexRequests=[],sleepRequests=[];b.on('request',request=>{if(request.url().endsWith('/api/ecg-index'))indexRequests.push(request.url());if(request.url().endsWith('/api/sleep-compute'))sleepRequests.push(request.url());if(request.url().includes('/api/blob/')){blobRequests.push(request.url());if(request.headers().range)rangeRequests.push(request.headers().range);}});
  await ready(b,ports[1]);await b.waitForFunction(()=>nights.length===1);assert.equal(await b.evaluate(()=>annotations[0].note),'First Mac');assert.equal(await b.evaluate(()=>trendSummaries.has(nights[0].key)),true);assert.equal(await b.evaluate(()=>stat(nights[0],'Flow.40ms')?.mean),expectedSavedMean);
  const markerRef=await b.evaluate(()=>annotations[0].media[0].blob.__ref);assert.equal(blobRequests.some(url=>url.endsWith('/'+markerRef)),false,'Trend must not read marker media');
  if(process.env.BPG_SLEEP_PYTHON||process.env.BPG_TEST_SLEEP){const state=await b.evaluate(()=>sleepStates[nights[0].key]);assert.equal(state.status,'available');assert.ok(state.result.epochs.length>0);}
  const ecgRef=await b.evaluate(()=>(external.find(e=>e.polar).blobs['000_ecg.csv'].__deflateChunks?.[0]||external.find(e=>e.polar).blobs['000_ecg.csv']).__ref);assert.equal(blobRequests.some(url=>url.endsWith('/'+ecgRef)),false,'Trend must not read ECG');
  await b.locator('#nightBtn').click();await b.waitForFunction(()=>document.querySelector('#polarStatus').textContent.includes('Heart rate, R–R and HRV loaded'));assert.equal(blobRequests.some(url=>url.endsWith('/'+ecgRef)),false,'Night summary must not read ECG');
  if(process.env.BPG_SLEEP_PYTHON||process.env.BPG_TEST_SLEEP){assert.equal(await b.locator('#sleepChart').isVisible(),true);assert.equal(sleepRequests.length,0,'Opening saved sleep stages must not run inference');assert.equal(blobRequests.some(url=>url.endsWith('/'+ecgRef)),false,'Sleep display must not read ECG');}
  await b.locator('#prepareECGOverview').click();await b.waitForFunction(()=>document.querySelector('#polarStatus').textContent.includes('ECG overview ready'));assert.equal(await b.locator('#polarOverview').isVisible(),true);if(process.env.BPG_SLEEP_PYTHON||process.env.BPG_TEST_SLEEP)assert.equal(fs.existsSync(path.join(tmp,'mac-1','blobs',ecgRef)),false,'Published overview index must not hydrate ECG');
  await b.evaluate(()=>{left=0;span=Math.min(120,total);render();});await b.locator('#loadPolarECGWindow').click();await b.waitForFunction(()=>document.querySelector('#polarStatus').textContent.includes('ECG window loaded'));
  assert.ok(blobRequests.some(url=>url.endsWith('/'+ecgRef)),'ECG window requests relevant data');assert.equal(await b.evaluate(()=>{const c=Object.values(channels).find(c=>c.polarType==='ecg');return c?.partial&&sample(c,night.origin)?.v;}),100);
  const initialIndexRequests=indexRequests.length;assert.ok(initialIndexRequests>0);
  await b.evaluate(()=>{left=30;render();});await b.waitForFunction(()=>Object.values(channels).some(c=>c.polarType==='ecg'&&c.partial&&c.partialStart===night.origin+30000));assert.equal(indexRequests.length,initialIndexRequests,'Panning reuses the verified ECG index');
  await b.locator('#loadPolarECG').click();await b.waitForFunction(()=>document.querySelector('#polarStatus').textContent.includes('Polar signals loaded'));assert.equal(blobRequests.some(url=>url.endsWith('/'+ecgRef)),true,'Explicit ECG request reads the original');
  assert.equal(await b.evaluate(async()=>(await portableDecode(annotations[0].media[0].blob)).size>0),true);
  await confirmSync(b);
  if(sleepBackup){await b.locator('#archiveBtn').click();await b.locator('#restore').setInputFiles(sleepBackup);await b.waitForFunction(()=>Portable.state.preview&&!busy);await b.locator('#acceptRestore').click();await saved(b);assert.equal(await b.evaluate(()=>sleepStates[nights[0].key].status),'available');assert.equal(sleepRequests.length,0);}
  await b.evaluate(async()=>{const m=annotations[0];m.note='Second Mac';await put('markers',m);});await saved(b);await release(b);
  await a.reload();await a.waitForFunction(()=>Portable.token&&annotations[0]?.note==='Second Mac');await confirmSync(a);await saved(a);
  // Confirm that cached GI opens without constructing another worker.
  await a.evaluate(()=>{window.workerCount=0;window.OriginalWorker=Worker;window.Worker=class extends OriginalWorker{constructor(...args){super(...args);workerCount++;}};});
  await a.evaluate(()=>refresh());await saved(a);assert.equal(await a.evaluate(()=>workerCount),0);
  await a.locator('#yourNights summary').click();await a.locator('#nightList button').first().click();
  await a.locator('#deleteNight').click();await a.locator('#deleteNightConfirm').click();await a.waitForFunction(()=>nights.length===0&&!busy);await saved(a);
  await a.locator('#files').setInputFiles(path.join(root,'examples/PAP_SYNTHETIC_DEMO.edf'));await a.waitForFunction(()=>!busy&&files.length===1);await saved(a);assert.equal(await a.evaluate(()=>nights.length),0);
  await a.locator('#archivePanel details').last().locator('summary').click();await a.locator('#allowReimport').click();await a.locator('#deletedNights button').click();await a.waitForFunction(()=>nights.length===1);await saved(a);
  await a.locator('#archiveBtn').click();const download=a.waitForEvent('download');await a.locator('#backup').click();await a.locator('#exportSave').click();const backupFile=path.join(tmp,'complete-backup.json');await (await download).saveAs(backupFile);await a.locator('#exportClose').click();
  const backup=JSON.parse(fs.readFileSync(backupFile));assert.equal(backup.format,'bpg-backup-v3');assert.equal(backup.data.markers.length,0);
  await a.evaluate(async()=>{await put('markers',{id:'extra',night:nights[0].key,time:nights[0].origin,title:'Must disappear',note:'extra',media:[]});await refresh();});await saved(a);
  const corrupt={...backup,data:{...backup.data,markers:[]}};corrupt.data.files=[];const corruptFile=path.join(tmp,'corrupt-backup.json');fs.writeFileSync(corruptFile,JSON.stringify(corrupt));
  await a.locator('#restore').setInputFiles(corruptFile);await a.waitForFunction(()=>document.getElementById('status').textContent.includes('checksum failed'));assert.equal(await a.evaluate(()=>annotations.length),1);assert.equal(await a.evaluate(()=>!!Portable.state.pending),false);
  await a.locator('#restore').setInputFiles(backupFile);await a.waitForFunction(()=>Portable.state.preview&&!busy);assert.equal(await a.evaluate(()=>annotations.length),0);assert.equal(await a.locator('#files').isDisabled(),true);
  await a.locator('#acceptRestore').click();await saved(a);assert.equal(await a.evaluate(()=>annotations.length),0);
  await a.locator('#loadVersions').click();await a.waitForFunction(()=>document.querySelectorAll('#versionSelect option').length>2);
  await a.locator('#versionSelect').selectOption(version1);await a.locator('#restoreVersion').click();await a.waitForFunction(()=>!busy);await saved(a);assert.equal(await a.evaluate(()=>annotations.length),0);
  // Closing an ordinary read/write tab releases its edit session on pagehide.
  const departure=await context.newPage();await ready(departure,ports[1]);await confirmSync(departure);await saved(departure);await departure.goto('about:blank');
  const reopened=await context.newPage();await ready(reopened,ports[1]);await confirmSync(reopened);await release(reopened);
  assert.deepEqual(errors,[]);await a.screenshot({path:path.join(tmp,'portable.png'),fullPage:true});
  await a.locator('#saveClose').click();await new Promise(r=>setTimeout(r,300));if(!a.isClosed())assert.equal(await a.evaluate(()=>Portable.closed),true);
  console.log('PASS: portable source isolation, confirmation, grouped delta, GI cache, media, two Macs, deletion/reimport, complete backup preview/replacement, history, save and close.');console.log('Synthetic test artifacts:',tmp);
 }finally{if(browser)await browser.close();for(const p of servers){p.kill();}}
})().catch(e=>{console.error(e);process.exitCode=1;});
