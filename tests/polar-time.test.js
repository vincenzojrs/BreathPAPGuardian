const test=require('node:test'),assert=require('node:assert/strict'),P=require('../web/polar-time.js');
const ns=s=>String(BigInt(Date.parse(s))*1000000n);
test('maps UTC instants to CPAP wall clock in winter and summer',()=>{
 assert.equal(P.localWallMilliseconds(ns('2026-10-29T21:32:12Z'),'Europe/Rome'),Date.UTC(2026,9,29,22,32,12));
 assert.equal(P.localWallMilliseconds(ns('2026-07-01T21:32:12Z'),'Europe/Rome'),Date.UTC(2026,6,1,23,32,12));
});
test('preserves sub-millisecond precision and uses the shift only once',()=>{
 const source=ns('2024-01-02T12:00:00Z'), offset='-19160356814', start=String(BigInt(source)+BigInt(offset));
 const data={schema_version:1,time_zone:'Europe/Rome',start_unix_ns:start,end_unix_ns:String(BigInt(start)+3600000000000n),time_shift_applied:true,time_shift_offset_ns:offset,time_shift_source_start_unix_ns:source,time_shift_target_start_unix_ns:start};
 const r=P.checkSession(data);assert.ok(Math.abs(r.start-(Date.UTC(2024,0,2,13)-19160.356814))<.001);assert.equal(r.shift.offsetNs,offset);
 assert.ok(Math.abs(P.localWallMilliseconds(String(BigInt(source)+1327602n),'Europe/Rome')-Date.UTC(2024,0,2,13)-1.327602)<.001);
 assert.throws(()=>P.checkSession({...data,time_shift_offset_ns:'-19000000000'}),/shift metadata/);
});
test('rejects malformed sessions, time zones and offsets',()=>{
 assert.throws(()=>P.checkSession({schema_version:2}),/schema/);
 assert.throws(()=>P.localWallMilliseconds('123','bogus-zone'),/time zone/);
 assert.throws(()=>P.parseNs('1.4'),/timestamp/);
});
