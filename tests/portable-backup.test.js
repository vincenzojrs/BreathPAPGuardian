const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync(require.resolve('../web/portable.js'),'utf8');
test('ZIP backup larger than the legacy JSON limit uses the block restore path',async()=>{
 const context={Uint8Array,busy:false};
 vm.createContext(context);
 vm.runInContext(source+'\nglobalThis.portable=Portable;',context);
 let selected;
 context.portable.assertWrite=()=>{};
 context.portable.restoreZip=async file=>{selected=file;};
 const file={
  size:1024**3,
  slice:(start,end)=>{assert.equal(start,0);assert.equal(end,4);return {arrayBuffer:async()=>Uint8Array.from([0x50,0x4b,3,4]).buffer};},
  text:()=>{throw Error('A ZIP backup must never be read as one JSON string');}
 };
 await context.portable.restoreBackup(file);
 assert.equal(selected,file);
});
