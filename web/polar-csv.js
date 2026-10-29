// SPDX-License-Identifier: GPL-3.0-or-later
// Stream CSV records without reading an entire high-resolution recording at once.
(function(root){
'use strict';
async function* records(blob){
 const reader=blob.stream().getReader(), decoder=new TextDecoder('utf-8',{fatal:true});
 let field='',row=[],quoted=false,quotePending=false,afterCR=false,started=false,first=true;
 function feed(text){const out=[];for(const c of text){
  if(first){first=false;if(c==='\ufeff')continue;}
  if(afterCR){afterCR=false;if(c==='\n')continue;}
  if(quoted){if(quotePending){if(c==='"'){field+='"';quotePending=false;continue;}quoted=false;quotePending=false;if(c!==','&&c!=='\r'&&c!=='\n')throw Error('Unexpected character after quoted CSV field');}else if(c==='"'){quotePending=true;continue;}else{field+=c;continue;}}
  if(c==='"'){if(field!=='')throw Error('Unexpected quote in CSV field');quoted=true;started=true;}
  else if(c===','){row.push(field);field='';started=true;}
  else if(c==='\r'||c==='\n'){row.push(field);out.push(row);row=[];field='';started=false;if(c==='\r')afterCR=true;}
  else{field+=c;started=true;}
 }return out;}
 try{while(true){const {value,done}=await reader.read();if(done)break;for(const r of feed(decoder.decode(value,{stream:true})))yield r;}for(const r of feed(decoder.decode()))yield r;if(quoted&&!quotePending)throw Error('Unterminated quoted CSV field');if(started||row.length)yield [...row,field];}finally{reader.releaseLock();}
}
async function* objects(blob,required=[]){
 let header=null;
 for await(const row of records(blob)){
  if(!header){header=row;if(new Set(header).size!==header.length||required.some(k=>!header.includes(k)))throw Error('Missing or duplicate Polar CSV columns');continue;}
  if(row.length!==header.length)throw Error('Inconsistent Polar CSV column count');
  yield Object.fromEntries(header.map((k,i)=>[k,row[i]]));
 }
 if(!header)throw Error('Empty Polar CSV');
}
const api={records,objects};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PolarCSV=api;
})(globalThis);
