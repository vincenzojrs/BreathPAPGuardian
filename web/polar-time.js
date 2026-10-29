// SPDX-License-Identifier: GPL-3.0-or-later
// Polar timestamps describe UTC instants; PAP timestamps are device wall-clock values.
(function(root){
'use strict';
function parseNs(value){
 if(typeof value!=='string'||! /^-?\d+$/.test(value))throw Error('Invalid nanosecond timestamp');
 return BigInt(value);
}
function localWallMilliseconds(ns, zone){
 const n=parseNs(ns), ms=Number(n/1000000n), fraction=Number(n%1000000n)/1e6;
 if(!Number.isFinite(ms))throw Error('Invalid timestamp');
 let formatter;
 try{formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});}catch{throw Error('Invalid time zone');}
 const p=Object.fromEntries(formatter.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));
 const wall=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)+((ms%1000)+1000)%1000+fraction;
 return wall;
}
function shiftInfo(session){
 const shifted=session.time_shift_applied===true;
 if(!shifted)return {applied:false,offsetNs:'0',originalStartNs:String(session.start_unix_ns)};
 const offset=parseNs(session.time_shift_offset_ns),source=parseNs(session.time_shift_source_start_unix_ns),target=parseNs(session.time_shift_target_start_unix_ns);
 if(source+offset!==target||parseNs(session.start_unix_ns)!==target)throw Error('Inconsistent shift metadata');
 return {applied:true,offsetNs:offset.toString(),originalStartNs:source.toString()};
}
function checkSession(session, deviceZone){
 if(!session||session.schema_version!==1)throw Error('Unsupported PolarPAP session schema');
 parseNs(session.start_unix_ns);parseNs(session.end_unix_ns);
 if(parseNs(session.end_unix_ns)<=parseNs(session.start_unix_ns))throw Error('Invalid recording interval');
 const zone=deviceZone||session.time_zone;if(typeof zone!=='string'||!zone)throw Error('PAP time zone missing');
 localWallMilliseconds(session.start_unix_ns,zone);
 return {zone,shift:shiftInfo(session),start:localWallMilliseconds(session.start_unix_ns,zone),end:localWallMilliseconds(session.end_unix_ns,zone)};
}
const api={parseNs,localWallMilliseconds,shiftInfo,checkSession};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PolarTime=api;
})(globalThis);
