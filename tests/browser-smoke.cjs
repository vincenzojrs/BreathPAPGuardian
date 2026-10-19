// SPDX-License-Identifier: GPL-3.0-or-later
// npm install --no-save playwright; npx playwright install chromium
// node tests/browser-smoke.cjs (starts the local server itself)
const {chromium}=require('playwright');
const fs=require('fs'),assert=require('assert/strict'),path=require('path'),{spawn}=require('child_process');
const scratch=fs.mkdtempSync(path.join(require('os').tmpdir(),'bpg-ui-'));
const root=path.resolve(__dirname,'..');
(async()=>{
 const server=spawn('python3',['server.py'],{cwd:root,stdio:'ignore'});let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.BPG_BROWSER_PATH||undefined,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8765');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('No saved data'));
  assert.equal(await page.title(),'BreathPAPGuardian');assert.equal(await page.locator('h1').textContent(),'BreathPAPGuardian');assert.equal(await page.locator('#giPanel').count(),0);
  await page.locator('#files').setInputFiles(path.join(root,'examples/PAP_SYNTHETIC_DEMO.edf'));
  await page.waitForFunction(()=>document.querySelector('#giStatus').textContent.startsWith('Glasgow analysis complete'));
  const result=await page.evaluate(()=>giGetNight('2024-01-01'));assert.equal(result.status,'ok');assert.equal(result.seconds,1800);
  await page.locator('[data-series="gi:flatTop"]').check();assert.equal(await page.locator('#trendChoices input:checked').count(),3);
  await page.locator('[data-series="usage"]').uncheck();assert.equal(await page.locator('#trendChoices input:checked').count(),2);
  await page.locator('#yourNights summary').click();assert.equal(await page.locator('#nightList').isVisible(),false);await page.locator('#yourNights summary').click();
  await page.locator('#giCSV').click();const csv=page.waitForEvent('download');await page.locator('#exportSave').click();await (await csv).saveAs(path.join(scratch,'gi.csv'));await page.locator('#exportClose').click();assert(fs.readFileSync(path.join(scratch,'gi.csv'),'utf8').includes('2024-01-01'));
  await page.locator('#nightList button').first().click();await page.locator('#giHeatmap').waitFor({state:'visible'});assert((await page.locator('#giNightStatus').textContent()).includes('Mean GI'));
  assert((await page.locator('#stats').textContent()).includes('GI · nightly index'));assert((await page.locator('#stats').textContent()).includes('GI · flags per inspiration'));assert.equal(await page.evaluate(()=>giStatisticRows().length),11);
  // Exercise the native drag data path and keyboard-accessible alternative.
  await page.setViewportSize({width:1400,height:4000});
  await page.locator('[data-signal="glasgow"] .drag-handle').dragTo(page.locator('[data-signal="Flow.40ms"] .head'));
  await page.setViewportSize({width:1400,height:1000});
  assert.equal(await page.locator('#charts>.chart').first().getAttribute('data-signal'),'glasgow');
  await page.locator('[data-signal="glasgow"] button[aria-label="Move signal down"]').click();assert.equal(await page.locator('#charts>.chart').nth(1).getAttribute('data-signal'),'glasgow');
  await page.getByLabel('Glasgow Index',{exact:true}).uncheck();assert.equal(await page.locator('#giNightPanel').count(),0);await page.getByLabel('Glasgow Index',{exact:true}).check();
  await page.locator('#window').selectOption('120');const before=await page.locator('#range').textContent();await page.locator('#giHeatmap').click({position:{x:950,y:30}});assert.notEqual(before,await page.locator('#range').textContent());
  await page.locator('#addMarker').click();await page.locator('#markerTitle').fill('Synthetic marker');await page.locator('#markerForm button[type=submit]').click();await page.locator('#markerDialog').waitFor({state:'hidden'});
  // Inspect the canvases passed to the actual PDF encoder, not just its header.
  await page.evaluate(()=>{window.pdfCapture=[];const original=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(source,...args){if(source.id==='giHeatmap')window.pdfCapture.push(source.toDataURL());return original.call(this,source,...args);};});
  for(const mode of ['classic','custom']){
   await page.locator('#giChartMode').selectOption(mode);
   if(mode==='custom'){await page.locator('#giNightPanel [data-series="flatTop"]').uncheck();await page.locator('#giNightPanel [data-series="spike"]').check();}
   const expected=await page.locator('#giHeatmap').evaluate(c=>c.toDataURL());await page.locator('#pdf').click();await page.locator('#exportDialog').waitFor({state:'visible'});
   assert.equal(await page.evaluate(()=>window.pdfCapture.at(-1)),expected);
   const pdf=page.waitForEvent('download');await page.locator('#exportSave').click();await (await pdf).saveAs(path.join(scratch,mode+'.pdf'));assert(fs.readFileSync(path.join(scratch,mode+'.pdf')).subarray(0,8).toString().startsWith('%PDF-1.4'));await page.locator('#exportClose').click();
  }
  await page.reload();await page.waitForFunction(()=>document.querySelector('#giStatus').textContent.startsWith('Glasgow analysis complete'));assert.equal(await page.evaluate(()=>giGetNight('2024-01-01').status),'ok');
  await page.locator('#nightList button').first().click();assert.equal(await page.locator('#charts>.chart').nth(1).getAttribute('data-signal'),'glasgow');
  await page.locator('#deleteNight').click();await page.locator('#deleteNightConfirm').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('deleted from'));assert.equal(await page.evaluate(()=>giGetNight('2024-01-01')),undefined);assert.deepEqual(errors,[]);
  // Render the self-contained preview with its own synthetic archive.
  await page.goto('file://'+path.join(root,'docs/glasgow-preview.html'));await page.waitForFunction(()=>document.querySelector('#giStatus').textContent.includes('8/8'));
  await page.locator('[data-series="mean:Press.2s"]').check();await page.locator('#drop').evaluate(e=>e.hidden=true);await page.screenshot({path:path.join(root,'docs/preview-trends.png'),fullPage:true});
  await page.locator('#nightList button').first().click();await page.evaluate(()=>moveSignal('glasgow',orderedSignals()[0]));await page.locator('#window').selectOption('600');
  await page.locator('#giNightPanel').screenshot({path:path.join(root,'docs/preview-classic.png')});await page.locator('#giChartMode').selectOption('custom');await page.locator('#giNightPanel').screenshot({path:path.join(root,'docs/preview-custom.png')});
  assert.deepEqual(errors,[]);console.log('PASS: automatic import/reload analysis; toggles; collapse; DnD/order persistence; both chart modes; PDF exact chart capture; markers; CSV; deletion; offline preview.');console.log('Test PDF files:',scratch);
 }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
