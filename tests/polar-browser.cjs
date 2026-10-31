// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic end-to-end test: local PAP + Polar import, display and reload.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
(async()=>{
 const server=spawn('python3',['server.py','--browser-storage','--port','18789'],{cwd:root,stdio:'ignore'});let browser;
 try{
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:18789');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('No saved data'));
  await page.locator('#files').setInputFiles(path.join(root,'examples/PAP_SYNTHETIC_DEMO.edf'));await page.waitForFunction(()=>nights.length===1&&!busy);
  await page.locator('#yourNights summary').click();await page.locator('#nightList button').first().click();await page.locator('#polarZone').fill('UTC');
  const start=BigInt(await page.evaluate(()=>night.origin))*1000000n,ns=s=>String(start+BigInt(s)*1000000000n),f=(name,text)=>({name,mimeType:'text/plain',buffer:Buffer.from(text)});
  const data=[f('session.json',JSON.stringify({schema_version:1,time_zone:'UTC',start_unix_ns:ns(0),end_unix_ns:ns(600),device_id:'synthetic'})),f('000_ecg.csv',`timestamp_unix_ns,ecg_uv,connection_segment\n${ns(0)},100,1\n${ns(1)},-50,1\n`),f('000_hr.csv',`timestamp_unix_ns,hr_bpm\n${ns(0)},70\n${ns(1)},71\n`),f('000_rr.csv',`timestamp_unix_ns,rr_ms,screen_accepted\n${ns(0)},860,true\n${ns(1)},850,false\n`),f('000_hrv.csv',`window_start_unix_ns,window_end_unix_ns,rmssd_candidate_ms,usable_heuristic\n${ns(0)},${ns(300)},32,true\n`)];
  page.on('dialog',d=>d.accept());await page.locator('#polarFiles').setInputFiles(data);await page.waitForFunction(()=>document.querySelector('#polarStatus').textContent.includes('Polar signals loaded'),null,{timeout:30000});
  assert.equal(await page.evaluate(()=>external.filter(e=>e.polar).length),1);
  assert.equal(await page.locator('#charts [data-signal^="polar:"]').count(),4);
  assert.match(await page.locator('#stats').textContent(),/PolarPAP/);
  await page.reload();await page.waitForFunction(()=>nights.length===1);await page.locator('#nightBtn').click();await page.waitForFunction(()=>document.querySelector('#polarStatus').textContent.includes('Polar signals loaded'));
  assert.equal(await page.locator('#charts [data-signal^="polar:"]').count(),4);assert.deepEqual(errors,[]);
  console.log('PASS: synthetic Polar import, four charts and IndexedDB reload');
 }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
