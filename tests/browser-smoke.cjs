// SPDX-License-Identifier: GPL-3.0-or-later
// Run the app server, then: node tests/browser-smoke.cjs
const {chromium}=require('playwright');
const fs=require('fs'),assert=require('assert');
const scratch=fs.mkdtempSync(require('path').join(require('os').tmpdir(),'pap-gi-smoke-'));
const artifact=name=>require('path').join(scratch,name);
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto('http://127.0.0.1:8765');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('No saved data'));
 await page.locator('#files').setInputFiles(require('path').resolve(__dirname,'../examples/PAP_SYNTHETIC_DEMO.edf'));
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('1 nights available'));
 await page.locator('#giAnalyze').click();await page.waitForFunction(()=>document.querySelector('#giStatus').textContent.startsWith('Analysis complete'));
 assert((await page.locator('#giSummary').textContent()).includes('1 nights analyzed'));
 const result=await page.evaluate(()=>giGetNight('2024-01-01'));assert.equal(result.status,'ok');assert.equal(result.seconds,1800);console.log('Browser worker result:',result.overall,result.inspirations);
 await page.locator('#giCSV').click();assert.equal(await page.locator('#exportName').textContent().then(s=>s.split(' · ')[0]),'glasgow-nightly.csv');
 const csvDownload=page.waitForEvent('download');await page.locator('#exportSave').click();await (await csvDownload).saveAs(artifact('glasgow-nightly.csv'));await page.locator('#exportClose').click();
 assert(fs.readFileSync(artifact('glasgow-nightly.csv'),'utf8').includes('2024-01-01'));
 await page.locator('#nightList button').first().click();await page.locator('#giHeatmap').waitFor({state:'visible'});
 await page.locator('#window').selectOption('120');const before=await page.locator('#range').textContent();await page.locator('#giHeatmap').click({position:{x:400,y:30}});const after=await page.locator('#range').textContent();assert.notEqual(before,after);
 await page.locator('#addMarker').click();await page.locator('#markerTitle').fill('Synthetic GI check');await page.locator('#markerNote').fill('No personal data');await page.locator('#markerForm button[type=submit]').click();await page.locator('#markerDialog').waitFor({state:'hidden'});assert((await page.locator('#markers').textContent()).includes('Synthetic GI check'));
 await page.locator('#pdf').click();await page.locator('#exportDialog').waitFor({state:'visible'});const pdfDownload=page.waitForEvent('download');await page.locator('#exportSave').click();await (await pdfDownload).saveAs(artifact('glasgow-report.pdf'));assert(fs.readFileSync(artifact('glasgow-report.pdf')).subarray(0,8).toString().startsWith('%PDF-1.4'));await page.locator('#exportClose').click();
 await page.screenshot({path:artifact('glasgow-night.png'),fullPage:true});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('1 nights'));assert.equal(await page.evaluate(()=>giGetNight('2024-01-01')),undefined);
 await page.locator('#giAnalyze').click();await page.waitForFunction(()=>document.querySelector('#giStatus').textContent.startsWith('Analysis complete'));
 await page.locator('#nightList button').first().click();await page.locator('#deleteNight').click();await page.locator('#deleteNightConfirm').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('deleted from'));assert.equal(await page.evaluate(()=>giGetNight('2024-01-01')),undefined);assert((await page.locator('#giSummary').textContent()).includes('No Glasgow results'));
 assert.deepEqual(errors,[]);console.log('Import, worker, CSV, synced heatmap, marker, PDF, reload and night deletion: passed.');await browser.close();fs.rmSync(scratch,{recursive:true,force:true});
})().catch(e=>{console.error(e);process.exit(1);});
