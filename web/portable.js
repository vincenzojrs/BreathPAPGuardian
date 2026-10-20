// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const Portable={
 token:'',state:null,writable:false,closed:false,timer:null,poll:null,saving:null,analysisBusy:false,writing:0,
 async api(path,body){
  const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'X-BPG-Local':'1','X-BPG-Session':this.token,...(body!==undefined&&!(body instanceof Blob)?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:body instanceof Blob?body:JSON.stringify(body)});
  let result;try{result=await response.json();}catch{throw Error('Local archive server unavailable. Local work is preserved.');}
  if(!response.ok)throw Error(result.error||'Archive operation failed.');
  if(path==='batch'){this.state=result;this.changed();}
  return result;
 },
 assertWrite(allowPending=false){if(!this.writable||this.closed||this.state?.preview||this.state?.conflict||this.state?.pending&&!(allowPending&&this.state.pending==='import'))throw Error('Read-only archive. Confirm synchronization, resolve conflicts, or finish the interrupted operation.');},
 async init(){
  const result=await this.api('session/start',{});this.token=result.token;this.state=result.status;
  const box=document.getElementById('archivePanel');box.hidden=false;
  document.getElementById('storageLabel').textContent='Portable archive · local work + Proton Drive';
  document.getElementById('storageHint').textContent='SD imports add new or changed files. Edits publish automatically; wait for Proton Drive synchronization before switching computers.';
  document.getElementById('portableControls').hidden=true;
  this.bind();this.render();
  this.poll=setInterval(()=>this.check().catch(e=>this.error(e)),5000);
  window.addEventListener('beforeunload',e=>{if(this.writing||this.state?.dirty||this.state?.operation||this.state?.pending||this.saving||this.formDirty()){e.preventDefault();e.returnValue='';}});
  window.addEventListener('pagehide',()=>{if(this.writable&&!this.closed)fetch('/api/session/leave',{method:'POST',headers:{'X-BPG-Local':'1','X-BPG-Session':this.token,'Content-Type':'application/json'},body:'{}',keepalive:true}).catch(()=>{});});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&this.writable&&!busy)this.flush().catch(e=>this.error(e));});
 },
 formDirty(){const d=document.getElementById('markerDialog');return d?.open&&this.markerDirty;},
 error(e){document.getElementById('archiveMessage').textContent=e.message||String(e);},
 changed(){this.render();clearTimeout(this.timer);if(!this.state.operation&&!this.state.preview&&!this.state.pending&&!this.analysisBusy)this.timer=setTimeout(()=>this.flush().catch(e=>this.error(e)),800);},
 async check(){
  if(this.closed||this.saving||this.writing||busy)return;
  const s=await this.api('status');this.state=s;this.render();
  if(!s.dirty&&!s.operation&&!s.pending&&!s.preview&&s.base!==s.latest&&s.latest){
   // A new publication invalidates the previous synchronization confirmation.
   this.writable=false;await this.api('open-shared',{});await refresh();this.state=await this.api('status');this.render();
  }
 },
 async flush(){
  clearTimeout(this.timer);
  if(this.saving)return this.saving;
  if(!this.writable||this.closed||this.analysisBusy||this.writing||this.state?.operation||this.state?.pending||this.state?.preview)return;
  this.saving=(async()=>{try{this.state=await this.api('publish',{});document.getElementById('archiveMessage').textContent='Saved in the Proton Drive folder. Check Proton Drive upload completion before switching computers.';return this.state;}catch(e){this.state=await this.api('status').catch(()=>this.state);this.error(e);throw e;}finally{this.saving=null;this.render();}})();
  return this.saving;
 },
 async begin(kind){this.assertWrite(kind==='import');if(this.saving)await this.saving;clearTimeout(this.timer);this.state=await this.api('operation/begin',{kind});this.render();},
 async finish(){this.state=await this.api('operation/end',{});this.render();if(!this.state.preview)await this.flush();},
 async pause(){this.state=await this.api('operation/pause',{});this.render();},
 async saveClose(){
  this.assertWrite();if(busy)throw Error('Wait for the current operation to finish.');
  if(this.formDirty())throw Error('Save or cancel the open marker form first.');
  while(this.analysisBusy||this.writing)await new Promise(r=>setTimeout(r,100));
  if(this.saving)await this.saving;
  this.state=await this.api('session/close',{});this.closed=true;this.writable=false;clearInterval(this.poll);clearTimeout(this.timer);this.render();
  document.getElementById('archiveMessage').textContent='Saved. Wait for Proton Drive upload completion. You can now close this tab.';
  window.close();
 },
 render(){
  const s=this.state;if(!s)return;const byId=id=>document.getElementById(id);
  byId('archiveMode').textContent=this.closed?'Session closed':s.preview?'Recovery preview · read only':this.writable?'Portable archive · editing enabled':'Portable archive · read only';
  const date=s.created?new Date(Number(s.created)*1000).toLocaleString():'not published';
  byId('archiveVersion').textContent=`Archive ${s.archive} · local ${s.base||'new'} · shared ${s.latest||'none'} · published ${date}`;
  byId('archivePaths').textContent=`Working folder: ${s.local}\nProton Drive folder: ${s.shared}`;
  byId('archiveSaveState').textContent=this.saving?'Publishing…':s.operation?'Import/restore in progress · not published':s.pending?'Interrupted operation preserved':s.dirty?'Local changes awaiting publication':'Saved locally · cloud sync must be checked in Proton Drive';
  byId('confirmSync').hidden=this.writable||this.closed;byId('saveClose').disabled=!this.writable||this.closed;
  byId('archiveConflict').hidden=!s.conflict;byId('pendingControls').hidden=!s.pending;
  byId('acceptRestore').hidden=!s.preview||s.pending!=='restore'||!s.complete;byId('allowReimport').disabled=!this.writable||s.preview;
  if(s.error)byId('archiveMessage').textContent=s.error;
  for(const id of ['files','folder','restore','erase','addMarker','deleteNight','migratePortable']){const e=byId(id);if(e)e.disabled=!this.writable||s.preview||this.closed||s.conflict||!!s.pending&&!(s.pending==='import'&&['files','folder'].includes(id));}
 },
 async busyAction(fn){if(busy)throw Error('An operation is already running.');busy=true;try{await fn();}finally{busy=false;this.render();}},
 bind(){
  const on=(id,fn)=>{document.getElementById(id).onclick=()=>Promise.resolve().then(fn).catch(e=>this.error(e));};
  on('confirmSync',async()=>{this.state=await this.api('session/confirm',{});this.writable=true;await refresh();this.render();if(this.state.dirty&&!this.state.conflict&&!this.state.pending)await this.flush();});
  on('saveClose',()=>this.saveClose());
  on('recoverSession',async()=>{if(!confirm('Close any other BreathPAPGuardian tab first. Recover this browser session? Pending work is preserved.'))return;this.state=await this.api('session/recover',{});this.writable=true;this.render();});
  on('retryArchive',async()=>{await this.check();document.getElementById('archiveMessage').textContent='Archive status refreshed.';});
  for(const choice of ['local','shared'])on('resolve'+choice,()=>this.busyAction(async()=>{if(!confirm(`Use the ${choice} copy? The current local copy is preserved in Local recovery copies; shared history is retained.`))return;this.state=await this.api('resolve',{choice});await refresh();if(choice==='local')await this.flush();this.render();}));
  on('previewPending',async()=>{this.state=await this.api('operation/preview',{});await refresh();this.render();});
  on('discardPending',async()=>{if(!confirm('Return to the previous archive? The interrupted operation will be kept as a local recovery copy.'))return;this.state=await this.api('operation/discard',{});await refresh();this.render();});
  on('acceptRestore',async()=>{if(!confirm('Replace the active archive with this complete restored copy and publish it? The previous copy is retained.'))return;this.state=await this.api('operation/accept',{});await refresh();this.render();await this.flush();status('Restored archive activated. Automatic publication is enabled.');});
  on('allowReimport',async()=>{this.assertWrite();const deleted=await getAll('tombstones');const host=document.getElementById('deletedNights');host.replaceChildren();for(const row of deleted){const b=document.createElement('button');b.textContent='Allow reimport · '+row.id;b.onclick=async()=>{try{await del('tombstones',row.id);await refresh();await this.flush();b.remove();}catch(e){this.error(e);}};host.append(b);}if(!deleted.length)host.textContent='No nights blocked from reimport.';});
  on('loadVersions',()=>this.loadHistory());
  on('restoreVersion',()=>this.busyAction(async()=>{this.assertWrite();const id=document.getElementById('versionSelect').value;if(!id||!confirm('Restore this published version? It will become a new publication; current history is retained.'))return;await this.flush();this.state=await this.api('restore-version',{id});await refresh();await this.flush();await this.loadHistory();}));
  on('protectVersion',async()=>{this.assertWrite();const e=document.getElementById('versionSelect'),option=e.selectedOptions[0];if(!option)return;await this.api('protect',{id:e.value,enabled:option.dataset.protected!=='true'});await this.loadHistory();});
  on('cleanVersion',async()=>{this.assertWrite();await this.flush();const versions=[document.getElementById('versionSelect').value];const plan=await this.api('cleanup',{versions});if(!confirm(`Delete ${plan.versions} historical version(s) and ${plan.files} files (${(plan.bytes/1048576).toFixed(2)} MB)? Referenced contents and contents under 7 days old are retained. External backups and other Macs are not erased.`))return;await this.api('cleanup',{versions,execute:true,token:plan.token});await this.loadHistory();});
  on('restoreRecovery',async()=>{this.assertWrite();const id=document.getElementById('recoverySelect').value;if(!id)return;this.state=await this.api('restore-recovery',{id});await refresh();this.render();});
  document.getElementById('markerForm').addEventListener('input',()=>{this.markerDirty=true;});
  document.getElementById('markerDialog').addEventListener('close',()=>{this.markerDirty=false;});
 },
 async hash(text){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');},
 async backup(){
  if(busy||this.writing)throw Error('Wait for the current operation to finish.');
  status('Preparing a complete, independent backup…');
  const data={};for(const store of ['files','markers','external','tombstones','analysis','preferences'])data[store]=await encode(await getAll(store));
  const backup={format:'bpg-backup-v3',schema:3,archiveSchema:2,created:new Date().toISOString(),data,sha256:await this.hash(JSON.stringify(data))};
  download(new Blob([JSON.stringify(backup)],{type:'application/json'}),'bpg-backup-'+Date.now()+'.json');
  status('Complete backup ready. It contains recordings and media without application encryption; store it on an encrypted independent device.');
 },
 async restoreBackup(file){
  this.assertWrite();if(busy)throw Error('Wait for the current operation.');
  const input=JSON.parse(await file.text());let data;
  if(input.format==='bpg-backup-v3'){
   if(input.schema!==3||input.archiveSchema!==2)throw Error('Unsupported backup format. Update the app.');
   if(await this.hash(JSON.stringify(input.data))!==input.sha256)throw Error('Backup checksum failed. Current archive was preserved.');data=decode(input.data);
  }else if(input.format==='pap-local-v2')data=decode(input);
  else throw Error('Unrecognized backup.');
  const stores=['files','markers','external','tombstones','analysis','preferences'];
  for(const s of stores){if(data[s]===undefined&&['tombstones','analysis','preferences'].includes(s))data[s]=[];if(!Array.isArray(data[s])||data[s].some(x=>!x||typeof x.id!=='string'))throw Error('Invalid backup records.');if(new Set(data[s].map(x=>x.id)).size!==data[s].length)throw Error('Duplicate record IDs in backup.');}
  if(!confirm('Restore into a new local preview archive? The active archive is kept. Nothing is published until you choose Use restored archive.'))return;
  busy=true;let started=false;
  try{
   await this.begin('restore');started=true;
   for(const s of stores)for(const item of data[s]){status('Restoring '+s+'…');await api('batch',{put:[[s,await portableEncode(item)]]});}
   const counts=await api('status');for(const s of stores)if(counts.counts[s]!==data[s].length)throw Error('Restored record count mismatch.');
   await this.finish();started=false;await refresh();status('Restored archive preview. Inspect it, export a backup, or choose Use restored archive to replace and publish.');
  }catch(e){if(started)await this.pause();throw e;}finally{busy=false;this.render();}
 },
 async loadHistory(){
  const versions=await this.api('versions'),select=document.getElementById('versionSelect');select.replaceChildren();
  for(const v of versions){const o=document.createElement('option');o.value=v.id;o.dataset.protected=String(v.protected);o.textContent=`${new Date(v.created*1000).toLocaleString()} · ${v.id.slice(0,10)}${v.current?' · current':''}${v.protected?' · protected':''}`;select.append(o);}
  const recoveries=await this.api('recoveries'),r=document.getElementById('recoverySelect');r.replaceChildren();
  for(const v of recoveries){const o=document.createElement('option');o.value=v.id;o.textContent=new Date(v.created*1000).toLocaleString()+' · '+v.id;r.append(o);}
 }
};
