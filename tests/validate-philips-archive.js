// Local opt-in validation: node tests/validate-philips-archive.js /private/P-SERIES.zip
// Never stores recordings or device identifiers in the repository.
const fs=require('node:fs'),assert=require('node:assert/strict');
const P=require('../web/philips.js'),I=require('../web/import-files.js'),C=require('../web/core.js');
(async()=>{
 const path=process.argv[2];if(!path)throw Error('Provide a private ZIP path');
 const zip=new Blob([fs.readFileSync(path)]);zip.name='P-SERIES.zip';
 const {plan}=await I.prepare([zip]),files=[],errors=[],counts={};let samples=0,sessions=0;
 for(const {file,device} of plan){
  try{
   if(P.isData(file.name)){
    const parsed=P.parse(await file.arrayBuffer(),file.name);counts[file.name.split('.').at(-1)]=(counts[file.name.split('.').at(-1)]||0)+1;
    sessions+=parsed.sessions.length;samples+=parsed.signals.filter(s=>s.label==='PRS1.Flow').reduce((a,s)=>a+s.values.length,0);
    files.push({name:file.name,parsed,imported:0});
   }else files.push({tags:device.tags,imported:0});
  }catch(e){errors.push({extension:file.name.split('.').at(-1),error:e.message});}
 }
 const {nights}=C.buildNights(files);
 assert(nights.length>0);assert(nights.some(n=>n.hasTherapySummary));
 for(const n of nights){assert(Number.isFinite(n.usage)&&n.usage>=0&&n.usage<=24);for(const ch of Object.values(n.channels))for(const s of ch.segments)assert(s.dt>0&&s.values.length>0);}
 console.log(JSON.stringify({parsedFiles:counts,sessions,samples,nights:nights.length,summaryOnly:nights.filter(n=>!Object.keys(n.channels).length).length,withFlow:nights.filter(n=>n.channels['PRS1.Flow']).length,withSummary:nights.filter(n=>n.hasTherapySummary).length,completeEvents:nights.filter(n=>n.eventsComplete).length,errors},null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
