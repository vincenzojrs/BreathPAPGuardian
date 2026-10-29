// SPDX-License-Identifier: GPL-3.0-or-later
const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../web/dreamstation2.js'),P=require('../web/philips.js'),I=require('../web/import-files.js'),C=require('../web/core.js');
const {envelope}=require('./dreamstation2-fixtures.js'),F=require('./philips-fixtures.js');
const props=F.props.replace('500X150','520X150C');
test('DS2 decrypts independent OpenSSL envelopes, multiple keys and cached envelopes',async()=>{
 const d=D.createDecoder();for(const seed of [1,2,1]){const plain=Buffer.from('Synthetic patient-owned data '+seed);assert.deepEqual(Buffer.from(await d.decrypt(envelope(plain,seed))),plain);}
});
test('DS2 rejects truncation, unsupported envelope, wrong keys and modified payloads/tags',async()=>{
 const d=D.createDecoder(),b=envelope(F.summary());
 for(const length of [0,5,30,201,202])await assert.rejects(()=>d.decrypt(b.subarray(0,length)),/DreamStation 2/);
 for(const offset of [0,50,70,150,190,b.length-1]){const bad=Buffer.from(b);bad[offset]^=1;await assert.rejects(()=>d.decrypt(bad),/DreamStation 2/);}
 const zero=Buffer.from(b);zero.fill(0,186,202);await assert.rejects(()=>d.decrypt(zero),/authentication failed/);
});
test('DS2 auto-detection decodes properties and all therapy formats into existing nights',async()=>{
 const input=[F.file('PROP.BIN',envelope(props),'P-SERIES/TEST/PROP.BIN'),...[[1,F.summary({on:0,use:120})],[2,F.eventFile()],[5,F.chunk(5)]].map(([ext,bytes])=>F.file('0000002A.B0'+ext,envelope(bytes),'P-SERIES/TEST/P0/0000002A.B0'+ext))];
 const {plan}=await I.prepare(input),records=[];
 for(const item of plan){assert.equal(item.device.generation,2);if(P.isData(item.file.name))records.push({parsed:P.parse(await item.decode(await item.file.arrayBuffer()),item.file.name),imported:0});else records.push({tags:item.device.tags,imported:0});}
 const result=C.buildNights(records),n=result.nights[0];assert.match(result.device,/DreamStation 2 520X150C/);assert.equal(n.settings.Mode,'CPAP');assert.equal(n.eventsComplete,true);assert.equal(n.usage,120/3600);assert.equal(n.channels['PRS1.Flow'].segments[0].dt,.2);
});
test('DS2 rejects mismatched cleartext/encrypted data and second-device imports',async()=>{
 await assert.rejects(()=>I.prepare([F.file('PROP.TXT',F.props),F.file('0000002A.B01',envelope(F.summary()))]),/does not match/);
 await assert.rejects(()=>I.prepare([F.file('PROP.BIN',envelope(props)),F.file('0000002A.001',F.summary())]),/does not match/);
 await assert.rejects(()=>I.prepare([F.file('PROP.BIN',envelope(props))],[{tags:{SRN:'OTHER'}}]),/one PAP device/);
});
