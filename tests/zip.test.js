const test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const I=require('../web/import-files.js'),{file,props}=require('./philips-fixtures.js');
// Independent reflected bitwise ZIP CRC implementation for synthetic fixtures.
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return (c^0xffffffff)>>>0;}
function zip(name,text,method=8){
 const data=Buffer.from(text),packed=method===8?zlib.deflateRawSync(data):data,n=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt16LE(method,8);local.writeUInt32LE(crc(data),14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt16LE(method,10);central.writeUInt32LE(crc(data),16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(n.length,28);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+n.length,12);end.writeUInt32LE(local.length+n.length+packed.length,16);
 return Buffer.concat([local,n,packed,central,n,end]);
}
test('reads stored and deflated ZIP entries locally with CRC verification',async()=>{
 for(const method of [0,8]){const bytes=zip('P-SERIES/DEVICE/PROP.TXT',props,method),entries=await I.zipEntries(file('SD.zip',bytes));assert.equal(entries.length,1);assert.equal(await entries[0].text(),props);assert.equal((await I.prepare([file('SD.zip',bytes)])).plan[0].device.serial,'SYNTHETIC-DEVICE');}
});
test('ZIP rejects traversal, truncated directory, bad CRC, unsupported compression and oversized entries',async()=>{
 await assert.rejects(()=>I.zipEntries(file('SD.zip',zip('../PROP.TXT',props))),/Unsafe/);
 const b=zip('PROP.TXT',props,0);await assert.rejects(()=>I.zipEntries(file('SD.zip',b.subarray(0,-1))),/end of directory/);
 const bad=Buffer.from(b);bad[30+'PROP.TXT'.length]^=1;const [entry]=await I.zipEntries(file('SD.zip',bad));await assert.rejects(()=>entry.arrayBuffer(),/CRC/);
 await assert.rejects(()=>I.zipEntries(file('SD.zip',zip('PROP.TXT',props,99))),/unsupported compression/);
 const large=Buffer.from(b),central=large.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));large.writeUInt32LE(129*1024**2,central+24);await assert.rejects(()=>I.zipEntries(file('SD.zip',large)),/limit/);
});
test('ZIP ignores macOS resource forks and retains DreamStation 2 entries',async()=>{
 assert.equal((await I.zipEntries(file('SD.zip',zip('__MACOSX/._PROP.TXT','metadata')))).length,0);
 assert.equal((await I.zipEntries(file('SD.zip',zip('P-SERIES/DEVICE/PROP.BIN','encrypted')))).length,1);
});
module.exports={zip};
