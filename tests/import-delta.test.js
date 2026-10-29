// SPDX-License-Identifier: GPL-3.0-or-later
const {test}=require('node:test'),assert=require('node:assert/strict');
const delta=require('../web/import-delta.js');
test('SD root renames do not duplicate a logical file, changed content replaces old versions',()=>{
 const files=[{id:'old',path:'SD-A/DATALOG/20240101/night.edf',name:'night.edf'}];
 assert.equal(delta.plan(files,{id:'old',path:'SD-B/DATALOG/20240101/night.edf',name:'night.edf'}).unchanged,true);
 assert.deepEqual(delta.plan(files,{id:'new',path:'SD-B/DATALOG/20240101/night.edf',name:'night.edf'}).remove,['old']);
 assert.deepEqual(delta.plan(files,{id:'new-segment',path:'SD-B/DATALOG/20240101/other.edf',name:'other.edf'}).remove,[]);
});
test('persistent deletions hide nights even when original multi-night recordings are reimported',()=>{
 assert.deepEqual(delta.visible([{key:'2024-01-01'},{key:'2024-01-02'}],[{id:'2024-01-01'}]),[{key:'2024-01-02'}]);
});
test('annotations in an updated recording gap require review',()=>{
 const night={intervals:[[0,10],[20,30]],origin:0,end:30};
 assert.equal(delta.markerOutside({time:15},night),true);assert.equal(delta.markerOutside({time:25},night),false);
});
