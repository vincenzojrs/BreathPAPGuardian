const test=require('node:test'),assert=require('node:assert/strict'),P=require('../web/polar-csv.js');
async function all(iter){const out=[];for await(const x of iter)out.push(x);return out;}
test('streaming CSV preserves quotes, Unicode, newlines and fields',async()=>{
 const b=new Blob(['\ufefftime,detail\r\n1,"heart,',' λ and ""quoted""\nvalue"\r\n2,ok']);
 assert.deepEqual(await all(P.objects(b,['time','detail'])),[{time:'1',detail:'heart, λ and "quoted"\nvalue'},{time:'2',detail:'ok'}]);
});
test('fails closed for malformed rows and schema',async()=>{
 await assert.rejects(()=>all(P.objects(new Blob(['a,b\n1']),['a','b'])),/column count/);
 await assert.rejects(()=>all(P.objects(new Blob(['a,a\n1,2']))),/duplicate/);
 await assert.rejects(()=>all(P.objects(new Blob(['a\n"unfinished']))),/Unterminated/);
 await assert.rejects(()=>all(P.objects(new Blob(['a\n"bad"x']))),/Unexpected/);
});
