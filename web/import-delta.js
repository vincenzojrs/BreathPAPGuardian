// SPDX-License-Identifier: GPL-3.0-or-later
(function(root){
'use strict';
function logicalPath(path,name){const parts=String(path||name).replaceAll('\\','/').split('/').filter(Boolean),anchor=parts.findIndex(p=>/^(DATALOG|SETTINGS|P-SERIES)$/i.test(p));return (anchor>=0?parts.slice(anchor).join('/'):parts.at(-1)||name).toUpperCase();}
function plan(existing,record){
 const logical=record.logicalPath||logicalPath(record.path,record.name);
 const matching=existing.filter(f=>(f.logicalPath||logicalPath(f.path,f.name))===logical);
 return {logical,unchanged:matching.some(f=>f.id===record.id),remove:matching.filter(f=>f.id!==record.id).map(f=>f.id)};
}
function visible(nights,tombstones){const removed=new Set(tombstones.map(t=>t.id));return nights.filter(n=>!removed.has(n.key));}
function markerOutside(marker,night){return night.intervals.length?!night.intervals.some(([start,end])=>marker.time>=start&&marker.time<=end):marker.time<night.origin||marker.time>night.end;}
const api={logicalPath,plan,visible,markerOutside};if(typeof module!=='undefined')module.exports=api;else root.ImportDelta=api;
})(globalThis);
