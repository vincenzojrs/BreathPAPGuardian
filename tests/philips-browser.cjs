// SPDX-License-Identifier: GPL-3.0-or-later
// Optional browser integration: npm install --no-save playwright
// BPG_BROWSER_PATH=/path/to/chromium node tests/philips-browser.cjs
// Only synthetic fixtures are generated. No real recordings are included.
const {chromium}=require('playwright');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {chunk,summary,eventFile,props}=require('./philips-fixtures.js');
const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bpg-philips-'));
const fixture=path.join(tmp,'card'),device=path.join(fixture,'P-SERIES','SYNTHETIC');fs.mkdirSync(path.join(device,'P0'),{recursive:true});
fs.writeFileSync(path.join(device,'PROP.TXT'),props);
fs.writeFileSync(path.join(device,'P0','0000002A.001'),summary({on:0,use:120}));
fs.writeFileSync(path.join(device,'P0','0000002A.002'),eventFile());
fs.writeFileSync(path.join(device,'P0','0000002A.005'),chunk(5,[],{samples:Array.from({length:600},(_,i)=>Math.round(35*Math.sin(i*Math.PI/10)))}));
const zip=path.join(tmp,'card.zip');
const zipped=spawnSync('python3',['-c',"import pathlib,zipfile,sys\nr=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:\n for p in r.rglob('*'):\n  if p.is_file():z.write(p,p.relative_to(r).as_posix())",fixture,zip]);assert.equal(zipped.status,0,zipped.stderr.toString());
async function ready(page){await page.waitForFunction(()=>typeof db!=='undefined'&&!!db&&!busy);}
async function imported(page){await page.waitForFunction(()=>!busy&&document.querySelector('#status').textContent.includes('files saved'));}
async function erase(page){await page.locator('#homeBtn').click();await page.locator('#erase').click();await page.locator('#deleteNightConfirm').click();await page.waitForFunction(()=>!files.length&&!nights.length);}
(async()=>{
 const server=spawn('python3',['server.py'],{cwd:root});let browser;
 try{
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',code=>reject(Error('Server failed: '+code)));});
  browser=await chromium.launch({headless:true,executablePath:process.env.BPG_BROWSER_PATH||undefined,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8765');await ready(page);
  await page.locator('#files').setInputFiles(zip);await imported(page);
  assert.match(await page.locator('#status').textContent(),/4 files saved/);
  assert.deepEqual(await page.evaluate(()=>({nights:nights.length,use:nights[0].usage,apnea:count(nights[0],'apnea'),hypopnea:count(nights[0],'hypopnea')})),{nights:1,use:120/3600,apnea:2,hypopnea:1});
  await page.locator('#nightBtn').click();await page.waitForFunction(()=>document.querySelector('#stats').textContent.includes('unavailable for Philips'));
  assert.equal(await page.locator('#giNightPanel').count(),0);assert.equal(await page.getByLabel('Glasgow Index',{exact:true}).isDisabled(),true);
  assert.match(await page.locator('#nightTitle').textContent(),/Philips DreamStation 500X150/);
  assert.match(await page.locator('#settings').textContent(),/CPAP/);assert.match(await page.locator('#settings').textContent(),/9 cmH₂O/);
  assert.equal(await page.locator('[data-signal="PRS1.Flow"] canvas').count(),1);
  // An interval must still be drawn when the viewport starts after its stored onset.
  await page.locator('#window').selectOption('10');await page.locator('#next').click();
  assert.equal(await page.locator('[data-signal="PRS1.Pressure"] .value').textContent(),'');
  await page.locator('[data-signal="PRS1.Pressure"]').getByRole('button',{name:'CSV · visible range'}).click();await page.locator('#exportDialog').waitFor({state:'visible'});
  const csv=await page.evaluate(()=>exportBlob.text());assert.match(csv,/duration_seconds/);assert.match(csv,/"10"\s*$/);await page.locator('#exportClose').click();
  // Native PDF export must work with non-ResMed settings and unavailable GI.
  await page.locator('#pdf').click();await page.locator('#exportDialog').waitFor({state:'visible'});
  assert.equal(await page.evaluate(async()=>new TextDecoder().decode((await exportBlob.arrayBuffer()).slice(0,5))),'%PDF-');await page.locator('#exportClose').click();
  // Reimport is idempotent, including the UI and IndexedDB writes.
  await page.locator('#homeBtn').click();await page.locator('#files').setInputFiles(zip);await imported(page);assert.match(await page.locator('#status').textContent(),/0 files saved · 4 duplicates skipped/);
  assert.equal(await page.evaluate(()=>files.length),4);
  // Upgrade Philips raw records imported by versions without this parser.
  await page.evaluate(async()=>{for(const f of files){delete f.parsed;delete f.parserVersion;delete f.tags;delete f.device;await put('files',f);}await refresh();});
  await page.locator('#files').setInputFiles(zip);await imported(page);assert.equal(await page.evaluate(()=>nights.length),1);assert.match(await page.evaluate(()=>metadata.device),/DreamStation/);
  // Mixed-device imports are rejected before even one file is saved.
  await page.locator('#files').setInputFiles(path.join(root,'examples','PAP_SYNTHETIC_DEMO.edf'));
  await page.waitForFunction(()=>!busy&&document.querySelector('#status').textContent.includes('one PAP device'));assert.equal(await page.evaluate(()=>files.length),4);
  // Back up through the actual UI, erase, restore, reload, then verify typed samples.
  await page.locator('#backup').click();await page.locator('#exportDialog').waitFor({state:'visible'});
  const backup=await page.evaluate(()=>exportBlob.text()),saved=path.join(tmp,'backup.json');fs.writeFileSync(saved,backup);assert.match(backup,/__int8/);await page.locator('#exportClose').click();
  await erase(page);await page.locator('#restore').setInputFiles(saved);await page.waitForFunction(()=>document.querySelector('#status').textContent==='Backup restored.');await page.reload();await ready(page);
  assert.deepEqual(await page.evaluate(()=>{const s=nights[0].channels['PRS1.Flow'].segments[0];return {type:s.values.constructor.name,length:s.values.length,min:Math.min(...s.values),max:Math.max(...s.values)};}),{type:'Int8Array',length:600,min:-35,max:35});
  // Deleting the night purges parsed data and preserves the device properties.
  await page.locator('#nightBtn').click();await page.locator('#deleteNight').click();await page.locator('#deleteNightConfirm').click();await page.waitForFunction(()=>nights.length===0);await page.reload();await ready(page);assert.equal(await page.evaluate(()=>nights.length),0);
  // Reimport from a folder restores the deleted night; ZIP is not required.
  await page.locator('#folder').setInputFiles(fixture);await imported(page);assert.equal(await page.evaluate(()=>nights.length),1);
  // A bad events file leaves summary/flow usable, but AHI unavailable.
  await erase(page);const invalid=Buffer.from(eventFile());invalid[invalid.length-5]^=1;fs.writeFileSync(path.join(device,'P0','0000002A.002'),invalid);
  await page.locator('#folder').setInputFiles(fixture);await imported(page);assert.match(await page.locator('#status').textContent(),/CRC mismatch/);assert.equal(await page.evaluate(()=>count(nights[0],'apnea')),null);
  await page.locator('#nightBtn').click();assert.match(await page.locator('#summary').textContent(),/AHI unavailable/);
  assert.deepEqual(errors,[]);console.log('PASS: Philips ZIP/folder import, charts, CSV/PDF, duplicate and legacy reimport, device isolation, backup/restore/reload, deletion, corrupt data and missing AHI.');
 }finally{await browser?.close();server.kill();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
