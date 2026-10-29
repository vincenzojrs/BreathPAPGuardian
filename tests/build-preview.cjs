// SPDX-License-Identifier: GPL-3.0-or-later
// Build an offline, synthetic-only preview from the real application sources.
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
let html=read('web/index.html');
html=html.replace('<link rel="stylesheet" href="style.css">','<style>'+read('web/style.css')+'</style>');
const worker=read('web/vendor/glasgow-reference.js')+'\n'+read('web/glasgow.js')+'\n'+read('web/glasgow-worker.js').replace(/importScripts\([^;]+;/,'');
const workerSetup='const previewWorkerURL=URL.createObjectURL(new Blob(['+JSON.stringify(worker)+'],{type:"text/javascript"}));';
html=html.replace(/<script src="([^"]+)"><\/script>/g,(_,file)=>{
 let code=read('web/'+file);
 if(file==='app.js')code=code.replace("indexedDB.open('pap-local-v2',1)","indexedDB.open('bpg-synthetic-preview-v2',1)");
 if(file==='glasgow-ui.js')code=workerSetup+'\n'+code.replace("new Worker('glasgow-worker.js')","new Worker(previewWorkerURL)");
 return '<script>'+code.replace(/<\/script/gi,'<\\/script')+'</script>';
});
const seed=`
async function loadPreview(){
 while(!db)await new Promise(r=>setTimeout(r,25));
 if(files.length)return;
 for(let day=0;day<8;day++){
  const start=Date.UTC(2024,0,day+1,22),seconds=900+day*120;
  const signal=(label,unit,dt,fn)=>({label,unit,dt,start,name:'SYNTHETIC',values:Float64Array.from({length:seconds/dt},(_,i)=>fn(i*dt))});
  const signals=[signal('Flow.40ms','L/s',.04,t=>{const v=Math.sin(2*Math.PI*t/4.2),flat=(Math.floor(t/90)+day)%5<day%4;return v>=0?(flat?Math.min(.32,.65*v):.43*v*(1+.12*Math.sin(t/9))):.43*v;}),signal('Press.2s','cmH2O',2,t=>7+day*.18+.6*Math.sin(t/90)),signal('EprPress.2s','cmH2O',2,t=>4.5+.15*Math.sin(t/90)),signal('Leak.2s','L/min',2,t=>3+day*.6+2*Math.sin(t/70)),signal('FlowLim.2s','',2,t=>Math.max(0,.1+.05*day+.12*Math.sin(t/80)))];
  const parsed={name:'SYNTHETIC_'+day,start,duration:seconds,recordDuration:1,records:seconds,summary:false,signals,events:[]};
  await put('files',{id:'preview-'+day,name:'SYNTHETIC_'+day+'.edf',path:'SYNTHETIC_'+day+'.edf',parsed,blob:new Blob(['Synthetic preview fixture — no patient data']),derived:true});
 }
 await refresh();status('Synthetic preview · 8 generated nights · no patient data.');
}
loadPreview().catch(e=>status('Preview: '+e.message));
`;
html=html.replace('</body>','<script>'+seed+'</script></body>');
html=html.replace('<main>','<main><p class="preview-notice">INTERACTIVE PREVIEW · Synthetic data only · Changes stay in this preview’s separate browser archive.</p>');
fs.mkdirSync(path.join(root,'docs'),{recursive:true});fs.writeFileSync(path.join(root,'docs/glasgow-preview.html'),html);
console.log('Built docs/glasgow-preview.html');
